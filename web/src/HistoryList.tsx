import { useEffect, useRef } from 'react';
import { fmtHistoryTime, modeText, type HistoryEntry } from './history.ts';

interface Props {
  items: HistoryEntry[];
  /** Подсвеченная клавиатурой запись (-1 — нет). */
  active?: number;
  onPick: (e: HistoryEntry) => void;
  onClear: () => void;
}

/** Список последних поисков с кнопкой очистки; используется и под полем ввода, и в меню «История». */
export function HistoryList({ items, active = -1, onPick, onClear }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active >= 0) ref.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  if (items.length === 0) return <div className="pop-empty muted">История пуста: здесь появятся последние поиски.</div>;
  return (
    <div className="pop-list" ref={ref} role="listbox" aria-label="История поисков">
      {items.map((e, i) => (
        <div
          key={e.key}
          data-i={i}
          role="option"
          aria-selected={i === active}
          className={'pop-item hist-item' + (i === active ? ' active' : '')}
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={() => onPick(e)}
        >
          <div className="hist-main">
            <b className="hist-label">{e.label}</b>
            <span className="hist-top">{e.top}</span>
          </div>
          <div className="hist-sub muted">
            {modeText(e.spec)} · {fmtHistoryTime(e.time)}
          </div>
        </div>
      ))}
      <button type="button" className="pop-foot-btn" onMouseDown={(ev) => ev.preventDefault()} onClick={onClear}>
        Очистить историю
      </button>
    </div>
  );
}
