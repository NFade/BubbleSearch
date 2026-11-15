import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GroupResult, WalletRow } from '../../shared/types.ts';
import { getWallets, group as runGroup, refreshWallet, type JobHandle } from './api.ts';
import { Elapsed, Legend, useNarrow } from './common.tsx';
import { Drawer } from './Drawer.tsx';
import { GraphView } from './GraphView.tsx';
import { GroupPanel } from './GroupPanel.tsx';
import { CopyButton } from './ui.tsx';
import { computeHighlight, fmtAge, fmtAgo, fmtTime, plural, shortAddr, type Selection } from './util.ts';

const MAX_SELECT = 15;
const BALANCE_TTL_MS = 5 * 60_000;
const ROW_H = 46;
const CARD_H = 150;

type SortKey = 'name' | 'balance' | 'last' | 'age';

/** Стоимость «глубокой» карты группы из n кошельков в кредитах Helius (см. shared/types.ts). */
export function deepCost(n: number): number {
  // Пары по всей истории + истории и плательщики кошельков + проверка до 20 посредников (замер 15.11: 5 кошельков — 541 кредит).
  return (n * (n - 1)) / 2 * 10 + n * 70 + 200;
}

type Run =
  | { status: 'idle' }
  | { status: 'running'; deep: boolean; progress: string[]; startedAt: number }
  | { status: 'error'; deep: boolean; message: string; progress: string[]; retry: () => void };

interface Props {
  /** Открыть обычный поиск по кошельку. */
  onSearch: (address: string, label?: string) => void;
  /** Вкладка сейчас видна (скрытая остаётся смонтированной, чтобы не терять выбор и результат). */
  active: boolean;
}

/** Подставляет имена, эмодзи и группы из списка в узлы выбранных кошельков (сервер может отдать только адрес). */
function decorate(g: GroupResult, byAddr: Map<string, WalletRow>): GroupResult {
  return {
    ...g,
    nodes: g.nodes.map((n) => {
      const w = byAddr.get(n.id);
      if (!w || (n.kind !== 'target' && n.kind !== 'tracked')) return n;
      return { ...n, label: w.name, emoji: n.emoji ?? (w.emoji || undefined), entity: n.entity ?? w.entity, entityName: n.entityName ?? w.entityName, groups: n.groups ?? w.groups };
    }),
  };
}

function cmp(a: number | null, b: number | null, dir: 1 | -1): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1; // пустые всегда внизу
  if (b == null) return -1;
  return (a - b) * dir;
}

export function WalletsTab({ onSearch, active }: Props) {
  const narrow = useNarrow();
  const [wallets, setWallets] = useState<WalletRow[] | null>(null);
  const [balancesAt, setBalancesAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [groupSel, setGroupSel] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set());
  const [confirmDeep, setConfirmDeep] = useState(false);
  const [run, setRun] = useState<Run>({ status: 'idle' });
  const [result, setResult] = useState<GroupResult | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [mobileTab, setMobileTab] = useState<'map' | 'list'>('map');
  const [resetKey, setResetKey] = useState(0);
  const handle = useRef<JobHandle<unknown> | null>(null);
  const runId = useRef(0);
  const noticeTimer = useRef(0);

  // ----- загрузка списка: сервер отдаёт его сразу, балансы догружаются в фоне (balancesAt = null) -----
  useEffect(() => {
    let dead = false;
    let timer = 0;
    let polls = 0;
    const load = async () => {
      try {
        const r = await getWallets();
        if (dead) return;
        setWallets(r.wallets);
        setBalancesAt(r.balancesAt);
        setError(null);
        const stale = r.balancesAt != null && Date.now() - r.balancesAt > BALANCE_TTL_MS;
        // Балансы ещё грузятся — спрашиваем снова; протухшие обновляются сервером в фоне — один повтор.
        if ((r.balancesAt == null && polls < 40) || (stale && polls < 1)) {
          polls++;
          timer = window.setTimeout(load, r.balancesAt == null ? 4000 : 5000);
        }
      } catch (e) {
        if (dead) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    return () => {
      dead = true;
      window.clearTimeout(timer);
    };
  }, []);
  const reload = () => {
    setWallets(null);
    setError(null);
    getWallets()
      .then((r) => {
        setWallets(r.wallets);
        setBalancesAt(r.balancesAt);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4500);
  }, []);

  const byAddr = useMemo(() => new Map((wallets ?? []).map((w) => [w.address, w])), [wallets]);
  const allGroups = useMemo(() => {
    const m = new Map<string, number>();
    for (const w of wallets ?? []) for (const g of w.groups) m.set(g, (m.get(g) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'));
  }, [wallets]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = wallets ?? [];
    if (q) list = list.filter((w) => w.name.toLowerCase().includes(q) || w.entityName.toLowerCase().includes(q) || w.address.toLowerCase().includes(q));
    if (groupSel.size > 0) list = list.filter((w) => w.groups.some((g) => groupSel.has(g)));
    const now = Date.now() / 1000;
    const out = [...list];
    const { key, dir } = sort;
    out.sort((a, b) => {
      let c = 0;
      if (key === 'name') c = a.name.localeCompare(b.name, 'ru') * dir;
      else if (key === 'balance') c = cmp(a.balanceSol, b.balanceSol, dir);
      else if (key === 'last') c = cmp(a.lastActive, b.lastActive, dir);
      else c = cmp(a.firstSeen == null ? null : now - a.firstSeen, b.firstSeen == null ? null : now - b.firstSeen, dir);
      return c || a.name.localeCompare(b.name, 'ru') || a.address.localeCompare(b.address);
    });
    return out;
  }, [wallets, query, groupSel, sort]);

  const selSet = useMemo(() => new Set(selected), [selected]);

  // ----- выбор -----
  const toggle = useCallback(
    (address: string) => {
      setSelected((cur) => {
        if (cur.includes(address)) return cur.filter((a) => a !== address);
        if (cur.length >= MAX_SELECT) {
          flash(`Можно выбрать не больше ${MAX_SELECT} кошельков за раз.`);
          return cur;
        }
        return [...cur, address];
      });
    },
    [flash],
  );
  const selectShown = () => {
    const allSel = shown.length > 0 && shown.every((w) => selSet.has(w.address));
    if (allSel) {
      const s = new Set(shown.map((w) => w.address));
      setSelected((cur) => cur.filter((a) => !s.has(a)));
      return;
    }
    const next = [...selected];
    let skipped = 0;
    for (const w of shown) {
      if (selSet.has(w.address)) continue;
      if (next.length >= MAX_SELECT) {
        skipped++;
        continue;
      }
      next.push(w.address);
    }
    setSelected(next);
    if (skipped > 0) flash(`Выбрано ${MAX_SELECT} кошельков — максимум за раз. Не выбрано ещё ${skipped} из показанных.`);
  };

  // ----- обновление строки -----
  const refresh = useCallback(
    (address: string) => {
      setRefreshing((s) => new Set(s).add(address));
      refreshWallet(address)
        .then((row) => setWallets((cur) => cur && cur.map((w) => (w.address === address ? row : w))))
        .catch((e) => flash(`Не удалось обновить: ${e instanceof Error ? e.message : e}`))
        .finally(() =>
          setRefreshing((s) => {
            const n = new Set(s);
            n.delete(address);
            return n;
          }),
        );
    },
    [flash],
  );

  // ----- карта группы -----
  const start = useCallback(
    (deep: boolean, from?: string[]) => {
      const addresses = (from ?? selected).slice();
      if (from) setSelected(from);
      handle.current?.cancel();
      const id = ++runId.current;
      setConfirmDeep(false);
      setSelection(null);
      setMobileTab('map');
      setRun({ status: 'running', deep, progress: [], startedAt: Date.now() });
      const h = runGroup({ addresses, deep }, (lines) => {
        if (runId.current !== id) return;
        setRun((r) => (r.status === 'running' ? { ...r, progress: lines } : r));
      });
      handle.current = h;
      h.promise
        .then((g) => {
          if (runId.current !== id) return;
          setResult(decorate(g, byAddr));
          setRun({ status: 'idle' });
          setResetKey((k) => k + 1);
        })
        .catch((e) => {
          if (runId.current !== id) return;
          setRun((r) => ({ status: 'error', deep, message: e instanceof Error ? e.message : String(e), progress: r.status === 'running' ? r.progress : [], retry: () => start(deep, addresses) }));
        });
    },
    [selected, byAddr],
  );
  useEffect(() => () => handle.current?.cancel(), []);

  const highlight = useMemo(() => computeHighlight(result, selection), [result, selection]);
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
  const switchTab = (t: 'map' | 'list') => {
    setMobileTab(t);
    if (t === 'map') setResetKey((k) => k + 1);
  };
  // После показа скрытой вкладки карта пересчитывает размер сама (ResizeObserver).

  const running = run.status === 'running';
  const n = selected.length;

  return (
    <div className="wtab" hidden={!active}>
      {result && !running ? (
        <>
          <div className="wtab-bar">
            <button type="button" className="btn small" onClick={() => setResult(null)}>
              ← К списку кошельков
            </button>
            <span className="muted">
              {result.addresses.length} {plural(result.addresses.length, ['кошелёк', 'кошелька', 'кошельков'])} · {result.options.deep ? 'глубокий проход' : 'быстрый проход по кэшу'}
            </span>
            {!result.options.deep && (
              <button type="button" className="btn small" onClick={() => setConfirmDeep(true)}>
                Глубже… · ≈{deepCost(result.addresses.length).toLocaleString('ru-RU')} кр.
              </button>
            )}
          </div>
          <div className="mtabs" role="tablist" aria-label="Раздел">
            <button type="button" role="tab" aria-selected={mobileTab === 'map'} className={mobileTab === 'map' ? 'on' : ''} onClick={() => switchTab('map')}>
              Карта
            </button>
            <button type="button" role="tab" aria-selected={mobileTab === 'list'} className={mobileTab === 'list' ? 'on' : ''} onClick={() => switchTab('list')}>
              Связи
            </button>
          </div>
          <main className={'main' + (panelOpen ? '' : ' panel-closed') + (mobileTab === 'list' ? ' tab-list' : ' tab-map')}>
            <section className="map">
              <GraphView graph={result} highlight={highlight} resetKey={resetKey} onSelectNode={onSelectNode} onSelectEdge={onSelectEdge} onClear={onClear} />
              <div className="map-tools">
                <button type="button" className="btn small" onClick={() => setResetKey((k) => k + 1)}>
                  Сбросить вид
                </button>
              </div>
              <Legend nodes={result.nodes.map((x) => x.kind)} clusters={result.clusters.length} />
              {selection && <Drawer result={result} selection={selection} onSelect={setSelection} onClose={() => setSelection(null)} onPivot={onSearch} />}
              <button type="button" className="panel-toggle" onClick={() => setPanelOpen((o) => !o)} title={panelOpen ? 'Свернуть панель' : 'Показать панель'}>
                {panelOpen ? '»' : '«'}
              </button>
            </section>
            <aside className="panel">
              <GroupPanel result={result} selection={selection} onSelect={selectFromPanel} onPivot={onSearch} />
            </aside>
          </main>
        </>
      ) : (
        <WalletList
          wallets={wallets}
          error={error}
          onRetry={reload}
          shown={shown}
          query={query}
          setQuery={setQuery}
          allGroups={allGroups}
          groupSel={groupSel}
          setGroupSel={setGroupSel}
          sort={sort}
          setSort={setSort}
          selSet={selSet}
          toggle={toggle}
          selectShown={selectShown}
          refreshing={refreshing}
          refresh={refresh}
          onSearch={onSearch}
          narrow={narrow}
          balancesAt={balancesAt}
          notice={notice}
        />
      )}

      {!result && n > 0 && (
        <SelectionBar selected={selected} byAddr={byAddr} onRemove={toggle} onClear={() => setSelected([])} onQuick={() => start(false)} onDeep={() => setConfirmDeep(true)} notice={notice} />
      )}

      {confirmDeep && (
        <div className="modal-back" onClick={() => setConfirmDeep(false)}>
          <div className="modal" role="dialog" aria-label="Подтверждение глубокого поиска" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <b>Глубокий поиск по {(result?.addresses.length ?? n)} кошелькам</b>
            </div>
            <p>
              Догрузит истории выбранных кошельков и проверит каждую пару по всей истории, как в режиме «Два кошелька».
            </p>
            <p>
              Оценка стоимости: <b>{deepCost(result?.addresses.length ?? n).toLocaleString('ru-RU')} кредитов</b> Helius ({result?.addresses.length ?? n}·({result?.addresses.length ?? n}−1)/2 × 10 + {result?.addresses.length ?? n} × 70 + 200 на проверку посредников). Это верхняя оценка: то, что уже есть в кэше, повторно
              не запрашивается.
            </p>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => setConfirmDeep(false)}>
                Отмена
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => start(true, result?.addresses)}
              >
                Запустить
              </button>
            </div>
          </div>
        </div>
      )}

      {running && run.status === 'running' && (
        <div className="overlay center blocking">
          <div className="progress-card">
            <div className="pc-head">
              <span className="spinner" />
              <b>{run.deep ? 'Строю карту группы (глубоко)' : 'Строю карту группы'}</b>
              <span className="muted mono">
                <Elapsed since={run.startedAt} />
              </span>
            </div>
            <ul className="pc-lines">
              {run.progress.length === 0 && <li className="muted">Запускаю задачу…</li>}
              {run.progress.map((l, i) => (
                <li key={i} className={i === run.progress.length - 1 ? 'last' : ''}>
                  {l}
                </li>
              ))}
            </ul>
            <div className="pc-foot">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  handle.current?.cancel();
                  runId.current++;
                  setRun({ status: 'idle' });
                }}
              >
                Отменить
              </button>
            </div>
          </div>
        </div>
      )}

      {run.status === 'error' && (
        <div className="overlay center blocking">
          <div className="progress-card error">
            <div className="pc-head">
              <b>Не удалось построить карту группы</b>
            </div>
            <div className="error-box">{run.message}</div>
            {run.progress.length > 0 && (
              <ul className="pc-lines">
                {run.progress.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            )}
            <div className="pc-foot">
              <button type="button" className="btn" onClick={() => setRun({ status: 'idle' })}>
                Закрыть
              </button>
              <button type="button" className="btn primary" onClick={run.retry}>
                Повторить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- панель выбора ----------

function SelectionBar({
  selected,
  byAddr,
  onRemove,
  onClear,
  onQuick,
  onDeep,
  notice,
}: {
  selected: string[];
  byAddr: Map<string, WalletRow>;
  onRemove: (a: string) => void;
  onClear: () => void;
  onQuick: () => void;
  onDeep: () => void;
  notice: string | null;
}) {
  const n = selected.length;
  return (
    <div className="selbar">
      {notice && <div className="selbar-notice">{notice}</div>}
      <div className="selbar-main">
        <div className="selbar-count">
          Выбрано <b>{n}</b> из {MAX_SELECT}
          <button type="button" className="btn small" onClick={onClear}>
            Сбросить
          </button>
        </div>
        <div className="selbar-chips">
          {selected.map((a) => {
            const w = byAddr.get(a);
            return (
              <span key={a} className="sel-chip" title={a}>
                {w?.emoji} {w?.name ?? shortAddr(a)}
                <button type="button" aria-label="Убрать из выбора" onClick={() => onRemove(a)}>
                  ✕
                </button>
              </span>
            );
          })}
        </div>
        <div className="selbar-actions">
          <button type="button" className="btn primary" disabled={n < 2} onClick={onQuick} title={n < 2 ? 'Выберите минимум два кошелька' : 'По кэшу, без запросов к сети'}>
            Показать баблы (быстро)
          </button>
          <button type="button" className="btn" disabled={n < 2} onClick={onDeep} title={`≈ ${deepCost(n).toLocaleString('ru-RU')} кредитов`}>
            Глубже · ≈{deepCost(n).toLocaleString('ru-RU')} кр.
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- список ----------

interface ListProps {
  wallets: WalletRow[] | null;
  error: string | null;
  onRetry: () => void;
  shown: WalletRow[];
  query: string;
  setQuery: (q: string) => void;
  allGroups: Array<[string, number]>;
  groupSel: Set<string>;
  setGroupSel: (s: Set<string>) => void;
  sort: { key: SortKey; dir: 1 | -1 };
  setSort: (s: { key: SortKey; dir: 1 | -1 }) => void;
  selSet: Set<string>;
  toggle: (a: string) => void;
  selectShown: () => void;
  refreshing: Set<string>;
  refresh: (a: string) => void;
  onSearch: (address: string, label?: string) => void;
  narrow: boolean;
  balancesAt: number | null;
  notice: string | null;
}

function GroupFilter({ all, sel, onChange }: { all: Array<[string, number]>; sel: Set<string>; onChange: (s: Set<string>) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: Event) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className={'btn' + (sel.size ? ' active' : '')} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Группы{sel.size ? ` (${sel.size})` : ''} ▾
      </button>
      {open && (
        <div className="menu-pop group-pop">
          {all.length === 0 && <div className="pop-empty muted">Групп нет</div>}
          <div className="pop-list">
            {all.map(([g, c]) => (
              <label key={g} className="pop-item check">
                <input
                  type="checkbox"
                  checked={sel.has(g)}
                  onChange={() => {
                    const n = new Set(sel);
                    if (n.has(g)) n.delete(g);
                    else n.add(g);
                    onChange(n);
                  }}
                />
                <span>{g}</span>
                <span className="muted">{c}</span>
              </label>
            ))}
          </div>
          {sel.size > 0 && (
            <button type="button" className="pop-foot-btn" onClick={() => onChange(new Set())}>
              Сбросить фильтр
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function WalletList(p: ListProps) {
  const { wallets, shown, narrow } = p;
  const rh = narrow ? CARD_H : ROW_H;
  const boxRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [vh, setVh] = useState(600);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const upd = () => setVh(el.clientHeight || 600);
    upd();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    return () => ro.disconnect();
  }, [wallets === null]);
  // Смена фильтра или сортировки — к началу списка.
  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [p.query, p.groupSel, p.sort]);

  const start = Math.max(0, Math.floor(scrollTop / rh) - 8);
  const end = Math.min(shown.length, Math.ceil((scrollTop + vh) / rh) + 8);
  const nowMin = Math.floor(Date.now() / 60000) * 60000;
  const balancesLoading = p.balancesAt == null;
  const allShownSel = shown.length > 0 && shown.every((w) => p.selSet.has(w.address));

  const head = (key: SortKey, label: string, cls = '') => {
    const on = p.sort.key === key;
    return (
      <button type="button" className={'wh ' + cls + (on ? ' on' : '')} onClick={() => p.setSort(on ? { key, dir: p.sort.dir === 1 ? -1 : 1 } : { key, dir: key === 'name' ? 1 : -1 })}>
        {label} {on ? (p.sort.dir === 1 ? '▲' : '▼') : ''}
      </button>
    );
  };

  return (
    <div className="wlist-wrap">
      <div className="wtools">
        <input className="addr-input wsearch" type="search" value={p.query} onChange={(e) => p.setQuery(e.target.value)} placeholder="Поиск по имени, имени сущности или адресу" aria-label="Поиск кошельков" />
        <GroupFilter all={p.allGroups} sel={p.groupSel} onChange={p.setGroupSel} />
        {narrow && (
          <select className="depth" value={`${p.sort.key}:${p.sort.dir}`} onChange={(e) => { const [k, d] = e.target.value.split(':'); p.setSort({ key: k as SortKey, dir: Number(d) as 1 | -1 }); }} aria-label="Сортировка">
            <option value="name:1">Имя А→Я</option>
            <option value="name:-1">Имя Я→А</option>
            <option value="balance:-1">Баланс: больше</option>
            <option value="balance:1">Баланс: меньше</option>
            <option value="last:-1">Активность: свежие</option>
            <option value="last:1">Активность: давние</option>
            <option value="age:-1">Возраст: старые</option>
            <option value="age:1">Возраст: молодые</option>
          </select>
        )}
        <button type="button" className="btn" onClick={p.selectShown} disabled={shown.length === 0}>
          {allShownSel ? 'Снять выбор с показанных' : `Выбрать показанные (до ${MAX_SELECT})`}
        </button>
        <span className="wcount muted">{wallets ? `Показано ${shown.length.toLocaleString('ru-RU')} из ${wallets.length.toLocaleString('ru-RU')}` : 'Загружаю список…'}</span>
        {wallets && balancesLoading && <span className="wcount muted"><span className="spinner small" /> загружаю балансы…</span>}
      </div>

      {p.notice && !p.selSet.size && <div className="warning wnotice">{p.notice}</div>}

      {p.error && (
        <div className="empty werr">
          <div className="empty-title">Не удалось загрузить кошельки</div>
          <p>{p.error}</p>
          <button type="button" className="btn small" onClick={p.onRetry}>
            Повторить
          </button>
        </div>
      )}
      {!wallets && !p.error && <div className="empty werr"><span className="spinner" /> Загружаю список кошельков…</div>}

      {wallets && (
        <div className="wlist" ref={boxRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
          {!narrow && (
            <div className="wrow whead">
              <span className="wc-check">
                <input type="checkbox" checked={allShownSel} onChange={p.selectShown} aria-label="Выбрать все показанные" />
              </span>
              {head('name', 'Имя', 'wc-name')}
              <span className="wc-addr wh">Адрес</span>
              <span className="wc-groups wh">Группы</span>
              {head('balance', 'Баланс, SOL', 'wc-bal num')}
              {head('last', 'Активность', 'wc-last')}
              {head('age', 'Возраст', 'wc-age')}
              <span className="wc-idx wh" title="Что есть в кэше: И — история переводов, П — плательщики комиссий">Индекс</span>
              <span className="wc-act wh" />
            </div>
          )}
          {shown.length === 0 ? (
            <div className="empty werr">Ничего не найдено. Измените запрос или сбросьте фильтр по группам.</div>
          ) : (
            <div className="wbody" style={{ height: shown.length * rh }}>
              {shown.slice(start, end).map((w, i) => (
                <Row key={w.address} w={w} top={(start + i) * rh} h={rh} selected={p.selSet.has(w.address)} refreshing={p.refreshing.has(w.address)} loading={balancesLoading} now={nowMin} onToggle={p.toggle} onRefresh={p.refresh} onSearch={p.onSearch} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface RowProps {
  w: WalletRow;
  top: number;
  h: number;
  selected: boolean;
  refreshing: boolean;
  loading: boolean;
  now: number;
  onToggle: (a: string) => void;
  onRefresh: (a: string) => void;
  onSearch: (a: string, label?: string) => void;
}

const Row = memo(function Row({ w, top, h, selected, refreshing, loading, now, onToggle, onRefresh, onSearch }: RowProps) {
  const idxTitle = (what: string, on: boolean) => `${what}: ${on ? 'есть в кэше' : 'нет'}${on && w.indexed.fetchedAt ? ` (обновлено ${fmtTime(w.indexed.fetchedAt)})` : ''}`;
  return (
    <div className={'wrow' + (selected ? ' sel' : '')} style={{ top, height: h }}>
      <span className="wc-check">
        <input type="checkbox" checked={selected} onChange={() => onToggle(w.address)} aria-label={`Выбрать ${w.name}`} />
      </span>
      <span className="wc-name" title={w.entityName !== w.name ? `${w.name} · ${w.entityName}` : w.name}>
        <span className="emoji">{w.emoji}</span>
        <span className="wname">{w.name}</span>
      </span>
      <span className="wc-addr">
        <span className="mono addr" title={w.address}>{shortAddr(w.address)}</span>
        <CopyButton text={w.address} />
      </span>
      <span className="wc-groups">
        {w.groups.map((g) => (
          <span key={g} className="gchip">{g}</span>
        ))}
      </span>
      <span className="wc-bal num" title="Баланс SOL">
        {w.balanceSol != null ? w.balanceSol.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) : loading ? <span className="muted">загружаю…</span> : '—'}
      </span>
      <span className="wc-last" title={w.lastActive ? `${fmtTime(w.lastActive)} (по кэшу; ↻ — точное значение)` : 'Нет данных в кэше'}>
        {w.lastActive == null && loading && !w.indexed.history ? <span className="muted">…</span> : fmtAgo(w.lastActive, now)}
      </span>
      <span className="wc-age" title={w.firstSeen ? `Первый известный перевод: ${fmtTime(w.firstSeen)}` : 'Ранняя история не загружена'}>
        {fmtAge(w.firstSeen, now)}
      </span>
      <span className="wc-idx">
        <span className={'ix' + (w.indexed.history ? ' on' : '')} title={idxTitle('История переводов', w.indexed.history)}>И</span>
        <span className={'ix' + (w.indexed.payers ? ' on' : '')} title={idxTitle('Плательщики комиссий', w.indexed.payers)}>П</span>
      </span>
      <span className="wc-act">
        <button type="button" className="pivot-btn" onClick={() => onSearch(w.address, w.name)} title="Искать связи этого кошелька">
          Искать связи ↗
        </button>
        <button type="button" className="icon-btn big" disabled={refreshing} onClick={() => onRefresh(w.address)} title="Обновить: точная активность и баланс">
          {refreshing ? <span className="spinner small" /> : '↻'}
        </button>
      </span>
    </div>
  );
});
