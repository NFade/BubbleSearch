import { useEffect, useMemo, useRef, useState } from 'react';
import type { TrackedWallet } from '../../shared/types.ts';
import { getTracked } from './api.ts';
import { HistoryList } from './HistoryList.tsx';
import type { HistoryEntry } from './history.ts';
import { isValidAddress, shortAddr } from './util.ts';

const MAX_SUGGEST = 50;

/** Поиск по имени среди кошельков списка: сначала имена, начинающиеся с запроса, затем содержащие его. */
export function matchTracked(list: TrackedWallet[], query: string): TrackedWallet[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const scored: { w: TrackedWallet; rank: number }[] = [];
  for (const w of list) {
    const n = w.name.toLowerCase();
    const en = w.entityName.toLowerCase();
    let rank = -1;
    if (n.startsWith(q)) rank = 0;
    else if (en.startsWith(q)) rank = 1;
    else if (n.includes(q)) rank = 2;
    else if (en.includes(q)) rank = 3;
    if (rank >= 0) scored.push({ w, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.w.name.localeCompare(b.w.name, 'ru') || a.w.address.localeCompare(b.w.address));
  return scored.slice(0, MAX_SUGGEST).map((x) => x.w);
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
  history: HistoryEntry[];
  onPickHistory: (e: HistoryEntry) => void;
  onClearHistory: () => void;
}

/** Поле адреса: принимает адрес или имя из списка (подсказки), а в пустом виде показывает историю поисков. */
export function AddrInput({ value, onChange, placeholder, label, history, onPickHistory, onClearHistory }: Props) {
  const [focus, setFocus] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [tracked, setTracked] = useState<TrackedWallet[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const q = value.trim();
  const nameMode = q.length >= 2 && !isValidAddress(q);
  const histMode = q === '';

  useEffect(() => {
    if (!nameMode || tracked || !focus) return;
    let alive = true;
    getTracked()
      .then((l) => alive && (setTracked(l), setLoadFailed(false)))
      .catch(() => alive && setLoadFailed(true));
    return () => {
      alive = false;
    };
  }, [nameMode, tracked, focus]);

  const matches = useMemo(() => (nameMode && tracked ? matchTracked(tracked, q) : []), [nameMode, tracked, q]);
  const open = focus && !dismissed && ((histMode && history.length > 0) || nameMode);
  const count = histMode ? history.length : matches.length;

  useEffect(() => {
    setActive(histMode ? -1 : 0);
  }, [q, histMode]);
  useEffect(() => {
    if (open && !histMode && active >= 0) listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, histMode]);

  const choose = (w: TrackedWallet) => {
    onChange(w.address);
    setDismissed(true);
  };
  const showErr = q.length > 0 && !isValidAddress(q) && !(nameMode && (matches.length > 0 || !tracked));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        setDismissed(true);
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) {
        if ((histMode && history.length > 0) || nameMode) {
          e.preventDefault();
          setDismissed(false);
        }
        return;
      }
      if (count === 0) return;
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (a < 0 ? (d === 1 ? 0 : count - 1) : (a + d + count) % count));
      return;
    }
    if (e.key === 'Enter' && open && active >= 0) {
      e.preventDefault();
      if (histMode) {
        const h = history[active];
        if (h) {
          setDismissed(true);
          onPickHistory(h);
        }
      } else {
        const w = matches[active];
        if (w) choose(w);
      }
    }
  };

  return (
    <div className="ac-wrap">
      <input
        className={'addr-input mono' + (showErr ? ' invalid' : '')}
        value={value}
        onChange={(e) => {
          setDismissed(false);
          onChange(e.target.value.replace(/^\s+/, ''));
        }}
        onFocus={() => {
          setFocus(true);
          setDismissed(false);
        }}
        onBlur={() => setFocus(false)}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          // Адрес с пробелами или переносами строки чистим; текст с пробелами в середине считаем именем и не трогаем.
          const t = e.clipboardData.getData('text').trim();
          const compact = t.replace(/\s+/g, '');
          if (t && isValidAddress(compact)) {
            e.preventDefault();
            onChange(compact);
          }
        }}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-label={label}
        title={showErr ? 'Нужен адрес в base58 (32–44 символа) или имя из списка' : undefined}
      />
      {open && histMode && (
        <div className="ac-pop">
          <HistoryList
            items={history}
            active={active}
            onPick={(e) => {
              setDismissed(true);
              onPickHistory(e);
            }}
            onClear={onClearHistory}
          />
        </div>
      )}
      {open && nameMode && (
        <div className="ac-pop">
          {!tracked ? (
            <div className="pop-empty muted">{loadFailed ? 'Не удалось загрузить список имён.' : 'Загружаю список…'}</div>
          ) : matches.length === 0 ? (
            <div className="pop-empty muted">В списке нет имени «{q}». Вставьте адрес кошелька.</div>
          ) : (
            <div className="pop-list" ref={listRef} role="listbox" aria-label="Кошельки из списка">
              {matches.map((w, i) => (
                <div
                  key={w.address}
                  data-i={i}
                  role="option"
                  aria-selected={i === active}
                  className={'pop-item sug-item' + (i === active ? ' active' : '')}
                  onMouseDown={(ev) => ev.preventDefault()}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => choose(w)}
                >
                  <span className="emoji">{w.emoji}</span>
                  <b className="sug-name">{w.name}</b>
                  <span className="mono muted sug-addr">{shortAddr(w.address)}</span>
                  {w.groups.length > 0 && (
                    <span className="sug-groups">
                      {w.groups.map((g) => (
                        <span key={g} className="sig-chip">
                          {g}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
