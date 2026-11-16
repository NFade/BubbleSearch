import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BundleResult, BundleSignal, BundleWallet, GroupResult } from '../../shared/types.ts';
import { AddrInput } from './AddrInput.tsx';
import { bundle as runBundle, group as runGroup, type JobHandle } from './api.ts';
import { Elapsed, Legend, useNarrow } from './common.tsx';
import { Drawer } from './Drawer.tsx';
import { download, stamp, toCsv } from './exportData.ts';
import { GraphView } from './GraphView.tsx';
import { GroupPanel } from './GroupPanel.tsx';
import { AddrChip, CopyButton } from './ui.tsx';
import { computeHighlight, fmtDuration, fmtSol, fmtTime, isValidAddress, plural, scoreColor, shortAddr, type Selection } from './util.ts';

const MAX_MAP = 15; // цель + выбранные
const DEFAULT_SCORE = 0.6;

const SIGNAL_RU: Record<BundleSignal, string> = {
  'same-tx': 'одна транзакция',
  'same-slot': 'тот же слот',
  near: '≤30 с',
  window: 'в окне',
  'co-sell': 'продажи вместе',
  transfers: 'переводы',
  'common-funder': 'общий источник',
  'funded-by-target': 'пополнение',
  overlap: 'те же токены',
  copytrader: 'копитрейдер?',
};
const STRONG: BundleSignal[] = ['same-tx', 'same-slot', 'common-funder', 'funded-by-target'];

const WINDOW_HINT = 'Чем шире окно, тем больше переводов пула читать: дольше и больше случайных совпадений.';
const EXPAND_HINT = 'Дольше, +300–1500 кредитов: проверяет первые пополнения и собственные покупки сильных кандидатов (отличает бандл от копитрейдеров) и делает второй круг по токенам сильных кошельков.';

type Phase =
  | { status: 'idle' }
  | { status: 'running'; what: 'bundle' | 'map'; progress: string[]; startedAt: number }
  | { status: 'error'; what: 'bundle' | 'map'; message: string; progress: string[]; retry: () => void };

interface Props {
  /** Открыть обычный поиск связей по кошельку. */
  onSearch: (address: string, label?: string) => void;
  /** Вкладка сейчас видна (скрытая остаётся смонтированной). */
  active: boolean;
}

const solscanAccount = (a: string) => `https://solscan.io/account/${a}`;
const solscanToken = (m: string) => `https://solscan.io/token/${m}`;
const solscanTxUrl = (s: string) => `https://solscan.io/tx/${s}`;
const fmtN = (n: number) => Math.round(n).toLocaleString('ru-RU');
/** Смещение относительно сделки цели: «+12 с», «−1 мин 30 с». */
function fmtDt(sec: number | null): string {
  if (sec == null) return '—';
  const sign = sec < 0 ? '−' : '+';
  const a = Math.abs(Math.round(sec));
  if (a < 60) return `${sign}${a} с`;
  const m = Math.floor(a / 60);
  const r = a % 60;
  return `${sign}${m} мин${r ? ` ${r} с` : ''}`;
}

function csvOf(r: BundleResult): string {
  const rows: (string | number | null)[][] = [['Адрес', 'Оценка, %', 'Токенов', 'Признаки', 'Имя из списка', 'Через', 'Копитрейдер?']];
  for (const w of r.wallets) {
    rows.push([w.address, Math.round(w.score * 100), w.tokensMatched, w.signals.map((s) => SIGNAL_RU[s]).join(', '), w.tracked?.name ?? '', w.via ?? '', w.copytrader ? 'да' : '']);
  }
  return toCsv(rows);
}

/** Подставляет имена из списка в узлы карты (сервер может отдать только адрес). */
function decorate(g: GroupResult, r: BundleResult): GroupResult {
  const known = new Map<string, NonNullable<BundleWallet['tracked']>>();
  if (r.targetTracked) known.set(r.target, r.targetTracked);
  for (const w of r.wallets) if (w.tracked) known.set(w.address, w.tracked);
  return {
    ...g,
    nodes: g.nodes.map((n) => {
      const t = known.get(n.id);
      if (!t || (n.kind !== 'target' && n.kind !== 'tracked')) return n;
      return { ...n, label: n.label ?? t.name, emoji: n.emoji ?? (t.emoji || undefined), entity: n.entity ?? t.entity, entityName: n.entityName ?? t.entityName, groups: n.groups ?? t.groups };
    }),
  };
}

export function BundleTab({ onSearch, active }: Props) {
  const narrow = useNarrow();
  const [address, setAddress] = useState('');
  const [tokens, setTokens] = useState(10);
  const [windowMin, setWindowMin] = useState<1 | 3 | 5 | 10 | 30>(5);
  const [sells, setSells] = useState(true);
  const [expand, setExpand] = useState(false);

  const [phase, setPhase] = useState<Phase>({ status: 'idle' });
  const [result, setResult] = useState<BundleResult | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [tokensOpen, setTokensOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);

  const [map, setMap] = useState<GroupResult | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [mobileTab, setMobileTab] = useState<'map' | 'list'>('map');
  const [resetKey, setResetKey] = useState(0);

  const handle = useRef<JobHandle<unknown> | null>(null);
  const runId = useRef(0);
  const noticeTimer = useRef(0);
  useEffect(
    () => () => {
      handle.current?.cancel();
      window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  const valid = isValidAddress(address.trim());
  const running = phase.status === 'running';
  const units = tokens * (sells ? 2 : 1);
  const creditsMin = units * 10;
  const creditsMax = units * 200;

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4500);
  }, []);

  // ----- поиск бандла -----
  const start = useCallback(() => {
    const addr = address.trim();
    if (!isValidAddress(addr)) return;
    handle.current?.cancel();
    const id = ++runId.current;
    setPhase({ status: 'running', what: 'bundle', progress: [], startedAt: Date.now() });
    const h = runBundle({ address: addr, tokens, windowMin, sells, expand }, (lines) => {
      if (runId.current !== id) return;
      setPhase((p) => (p.status === 'running' ? { ...p, progress: lines } : p));
    });
    handle.current = h;
    h.promise
      .then((r) => {
        if (runId.current !== id) return;
        setResult(r);
        setMap(null);
        setOpenRow(null);
        setSelected(new Set(r.wallets.filter((w) => w.score >= DEFAULT_SCORE).slice(0, MAX_MAP - 1).map((w) => w.address)));
        setPhase({ status: 'idle' });
      })
      .catch((e) => {
        if (runId.current !== id) return;
        setPhase((p) => ({ status: 'error', what: 'bundle', message: e instanceof Error ? e.message : String(e), progress: p.status === 'running' ? p.progress : [], retry: start }));
      });
  }, [address, tokens, windowMin, sells, expand]);

  // ----- карта цели и выбранных кошельков -----
  const showMap = useCallback(() => {
    if (!result) return;
    const addresses = [result.target, ...result.wallets.filter((w) => selected.has(w.address)).map((w) => w.address)];
    handle.current?.cancel();
    const id = ++runId.current;
    setSelection(null);
    setMobileTab('map');
    setPhase({ status: 'running', what: 'map', progress: [], startedAt: Date.now() });
    const h = runGroup({ addresses, deep: false }, (lines) => {
      if (runId.current !== id) return;
      setPhase((p) => (p.status === 'running' ? { ...p, progress: lines } : p));
    });
    handle.current = h;
    h.promise
      .then((g) => {
        if (runId.current !== id) return;
        setMap(decorate(g, result));
        setPhase({ status: 'idle' });
        setResetKey((k) => k + 1);
      })
      .catch((e) => {
        if (runId.current !== id) return;
        setPhase((p) => ({ status: 'error', what: 'map', message: e instanceof Error ? e.message : String(e), progress: p.status === 'running' ? p.progress : [], retry: showMap }));
      });
  }, [result, selected]);

  const toggle = useCallback(
    (a: string) => {
      setSelected((cur) => {
        const n = new Set(cur);
        if (n.has(a)) n.delete(a);
        else if (n.size >= MAX_MAP - 1) {
          flash(`На карту можно взять не больше ${MAX_MAP} кошельков вместе с целью.`);
          return cur;
        } else n.add(a);
        return n;
      });
    },
    [flash],
  );

  const cancel = () => {
    handle.current?.cancel();
    runId.current++;
    setPhase({ status: 'idle' });
  };

  // ----- карта: подсветка и выбор -----
  const highlight = useMemo(() => computeHighlight(map, selection), [map, selection]);
  const onSelectNode = useCallback((id: string) => setSelection({ kind: 'node', id }), []);
  const onSelectEdge = useCallback((id: string) => setSelection({ kind: 'edge', id }), []);
  const onClear = useCallback(() => setSelection(null), []);
  const selectFromPanel = (sel: Selection) => {
    setSelection(sel);
    if (sel && narrow) {
      setMobileTab('map');
      setResetKey((k) => k + 1);
    }
  };
  const switchMobile = (t: 'map' | 'list') => {
    setMobileTab(t);
    if (t === 'map') setResetKey((k) => k + 1);
  };

  const exportCsv = () => {
    if (!result) return;
    download(`bubblesearch-bundle-${result.target.slice(0, 4)}-${result.target.slice(-4)}-${stamp()}.csv`, 'text/csv;charset=utf-8', csvOf(result));
  };

  return (
    <div className="wtab btab" hidden={!active}>
      {map && !running ? (
        <>
          <div className="wtab-bar">
            <button type="button" className="btn small" onClick={() => setMap(null)}>
              ← Закрыть карту
            </button>
            <span className="muted">
              {map.addresses.length} {plural(map.addresses.length, ['кошелёк', 'кошелька', 'кошельков'])} · цель и выбранные из бандла
            </span>
          </div>
          <div className="mtabs" role="tablist" aria-label="Раздел">
            <button type="button" role="tab" aria-selected={mobileTab === 'map'} className={mobileTab === 'map' ? 'on' : ''} onClick={() => switchMobile('map')}>
              Карта
            </button>
            <button type="button" role="tab" aria-selected={mobileTab === 'list'} className={mobileTab === 'list' ? 'on' : ''} onClick={() => switchMobile('list')}>
              Связи
            </button>
          </div>
          <main className={'main' + (panelOpen ? '' : ' panel-closed') + (mobileTab === 'list' ? ' tab-list' : ' tab-map')}>
            <section className="map">
              <GraphView graph={map} highlight={highlight} resetKey={resetKey} onSelectNode={onSelectNode} onSelectEdge={onSelectEdge} onClear={onClear} />
              <div className="map-tools">
                <button type="button" className="btn small" onClick={() => setResetKey((k) => k + 1)}>
                  Сбросить вид
                </button>
              </div>
              <Legend nodes={map.nodes.map((x) => x.kind)} clusters={map.clusters.length} />
              {selection && <Drawer result={map} selection={selection} onSelect={setSelection} onClose={() => setSelection(null)} onPivot={onSearch} />}
              <button type="button" className="panel-toggle" onClick={() => setPanelOpen((o) => !o)} title={panelOpen ? 'Свернуть панель' : 'Показать панель'}>
                {panelOpen ? '»' : '«'}
              </button>
            </section>
            <aside className="panel">
              <GroupPanel result={map} selection={selection} onSelect={selectFromPanel} onPivot={onSearch} />
            </aside>
          </main>
        </>
      ) : (
        <div className="btab-scroll">
          <form
            className="bform"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid && !running) start();
            }}
          >
            <div className="bform-row">
              <AddrInput value={address} onChange={setAddress} placeholder="Адрес кошелька Solana или имя из списка" label="Адрес или имя кошелька" history={[]} onPickHistory={() => {}} onClearHistory={() => {}} />
              <button type="submit" className="btn primary" disabled={!valid || running}>
                Найти бандл
              </button>
            </div>
            <div className="bform-row opts">
              <label className="bopt">
                <span>Токенов</span>
                <select className="depth" value={tokens} onChange={(e) => setTokens(Number(e.target.value))}>
                  {[5, 10, 20, 30].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label className="bopt" title={WINDOW_HINT}>
                <span>Окно</span>
                <select className="depth" value={windowMin} onChange={(e) => setWindowMin(Number(e.target.value) as 1 | 3 | 5 | 10 | 30)}>
                  {[1, 3, 5, 10, 30].map((m) => (
                    <option key={m} value={m}>
                      ±{m} мин
                    </option>
                  ))}
                </select>
              </label>
              <label className="bopt check">
                <input type="checkbox" checked={sells} onChange={(e) => setSells(e.target.checked)} />
                <span>Учитывать продажи</span>
              </label>
              <label className="bopt check" title={EXPAND_HINT}>
                <input type="checkbox" checked={expand} onChange={(e) => setExpand(e.target.checked)} />
                <span>Максимальный поиск (второй круг)</span>
              </label>
            </div>
            <div className="bhints muted">
              {windowMin >= 10 && <div>{WINDOW_HINT}</div>}
              {expand && <div>{EXPAND_HINT}</div>}
              <div>
                Ориентировочно: <b>≈ от {fmtN(creditsMin)} до {fmtN(creditsMax)} кредитов</b>
                {expand && <> (+300–1500 при максимальном поиске)</>}. Реальная цена зависит от того, сколько сделок было в окне.
              </div>
            </div>
          </form>

          {!result && !running && (
            <div className="empty bempty">
              <p>
                Введите адрес кошелька: сервер возьмёт последние купленные им токены и найдёт кошельки, которые торговали теми же токенами в те же минуты, то есть вероятные части одного бандла.
              </p>
            </div>
          )}

          {result && (
            <ResultView
              r={result}
              selected={selected}
              toggle={toggle}
              openRow={openRow}
              setOpenRow={setOpenRow}
              tokensOpen={tokensOpen}
              setTokensOpen={setTokensOpen}
              onSearch={onSearch}
              onExport={exportCsv}
              onMap={showMap}
              notice={notice}
            />
          )}
        </div>
      )}

      {phase.status === 'running' && (
        <div className="overlay center blocking">
          <div className="progress-card">
            <div className="pc-head">
              <span className="spinner" />
              <b>{phase.what === 'bundle' ? 'Ищу кошельки бандла' : 'Строю карту группы'}</b>
              <span className="muted mono">
                <Elapsed since={phase.startedAt} />
              </span>
            </div>
            <ul className="pc-lines">
              {phase.progress.length === 0 && <li className="muted">Запускаю задачу…</li>}
              {phase.progress.map((l, i) => (
                <li key={i} className={i === phase.progress.length - 1 ? 'last' : ''}>
                  {l}
                </li>
              ))}
            </ul>
            <div className="pc-foot">
              <button type="button" className="btn" onClick={cancel}>
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}

      {phase.status === 'error' && (
        <div className="overlay center blocking">
          <div className="progress-card error">
            <div className="pc-head">
              <b>{phase.what === 'bundle' ? 'Не удалось найти бандл' : 'Не удалось построить карту группы'}</b>
            </div>
            <div className="error-box">{phase.message}</div>
            {phase.progress.length > 0 && (
              <ul className="pc-lines">
                {phase.progress.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            )}
            <div className="pc-foot">
              <button type="button" className="btn" onClick={() => setPhase({ status: 'idle' })}>
                Закрыть
              </button>
              <button type="button" className="btn primary" onClick={phase.retry}>
                Повторить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- результат ----------

interface ResultProps {
  r: BundleResult;
  selected: Set<string>;
  toggle: (a: string) => void;
  openRow: string | null;
  setOpenRow: (a: string | null) => void;
  tokensOpen: boolean;
  setTokensOpen: (v: boolean) => void;
  onSearch: (address: string, label?: string) => void;
  onExport: () => void;
  onMap: () => void;
  notice: string | null;
}

function ResultView({ r, selected, toggle, openRow, setOpenRow, tokensOpen, setTokensOpen, onSearch, onExport, onMap, notice }: ResultProps) {
  const own = r.tokens.filter((t) => t.seed === r.target).length;
  const n = selected.size;
  const ex = r.excluded;
  const s = r.stats;
  const skipped = r.tokens.filter((t) => t.skipped).length;
  return (
    <div className="bres">
      <div className="bhead">
        <div className="bhead-main">
          <b>Бандл кошелька</b>
          <AddrChip address={r.target} label={r.targetTracked ? `${r.targetTracked.emoji} ${r.targetTracked.name}`.trim() : undefined} />
        </div>
        <div className="muted">
          Проверено токенов: <b>{own}</b>
          {r.tokens.length > own && <> (+{r.tokens.length - own} из второго круга)</>} · найдено кошельков: <b>{r.wallets.length}</b>
        </div>
        <div className="muted">
          Отброшено: {ex.bots} {plural(ex.bots, ['бот', 'бота', 'ботов'])}, {ex.sandwich} {plural(ex.sandwich, ['сэндвич', 'сэндвича', 'сэндвичей'])}, {ex.programs} {plural(ex.programs, ['программа', 'программы', 'программ'])}
        </div>
      </div>

      {r.warnings.map((w, i) => (
        <div key={i} className="cobuy-note bwarn">
          {w}
        </div>
      ))}

      <div className="btools">
        <button type="button" className="btn small" onClick={onExport} disabled={r.wallets.length === 0}>
          Экспорт CSV
        </button>
        <span className="muted">Нажмите на строку, чтобы увидеть подробности.</span>
      </div>

      {r.wallets.length === 0 ? (
        <div className="empty">
          <p>Подходящих кошельков не найдено. Попробуйте больше токенов, более широкое окно или максимальный поиск.</p>
        </div>
      ) : (
        <div className="btable">
          <div className="brow bhd">
            <span />
            <span>Оценка</span>
            <span>Кошелёк</span>
            <span>Токены</span>
            <span>Признаки</span>
            <span />
          </div>
          {r.wallets.map((w) => {
            const open = openRow === w.address;
            return (
              <Fragment key={w.address}>
                <div className={'brow' + (open ? ' open' : '') + (selected.has(w.address) ? ' sel' : '') + (w.copytrader ? ' copy' : '')} onClick={() => setOpenRow(open ? null : w.address)} role="button" tabIndex={0} aria-expanded={open} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpenRow(open ? null : w.address))}>
                  <span className="bc-chk" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(w.address)} onChange={() => toggle(w.address)} aria-label="Показать на карте" />
                  </span>
                  <span className="bc-score" style={{ color: scoreColor(w.score) }}>
                    {Math.round(w.score * 100)}%
                  </span>
                  <span className="bc-wallet">
                    {w.tracked && (
                      <span className="wname">
                        {w.tracked.emoji} {w.tracked.name}
                      </span>
                    )}
                    <AddrChip address={w.address} />
                    {w.firstFunder && (
                      <span className="muted bvia" title={w.firstFunder}>
                        источник: {w.firstFunder === r.target ? 'цель' : shortAddr(w.firstFunder)}
                      </span>
                    )}
                    {w.via && (
                      <span className="muted bvia" title={w.via}>
                        через {shortAddr(w.via)}
                      </span>
                    )}
                  </span>
                  <span className="bc-tok">
                    токенов: {w.tokensMatched}
                    {w.overlap != null && <span className="muted"> · {Math.round(w.overlap * 100)}% общих</span>}
                  </span>
                  <span className="bc-sig">
                    {w.signals.map((sg) => (
                      <span key={sg} className={'tag bsig' + (STRONG.includes(sg) ? ' strong' : '')}>
                        {SIGNAL_RU[sg]}
                      </span>
                    ))}
                    {w.transferCount > 0 && (
                      <span className="muted bxfer">
                        переводы с целью: {fmtSol(w.totalSol)} SOL, {w.transferCount}
                      </span>
                    )}
                  </span>
                  <span className="bc-act" onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="pivot-btn" onClick={() => onSearch(w.address, w.tracked?.name)} title="Искать связи этого кошелька">
                      Искать связи ↗
                    </button>
                  </span>
                </div>
                {open && <WalletDetails w={w} />}
              </Fragment>
            );
          })}
        </div>
      )}

      <div className="bmap-bar">
        <span>
          Для карты: цель + <b>{n}</b> из {MAX_MAP - 1}
        </span>
        <button type="button" className="btn primary" disabled={n < 1} onClick={onMap} title={n < 1 ? 'Отметьте хотя бы один кошелёк' : 'Карта связей цели и выбранных кошельков, по кэшу'}>
          Показать на карте
        </button>
        {notice && <span className="selbar-notice">{notice}</span>}
      </div>

      <div className="bsec">
        <button type="button" className="bsec-head" aria-expanded={tokensOpen} onClick={() => setTokensOpen(!tokensOpen)}>
          {tokensOpen ? '▾' : '▸'} Проверенные токены ({r.tokens.length})
        </button>
        {tokensOpen && (
          <div className="bscroll">
            <table className="tbl btbl">
              <thead>
                <tr>
                  <th>Токен</th>
                  <th>Покупка</th>
                  <th>Продажа</th>
                  <th>Толпа</th>
                  <th>Совпало</th>
                  <th>Пул</th>
                  <th>Seed</th>
                </tr>
              </thead>
              <tbody>
                {r.tokens.map((t) => (
                  <Fragment key={t.mint + t.seed}>
                    <tr className={t.skipped ? 'dim' : ''}>
                      <td>
                        <span className="mono">{shortAddr(t.mint)}</span> <CopyButton text={t.mint} title="Копировать mint" />
                        <a className="icon-btn" href={solscanToken(t.mint)} target="_blank" rel="noreferrer noopener" title="Открыть в Solscan">
                          ↗
                        </a>
                      </td>
                      <td className="nowrap">{t.buySlot != null ? <>{t.buySlot} · {fmtTime(t.buyTime)}</> : '—'}</td>
                      <td className="nowrap">{t.sellSlot != null ? <>{t.sellSlot} · {fmtTime(t.sellTime)}</> : '—'}</td>
                      <td>{t.crowd}</td>
                      <td>{t.matched}</td>
                      <td className="nowrap">
                        {t.pool ? (
                          <>
                            <span className="mono">{shortAddr(t.pool)}</span> <CopyButton text={t.pool} title="Копировать адрес пула" />
                            <a className="icon-btn" href={solscanAccount(t.pool)} target="_blank" rel="noreferrer noopener" title="Открыть в Solscan">
                              ↗
                            </a>
                            {t.truncated && <span className="trunc" title="Окно прочитано не полностью: упёрлись в предел страниц"> окно не полностью</span>}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="mono">{t.seed === r.target ? <span className="muted">цель</span> : `через ${shortAddr(t.seed)}`}</td>
                    </tr>
                    {t.skipped && (
                      <tr className="dim">
                        <td colSpan={7} className="skip-reason">
                          Пропущен: {t.skipped}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="footer bstats">
        <span>Токенов прочитано: <b>{fmtN(s.tokensScanned)}</b>{skipped > 0 && <> (пропущено: {skipped})</>}</span>
        <span>Переводов пула: <b>{fmtN(s.transfersScanned)}</b></span>
        <span>Запросов: <b>{fmtN(s.apiCalls)}</b></span>
        <span>Кредитов (оценка): <b>{fmtN(s.creditsEstimate)}</b></span>
        <span>Время: <b>{fmtDuration(s.durationMs)}</b></span>
      </div>
    </div>
  );
}

function WalletDetails({ w }: { w: BundleWallet }) {
  return (
    <div className="bdet">
      {w.reasons.length > 0 && (
        <ul className="bdet-reasons">
          {w.reasons.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      )}
      {w.matches.length > 0 && (
        <div className="bscroll">
          <table className="tbl btbl">
            <thead>
              <tr>
                <th>Токен</th>
                <th>Сделка</th>
                <th>Признак</th>
                <th>Δ слот</th>
                <th>Δ время</th>
                                <th>SOL</th>
                <th>Время</th>
                <th>Транзакция</th>
              </tr>
            </thead>
            <tbody>
              {w.matches.map((m, i) => (
                <tr key={m.signature + i}>
                  <td className="nowrap">
                    <span className="mono">{shortAddr(m.mint)}</span> <CopyButton text={m.mint} title="Копировать mint" />
                  </td>
                  <td>{m.kind === 'buy' ? 'покупка' : 'продажа'}</td>
                  <td>{SIGNAL_RU[m.signal]}</td>
                  <td>{m.dtSec == null ? '—' : m.slotDelta > 0 ? `+${m.slotDelta}` : m.slotDelta}</td>
                  <td>{fmtDt(m.dtSec)}</td>
                  <td>{m.sol == null ? '—' : fmtSol(m.sol)}</td>
                  <td className="nowrap">{fmtTime(m.time)}</td>
                  <td>
                    <a href={solscanTxUrl(m.signature)} target="_blank" rel="noreferrer noopener">
                      {shortAddr(m.signature)} ↗
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
