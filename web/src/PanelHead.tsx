import { useEffect, useRef, useState } from 'react';
import { exportConnections, exportJson, exportTransfers } from './exportData.ts';
import { copyText, type ViewData } from './util.ts';

function ExportMenu({ data }: { data: ViewData }) {
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
  const run = (f: (d: ViewData) => void) => () => {
    setOpen(false);
    try {
      f(data);
    } catch {
      /* скачивание недоступно в этом браузере */
    }
  };
  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className="btn small" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Экспорт ▾
      </button>
      {open && (
        <div className="menu-pop export-pop" role="menu">
          <button type="button" role="menuitem" className="pop-item" onClick={run(exportJson)}>
            JSON (полный результат)
          </button>
          <button type="button" role="menuitem" className="pop-item" onClick={run(exportConnections)}>
            CSV: связи
          </button>
          <button type="button" role="menuitem" className="pop-item" onClick={run(exportTransfers)}>
            CSV: переводы
          </button>
        </div>
      )}
    </div>
  );
}

/** Шапка панели: заголовок, меню экспорта и текстовая сводка с кнопкой «Копировать». */
export function PanelHead({ data, title, summary }: { data: ViewData; title: string; summary: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <div className="panel-head">
        <span className="panel-title">{title}</span>
        <ExportMenu data={data} />
      </div>
      <div className="text-summary">
        <p>{summary}</p>
        <button
          type="button"
          className="btn small"
          onClick={() => {
            void copyText(summary).then((ok) => {
              if (ok) {
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              }
            });
          }}
        >
          {copied ? 'Скопировано ✓' : 'Копировать'}
        </button>
      </div>
    </>
  );
}
