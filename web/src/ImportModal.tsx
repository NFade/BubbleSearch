import { useEffect, useRef, useState } from 'react';
import { importTracked } from './api.ts';
import { plural } from './util.ts';

export function ImportModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ imported: number; entityCount: number } | null>(null);
  const [fileName, setFileName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const submit = async () => {
    setErr(null);
    setDone(null);
    const t = text.trim();
    if (!t) {
      setErr('Вставьте JSON или выберите файл.');
      return;
    }
    try {
      const parsed: unknown = JSON.parse(t);
      if (!Array.isArray(parsed)) throw new Error('shape');
    } catch {
      setErr('Это не похоже на экспорт Axiom: ожидается JSON-массив объектов с полем trackedWalletAddress.');
      return;
    }
    setBusy(true);
    try {
      const r = await importTracked(t);
      setDone(r);
      onImported();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Импорт списка">
        <div className="modal-head">
          <b>Импорт списка отслеживаемых кошельков</b>
          <button type="button" className="icon-btn big" onClick={onClose} title="Закрыть">
            ✕
          </button>
        </div>
        <p className="muted">
          Вставьте JSON-экспорт отслеживаемых кошельков из Axiom или выберите .json файл. Текущий список будет обновлён.
        </p>
        <div className="file-row">
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setFileName(f.name);
              void f.text().then((t) => {
                setText(t);
                setDone(null);
                setErr(null);
              });
            }}
          />
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
            Выбрать файл…
          </button>
          <span className="muted">{fileName}</span>
        </div>
        <textarea
          className="mono import-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='[{"trackedWalletAddress": "…", "name": "…", "emoji": "…", "groups": []}]'
          spellCheck={false}
        />
        {err && <div className="error-box">{err}</div>}
        {done && (
          <div className="ok-box">
            Импортировано {done.imported} {plural(done.imported, ['кошелёк', 'кошелька', 'кошельков'])} ·{' '}
            {done.entityCount} {plural(done.entityCount, ['имя', 'имени', 'имён'])}
          </div>
        )}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            {done ? 'Закрыть' : 'Отмена'}
          </button>
          <button type="button" className="btn primary" disabled={busy || !text.trim()} onClick={() => void submit()}>
            {busy ? 'Импортирую…' : 'Импортировать'}
          </button>
        </div>
      </div>
    </div>
  );
}
