import { useState } from 'react';
import { copyText, shortAddr, solscanAcc } from './util.ts';

export function CopyButton({ text, title = 'Копировать адрес' }: { text: string; title?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn"
      title={ok ? 'Скопировано' : title}
      onClick={(e) => {
        e.stopPropagation();
        void copyText(text).then((r) => {
          if (r) {
            setOk(true);
            setTimeout(() => setOk(false), 1200);
          }
        });
      }}
    >
      {ok ? '✓' : '⧉'}
    </button>
  );
}

export function AddrChip({ address, label }: { address: string; label?: string }) {
  return (
    <span className="addr-chip">
      {label && <span className="addr-name">{label}</span>}
      <span className="mono addr" title={address}>
        {shortAddr(address)}
      </span>
      <CopyButton text={address} />
      <a
        className="icon-btn"
        href={solscanAcc(address)}
        target="_blank"
        rel="noreferrer noopener"
        title="Открыть в Solscan"
        onClick={(e) => e.stopPropagation()}
      >
        ↗
      </a>
    </span>
  );
}
