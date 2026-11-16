import type { Depth, StatusResponse } from '../../shared/types.ts';
import { useEffect, useRef, useState } from 'react';
import { AddrInput as AddrField } from './AddrInput.tsx';
import { HistoryList } from './HistoryList.tsx';
import type { HistoryEntry } from './history.ts';
import { isValidAddress } from './util.ts';

export type Mode = 'single' | 'pair';
export type Tab = 'search' | 'wallets' | 'bundle';
export type Hops = 2 | 3 | 4;

interface Props {
  tab: Tab;
  setTab: (t: Tab) => void;
  mode: Mode;
  setMode: (m: Mode) => void;
  address: string;
  setAddress: (a: string) => void;
  depth: Depth;
  setDepth: (d: Depth) => void;
  addrA: string;
  setAddrA: (a: string) => void;
  addrB: string;
  setAddrB: (a: string) => void;
  hops: Hops;
  setHops: (h: Hops) => void;
  running: boolean;
  onSubmit: () => void;
  status: StatusResponse | null;
  statusError: boolean;
  onImport: () => void;
  mock: boolean;
  history: HistoryEntry[];
  onPickHistory: (e: HistoryEntry) => void;
  onClearHistory: () => void;
  /** Меняется, когда запущен или завершён поиск: на узком экране форма сворачивается. */
  collapseKey: string;
}

/** Кнопка «История» с выпадающим списком последних поисков. */
function HistoryButton({ items, onPick, onClear }: { items: HistoryEntry[]; onPick: (e: HistoryEntry) => void; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
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
      <button type="button" className="btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        История{items.length > 0 ? ` (${items.length})` : ''}
      </button>
      {open && (
        <div className="menu-pop hist-pop">
          <HistoryList
            items={items}
            onPick={(e) => {
              setOpen(false);
              onPick(e);
            }}
            onClear={() => {
              onClear();
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

export function TopBar(p: Props) {
  const { mode, setMode, running, onSubmit, status, statusError, onImport, mock } = p;
  // На узком экране форма сворачивается после запуска поиска; на широком кнопка скрыта и форма всегда видна.
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (p.collapseKey) setOpen(false);
  }, [p.collapseKey]);
  const hist = { history: p.history, onPickHistory: p.onPickHistory, onClearHistory: p.onClearHistory };
  const valid =
    mode === 'single'
      ? isValidAddress(p.address.trim())
      : isValidAddress(p.addrA.trim()) && isValidAddress(p.addrB.trim());
  return (
    <header className={'topbar' + (open ? '' : ' collapsed')}>
      <div className="brand">
        <span className="logo" aria-hidden>
          <i />
          <i />
        </span>
        BubbleSearch
        {mock && <span className="mock-badge">демо</span>}
        <button type="button" className="btn small topbar-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          Поиск {open ? '▴' : '▾'}
        </button>
      </div>

      <div className="mode-switch tab-switch" role="tablist" aria-label="Раздел сайта">
        <button type="button" role="tab" aria-selected={p.tab === 'search'} className={p.tab === 'search' ? 'on' : ''} onClick={() => p.setTab('search')}>
          Поиск связей
        </button>
        <button type="button" role="tab" aria-selected={p.tab === 'wallets'} className={p.tab === 'wallets' ? 'on' : ''} onClick={() => p.setTab('wallets')}>
          Кошельки
        </button>
        <button type="button" role="tab" aria-selected={p.tab === 'bundle'} className={p.tab === 'bundle' ? 'on' : ''} onClick={() => p.setTab('bundle')}>
          Бандл
        </button>
      </div>

      <div className="mode-switch" role="tablist" aria-label="Режим поиска" hidden={p.tab !== 'search'}>
        <button type="button" role="tab" aria-selected={mode === 'single'} className={mode === 'single' ? 'on' : ''} onClick={() => setMode('single')}>
          Один кошелёк
        </button>
        <button type="button" role="tab" aria-selected={mode === 'pair'} className={mode === 'pair' ? 'on' : ''} onClick={() => setMode('pair')}>
          Два кошелька
        </button>
      </div>

      <form
        hidden={p.tab !== 'search'}
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !running) onSubmit();
        }}
      >
        {mode === 'single' ? (
          <>
            <AddrField value={p.address} onChange={p.setAddress} placeholder="Адрес кошелька Solana или имя из списка" label="Адрес или имя кошелька" {...hist} />
            <select className="depth" value={p.depth} onChange={(e) => p.setDepth(Number(e.target.value) as Depth)} aria-label="Глубина поиска">
              <option value={1}>1 · Только прямые</option>
              <option value={2}>2 · Через посредников</option>
              <option value={3}>3 · До трёх шагов</option>
            </select>
            <button type="submit" className="btn primary" disabled={!valid || running}>
              {running ? 'Ищу…' : 'Найти связи'}
            </button>
          </>
        ) : (
          <>
            <AddrField value={p.addrA} onChange={p.setAddrA} placeholder="Кошелёк A: адрес или имя" label="Адрес или имя кошелька A" {...hist} />
            <AddrField value={p.addrB} onChange={p.setAddrB} placeholder="Кошелёк B: адрес или имя" label="Адрес или имя кошелька B" {...hist} />
            <select className="depth" value={p.hops} onChange={(e) => p.setHops(Number(e.target.value) as Hops)} aria-label="Максимум шагов">
              <option value={2}>Через одного посредника</option>
              <option value={3}>До 3 шагов</option>
              <option value={4}>До 4 шагов</option>
            </select>
            <button type="submit" className="btn primary" disabled={!valid || running}>
              {running ? 'Проверяю…' : 'Проверить связь'}
            </button>
          </>
        )}
      </form>

      <div className="top-right">
        <div
          className={'chip' + (statusError ? ' err' : status && !status.hasHeliusKey ? ' warn' : '')}
          title={
            status
              ? `${status.providerNote}\nВ кэше проиндексировано: ${status.indexedCount}`
              : statusError
                ? 'Не удалось получить статус сервера'
                : ''
          }
        >
          <span className="dot" />
          {status
            ? `${status.provider} · ${status.trackedCount} кошельков · ${status.entityCount} имён`
            : statusError
              ? 'Сервер недоступен'
              : 'Подключение…'}
        </div>
        <HistoryButton items={p.history} onPick={p.onPickHistory} onClear={p.onClearHistory} />
        <button type="button" className="btn" onClick={onImport}>
          Импорт списка
        </button>
      </div>
    </header>
  );
}
