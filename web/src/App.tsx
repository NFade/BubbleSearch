import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnalyzeResult, Depth, LinkResult, StatusResponse } from '../../shared/types.ts';
import { analyze, getStatus, isMock, link, type JobHandle } from './api.ts';
import { GraphView } from './GraphView.tsx';
import { LinkPanel, SidePanel } from './SidePanel.tsx';
import { Drawer } from './Drawer.tsx';
import { TopBar, type Hops, type Mode, type Tab } from './TopBar.tsx';
import { WalletsTab } from './WalletsTab.tsx';
import { BundleTab } from './BundleTab.tsx';
import { ImportModal } from './ImportModal.tsx';
import { addHistory, clearHistory, entryForPair, entryForSingle, loadHistory, type HistoryEntry } from './history.ts';
import {
  computeHighlight,
  fmtDuration,
  isValidAddress,
  loadPrefs,
  parseSpec,
  savePrefs,
  shortAddr,
  specKey,
  specToUrl,
  type SearchSpec,
  type Selection,
} from './util.ts';
import { Elapsed, Legend, useNarrow } from './common.tsx';

type Run =
  | { status: 'idle' }
  | { status: 'running'; kind: Mode; progress: string[]; startedAt: number }
  | { status: 'error'; kind: Mode; message: string; progress: string[]; retry: () => void }
  | { status: 'done' };

/** То, что сейчас показано: результат одного кошелька или связи двух. */
type View = { kind: 'single'; key: string; result: AnalyzeResult } | { kind: 'pair'; key: string; link: LinkResult };

interface TrailItem {
  key: string;
  label: string;
}
interface Nav {
  trail: TrailItem[];
  pos: number;
}

function viewLabel(v: View, hint?: string): string {
  if (v.kind === 'single') return v.result.targetTracked?.name ?? hint ?? shortAddr(v.result.target);
  const l = v.link;
  return `${l.aTracked?.name ?? shortAddr(l.a)} ⇄ ${l.bTracked?.name ?? shortAddr(l.b)}`;
}

export function App() {
  const initial = useMemo(() => {
    const p = loadPrefs();
    const spec = parseSpec(window.location.search);
    const hasDepth = (() => {
      try {
        return new URLSearchParams(window.location.search).has('depth');
      } catch {
        return false;
      }
    })();
    const prefDepth = (p.depth === 1 || p.depth === 2 || p.depth === 3 ? p.depth : 2) as Depth;
    const s = spec && spec.mode === 'single' && !hasDepth ? { ...spec, depth: prefDepth } : spec;
    return {
      spec: s,
      mode: (s?.mode ?? 'single') as Mode,
      address: s?.mode === 'single' ? s.address : (p.address ?? '').trim(),
      depth: s?.mode === 'single' ? s.depth : prefDepth,
      a: s?.mode === 'pair' ? s.a : '',
      b: s?.mode === 'pair' ? s.b : '',
      hops: (s?.mode === 'pair' ? s.hops : 3) as Hops,
    };
  }, []);

  const [tab, setTabState] = useState<Tab>(() => {
    try {
      const t = new URLSearchParams(window.location.search).get('tab');
      return !initial.spec && (t === 'wallets' || t === 'bundle') ? t : 'search';
    } catch {
      return 'search';
    }
  });
  /** Вкладка «Кошельки» монтируется при первом открытии и дальше остаётся в памяти (выбор и результат не теряются). */
  const [walletsOpened, setWalletsOpened] = useState(tab === 'wallets');
  /** Вкладка «Бандл» — так же: монтируется при первом открытии и остаётся в памяти. */
  const [bundleOpened, setBundleOpened] = useState(tab === 'bundle');
  const searchUrl = useRef('');
  const setTab = useCallback((t: Tab) => {
    setTabState((cur) => {
      if (cur === t) return cur;
      try {
        if (t === 'wallets' || t === 'bundle') {
          if (cur === 'search') searchUrl.current = window.location.search;
          const q = new URLSearchParams();
          if (isMock) q.set('mock', '1');
          q.set('tab', t);
          window.history.replaceState(null, '', `${window.location.pathname}?${q.toString()}`);
        } else {
          window.history.replaceState(null, '', `${window.location.pathname}${searchUrl.current || (isMock ? '?mock=1' : '')}`);
        }
      } catch {
        /* ignore */
      }
      return t;
    });
    if (t === 'wallets') setWalletsOpened(true);
    if (t === 'bundle') setBundleOpened(true);
  }, []);
  const [mode, setMode] = useState<Mode>(initial.mode);
  const [address, setAddress] = useState(initial.address);
  const [depth, setDepth] = useState<Depth>(initial.depth);
  const [addrA, setAddrA] = useState(initial.a);
  const [addrB, setAddrB] = useState(initial.b);
  const [hops, setHops] = useState<Hops>(initial.hops);
  const [run, setRun] = useState<Run>({ status: 'idle' });
  const [view, setView] = useState<View | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [resetKey, setResetKey] = useState(0);
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  const [mobileTab, setMobileTab] = useState<'map' | 'list'>('map');
  const narrow = useNarrow();
  const [nav, setNavState] = useState<Nav>({ trail: [], pos: 0 });
  const navRef = useRef<Nav>(nav);
  const setNav = useCallback((n: Nav) => {
    navRef.current = n;
    setNavState(n);
  }, []);
  /** Результаты, уже полученные в этой вкладке: «Назад» берёт их отсюда, не запуская анализ заново. */
  const cache = useRef(new Map<string, View>());
  const handle = useRef<JobHandle<unknown> | null>(null);
  const runId = useRef(0);
  const viewRef = useRef<View | null>(null);
  viewRef.current = view;

  const refreshStatus = useCallback(() => {
    getStatus()
      .then((s) => {
        setStatus(s);
        setStatusError(false);
      })
      .catch(() => setStatusError(true));
  }, []);
  useEffect(refreshStatus, [refreshStatus]);

  /** Показывает готовый результат и подгоняет поля верхней панели под него. */
  const show = useCallback((v: View) => {
    setView(v);
    setSelection(null);
    setRun({ status: 'done' });
    if (v.kind === 'single') {
      setMode('single');
      setAddress(v.result.target);
      setDepth(v.result.options.depth);
    } else {
      setMode('pair');
      setAddrA(v.link.a);
      setAddrB(v.link.b);
      setHops(v.link.options.maxHops);
    }
  }, []);

  /** nav: push — новый шаг цепочки и запись в истории браузера; replace — заменить текущий; none — URL уже выставил браузер. */
  const start = useCallback(
    (spec: SearchSpec, navMode: 'push' | 'replace' | 'none', labelHint?: string) => {
      handle.current?.cancel();
      const id = ++runId.current;
      const key = specKey(spec);
      const kind: Mode = spec.mode;
      setSelection(null);
      setMobileTab('map');
      setRun({ status: 'running', kind, progress: [], startedAt: Date.now() });
      const onProgress = (lines: string[]) => {
        if (runId.current !== id) return;
        setRun((r) => (r.status === 'running' ? { ...r, progress: lines } : r));
      };
      const finish = (v: View) => {
        if (runId.current !== id) return;
        cache.current.set(key, v);
        setHistory(
          addHistory(spec.mode === 'single' && v.kind === 'single' ? entryForSingle(spec, v.result, labelHint) : spec.mode === 'pair' && v.kind === 'pair' ? entryForPair(spec, v.link) : { key, spec, label: viewLabel(v, labelHint), time: Date.now(), top: '' }),
        );
        const item: TrailItem = { key, label: viewLabel(v, labelHint) };
        const cur = navRef.current;
        const url = specToUrl(spec, isMock);
        if (navMode === 'none' && cur.trail[cur.pos]?.key === key) {
          const trail = cur.trail.slice();
          trail[cur.pos] = item;
          setNav({ trail, pos: cur.pos });
        } else if (cur.trail.length === 0 || navMode === 'replace' || cur.trail[cur.pos]?.key === key) {
          const trail = cur.trail.length ? cur.trail.slice() : [item];
          trail[cur.trail.length ? cur.pos : 0] = item;
          setNav({ trail, pos: cur.trail.length ? cur.pos : 0 });
          try {
            window.history.replaceState(null, '', url);
          } catch {
            /* ignore */
          }
        } else {
          const trail = [...cur.trail.slice(0, cur.pos + 1), item];
          setNav({ trail, pos: trail.length - 1 });
          try {
            window.history.pushState(null, '', url);
          } catch {
            /* ignore */
          }
        }
        show(v);
      };
      const fail = (e: unknown) => {
        if (runId.current !== id) return;
        const message = e instanceof Error ? e.message : String(e);
        setRun((r) => ({
          status: 'error',
          kind,
          message,
          progress: r.status === 'running' ? r.progress : [],
          retry: () => start(spec, navMode, labelHint),
        }));
      };
      if (spec.mode === 'single') {
        savePrefs({ address: spec.address, depth: spec.depth });
        const h = analyze({ address: spec.address, depth: spec.depth }, onProgress);
        handle.current = h;
        h.promise.then((result) => finish({ kind: 'single', key, result })).catch(fail);
      } else {
        const h = link({ a: spec.a, b: spec.b, maxHops: spec.hops }, onProgress);
        handle.current = h;
        h.promise.then((l) => finish({ kind: 'pair', key, link: l })).catch(fail);
      }
    },
    [setNav, show],
  );

  const submit = useCallback(() => {
    if (mode === 'single') {
      const a = address.trim();
      if (isValidAddress(a)) start({ mode: 'single', address: a, depth }, 'push');
    } else {
      const a = addrA.trim();
      const b = addrB.trim();
      if (isValidAddress(a) && isValidAddress(b)) start({ mode: 'pair', a, b, hops }, 'push');
    }
  }, [mode, address, depth, addrA, addrB, hops, start]);

  /** Новый поиск, центрированный на выбранном кошельке (всегда в режиме «Один кошелёк»). */
  const onPivot = useCallback(
    (addr: string, label?: string) => {
      setTabState('search');
      setMode('single');
      setAddress(addr);
      start({ mode: 'single', address: addr, depth }, 'push', label);
    },
    [depth, start],
  );

  /** Запуск поиска из истории: поля формы подстраиваются сразу, не дожидаясь результата. */
  const restore = useCallback(
    (e: HistoryEntry) => {
      const sp = e.spec;
      setMode(sp.mode);
      if (sp.mode === 'single') {
        setAddress(sp.address);
        setDepth(sp.depth);
      } else {
        setAddrA(sp.a);
        setAddrB(sp.b);
        setHops(sp.hops);
      }
      start(sp, 'push');
    },
    [start],
  );
  const onClearHistory = useCallback(() => setHistory(clearHistory()), []);

  const autoRan = useRef(false);
  useEffect(() => {
    if (initial.spec && !autoRan.current) {
      autoRan.current = true;
      start(initial.spec, 'replace');
    }
  }, [initial, start]);

  // Кнопки «Назад»/«Вперёд» браузера: восстанавливаем результат из памяти или запускаем поиск из адресной строки.
  useEffect(() => {
    const onPop = () => {
      try {
        const t = new URLSearchParams(window.location.search).get('tab');
        if (t === 'wallets' || t === 'bundle') return;
      } catch {
        /* ignore */
      }
      const spec = parseSpec(window.location.search);
      handle.current?.cancel();
      runId.current++;
      if (!spec) {
        setView(null);
        setSelection(null);
        setRun({ status: 'idle' });
        setNav({ trail: [], pos: 0 });
        return;
      }
      const key = specKey(spec);
      const { trail, pos } = navRef.current;
      const order = [pos - 1, pos + 1, ...trail.map((_, i) => i)];
      const idx = order.find((i) => trail[i]?.key === key);
      const cached = cache.current.get(key);
      const newPos = idx ?? 0;
      const newTrail = idx == null ? [{ key, label: cached ? viewLabel(cached) : spec.mode === 'single' ? shortAddr(spec.address) : `${shortAddr(spec.a)} ⇄ ${shortAddr(spec.b)}` }] : trail;
      setNav({ trail: newTrail, pos: newPos });
      if (cached) show(cached);
      else start(spec, 'none');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [setNav, show, start]);

  useEffect(() => () => handle.current?.cancel(), []);

  const data = view ? (view.kind === 'single' ? view.result : view.link) : null;
  const highlight = useMemo(() => computeHighlight(data, selection), [data, selection]);
  const running = run.status === 'running';
  const idleOrDone = (): Run => (viewRef.current ? { status: 'done' } : { status: 'idle' });

  /** Выбор из панели «Связи»: на телефоне сразу показываем карту с подсветкой и таблицей переводов. */
  const selectFromPanel = useCallback(
    (sel: Selection) => {
      setSelection(sel);
      if (sel && narrow) {
        setMobileTab('map');
        setResetKey((k) => k + 1);
      }
    },
    [narrow],
  );
  const switchTab = (t: 'map' | 'list') => {
    setMobileTab(t);
    // Карта строилась, пока была скрыта, — после показа подгоняем вид.
    if (t === 'map') setResetKey((k) => k + 1);
  };

  const onSelectNode = useCallback((id: string) => setSelection({ kind: 'node', id }), []);
  const onSelectEdge = useCallback((id: string) => setSelection({ kind: 'edge', id }), []);
  const onClear = useCallback(() => setSelection(null), []);

  const goTo = (i: number) => {
    const d = i - navRef.current.pos;
    if (d !== 0) window.history.go(d);
  };

  return (
    <div className="app">
      <TopBar
        tab={tab}
        setTab={setTab}
        mode={mode}
        setMode={setMode}
        address={address}
        setAddress={setAddress}
        depth={depth}
        setDepth={setDepth}
        addrA={addrA}
        setAddrA={setAddrA}
        addrB={addrB}
        setAddrB={setAddrB}
        hops={hops}
        setHops={setHops}
        running={running}
        onSubmit={submit}
        status={status}
        statusError={statusError}
        onImport={() => setImportOpen(true)}
        mock={isMock}
        history={history}
        onPickHistory={restore}
        onClearHistory={onClearHistory}
        collapseKey={running ? 'run' : view?.key ?? ''}
      />

      {nav.trail.length > 1 && (
        <nav className="crumbs" hidden={tab !== 'search'} aria-label="Цепочка поиска">
          <button type="button" className="btn small" disabled={nav.pos === 0} onClick={() => goTo(nav.pos - 1)}>
            ← Назад
          </button>
          <ol>
            {nav.trail.map((t, i) => (
              <li key={i} className={i === nav.pos ? 'cur' : i > nav.pos ? 'fwd' : ''}>
                {i > 0 && <span className="sep">›</span>}
                {i === nav.pos ? (
                  <span title={t.label}>{t.label}</span>
                ) : (
                  <button type="button" className="crumb" onClick={() => goTo(i)} title={t.label}>
                    {t.label}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}

      {data && (
        <div className="mtabs" role="tablist" aria-label="Раздел" hidden={tab !== 'search'}>
          <button type="button" role="tab" aria-selected={mobileTab === 'map'} className={mobileTab === 'map' ? 'on' : ''} onClick={() => switchTab('map')}>
            Карта
          </button>
          <button type="button" role="tab" aria-selected={mobileTab === 'list'} className={mobileTab === 'list' ? 'on' : ''} onClick={() => switchTab('list')}>
            Связи
          </button>
        </div>
      )}

      {walletsOpened && <WalletsTab active={tab === 'wallets'} onSearch={onPivot} />}
      {bundleOpened && <BundleTab active={tab === 'bundle'} onSearch={onPivot} />}

      <main hidden={tab !== 'search'} className={'main' + (panelOpen ? '' : ' panel-closed') + (mobileTab === 'list' ? ' tab-list' : ' tab-map')}>
        <section className="map">
          <GraphView
            graph={data}
            highlight={highlight}
            resetKey={resetKey}
            onSelectNode={onSelectNode}
            onSelectEdge={onSelectEdge}
            onClear={onClear}
          />

          {!data && run.status === 'idle' && (
            <div className="overlay center">
              <div className="intro">
                <h2>Найдите скрытые связи кошелька</h2>
                <p>
                  Вставьте адрес любого кошелька Solana в поле сверху и нажмите «Найти связи». Режим «Два кошелька» проверяет, связаны ли между собой два произвольных адреса. Сервис проверит, как он связан с
                  кошельками из вашего списка Axiom: прямые переводы, общий источник пополнения, общие посредники и цепочка
                  финансирования. Карта покажет кошелёк в центре и связанных с ним людей вокруг, а справа — список связей и
                  транзакции, на которых они основаны.
                </p>
              </div>
            </div>
          )}

          {running && (
            <div className="overlay center blocking">
              <div className="progress-card">
                <div className="pc-head">
                  <span className="spinner" />
                  <b>{run.kind === 'pair' ? 'Ищу связь между кошельками' : 'Анализирую кошелёк'}</b>
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
                      setRun(idleOrDone());
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
                  <b>{run.kind === 'pair' ? 'Не удалось проверить связь' : 'Не удалось выполнить анализ'}</b>
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
                  <button type="button" className="btn" onClick={() => setRun(idleOrDone())}>
                    Закрыть
                  </button>
                  <button type="button" className="btn primary" onClick={run.retry}>
                    Повторить
                  </button>
                </div>
              </div>
            </div>
          )}

          {data && (
            <>
              <div className="map-tools">
                <button type="button" className="btn small" onClick={() => setResetKey((k) => k + 1)}>
                  Сбросить вид
                </button>
              </div>
              <Legend nodes={data.nodes.map((n) => n.kind)} />
            </>
          )}

          {data && selection && (
            <Drawer result={data} selection={selection} onSelect={setSelection} onClose={() => setSelection(null)} onPivot={onPivot} />
          )}

          <button
            type="button"
            className="panel-toggle"
            onClick={() => setPanelOpen((o) => !o)}
            title={panelOpen ? 'Свернуть панель' : 'Показать панель'}
          >
            {panelOpen ? '»' : '«'}
          </button>
        </section>

        <aside className="panel">
          {view?.kind === 'single' ? (
            <SidePanel result={view.result} selection={selection} onSelect={selectFromPanel} onPivot={onPivot} />
          ) : view?.kind === 'pair' ? (
            <LinkPanel link={view.link} selection={selection} onSelect={selectFromPanel} />
          ) : (
            <div className="panel-body">
              <div className="empty">
                <div className="empty-title">Связи появятся здесь</div>
                <p>После поиска здесь будет список имён из вашего списка, сгруппированных по людям и отсортированных по силе связи.</p>
              </div>
            </div>
          )}
        </aside>
      </main>

      <footer className="footer" hidden={tab !== 'search'}>
        {data ? (
          <>
            <span>Провайдер: <b>{data.stats.provider}</b></span>
            <span>Переводов загружено: <b>{data.stats.transfersLoaded}</b></span>
            <span>Кошельков запрошено: <b>{data.stats.walletsFetched}</b></span>
            <span>Вызовов API: <b>{data.stats.apiCalls}</b></span>
            <span>Кредитов (оценка): <b>{data.stats.creditsEstimate}</b></span>
            <span>Время: <b>{fmtDuration(data.stats.durationMs)}</b></span>
            {data.stats.truncated && (
              <span className="trunc">История загружена не полностью: упёрлись в лимит переводов</span>
            )}
          </>
        ) : (
          <span className="muted">Данные берутся из блокчейна Solana; история кошелька кэшируется на сервере.</span>
        )}
      </footer>

      {importOpen && <ImportModal onClose={() => setImportOpen(false)} onImported={refreshStatus} />}
    </div>
  );
}
