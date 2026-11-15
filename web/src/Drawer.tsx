import { useMemo, useState } from 'react';
import type { TransferRecord } from '../../shared/types.ts';
import { CopyButton } from './ui.tsx';
import {
  coBuyCounts,
  connectionOf,
  isCoBuyOnly,
  isFeeOnly,
  plural,
  edgesForSelection,
  fmtAmount,
  fmtSol,
  fmtTime,
  isGroup,
  isLink,
  asSingle,
  siblingsOf,
  SIGNAL_LABELS,
  type ViewData,
  KIND_LABELS,
  scoreLabel,
  shortAddr,
  solscanAcc,
  solscanTx,
  TYPE_LABELS,
  type Selection,
} from './util.ts';

interface Props {
  result: ViewData;
  selection: NonNullable<Selection>;
  onSelect: (s: Selection) => void;
  onClose: () => void;
  onPivot: (address: string, label?: string) => void;
}

type SortKey = 'time' | 'amount';

export function Drawer({ result, selection, onSelect, onClose, onPivot }: Props) {
  const link = isLink(result);
  const group = isGroup(result);
  const single = asSingle(result);
  const centre = single ? single.target : null;
  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of result.nodes) {
      if (n.kind === 'tracked') m.set(n.id, `${n.emoji ?? ''} ${n.label}`.trim());
      else if (n.hubLabel) m.set(n.id, n.hubLabel);
      else if (n.kind === 'target') m.set(n.id, group ? `${n.emoji ?? ''} ${n.label}`.trim() : link ? 'Кошелёк A' : 'Цель');
      else if (n.kind === 'pair') m.set(n.id, 'Кошелёк B');
    }
    return m;
  }, [result, link, group]);
  const nm = (a: string) => nameOf.get(a);

  let title: React.ReactNode = null;
  let body: React.ReactNode = null;

  if (selection.kind === 'node') {
    const n = result.nodes.find((x) => x.id === selection.id);
    const inc = result.edges.filter((e) => e.source === selection.id || e.target === selection.id);
    title = (
      <>
        <span className="d-kind">{n ? KIND_LABELS[n.kind] : 'Узел'}</span>
        <b>{n ? `${n.emoji ? n.emoji + ' ' : ''}${n.hubLabel ?? n.label}` : shortAddr(selection.id)}</b>
      </>
    );
    body = (
      <div className="d-node">
        <div className="d-meta">
          <span className="mono full-addr">{selection.id}</span>
          <CopyButton text={selection.id} />
          <a className="link" href={solscanAcc(selection.id)} target="_blank" rel="noreferrer noopener">
            Solscan ↗
          </a>
          {n?.score != null && (
            <span className="muted">
              Сила связи: {Math.round(n.score * 100)}% ({scoreLabel(n.score)})
            </span>
          )}
          {n && <span className="muted">Объём: {fmtSol(n.volumeSol)} SOL</span>}
          {n?.depositOf && <span className="dep-note">Депозитный адрес биржи: {n.depositOf}</span>}
          {n && n.kind !== 'hub' && n.id !== centre && (
            <button type="button" className="btn small primary" onClick={() => onPivot(n.id, n.kind === 'tracked' || group ? n.label : undefined)}>
              Искать связи этого кошелька
            </button>
          )}
          {n?.groups && n.groups.length > 0 && <span className="muted">Группы: {n.groups.join(', ')}</span>}
        </div>
        <table className="tbl">
          <thead>
            <tr>
              <th>Контрагент</th>
              <th className="num">→ от узла</th>
              <th className="num">← к узлу</th>
              <th className="num">Переводов</th>
              <th>Последний</th>
            </tr>
          </thead>
          <tbody>
            {inc.map((e) => {
              const other = e.source === selection.id ? e.target : e.source;
              const out = e.source === selection.id ? e.solForward : e.solBackward;
              const back = e.source === selection.id ? e.solBackward : e.solForward;
              return (
                <tr key={e.id} className="clickable" onClick={() => onSelect({ kind: 'edge', id: e.id })}>
                  <td>
                    {nm(other) && <span className="addr-name">{nm(other)} </span>}
                    <span className="mono">{shortAddr(other)}</span>
                    {e.fundingOf && <span className="tag t-fund"> пополнение</span>}
                    {e.coBuy && <span className="tag t-co-buy">{isCoBuyOnly(e) ? ' совм. покупки' : ' + совм. покупки'}</span>}
                  </td>
                  <td className="num">{fmtSol(out)} SOL</td>
                  <td className="num">{fmtSol(back)} SOL</td>
                  <td className="num">
                    {e.transferCount}
                    {e.tokenTransferCount ? ` (+${e.tokenTransferCount} токен.)` : ''}
                  </td>
                  <td>{fmtTime(e.lastTime)}</td>
                </tr>
              );
            })}
            {inc.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  Нет рёбер
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  } else {
    const edges = edgesForSelection(result, selection);
    const rows: TransferRecord[] = [];
    const seen = new Set<string>();
    for (const e of edges) for (const t of e.transfers) if (!seen.has(t.signature + t.from + t.to + t.amount)) {
      seen.add(t.signature + t.from + t.to + t.amount);
      rows.push(t);
    }
    if (selection.kind === 'edge') {
      const e = edges[0];
      title = (
        <>
          <span className="d-kind">Ребро</span>
          <b>
            {e ? `${nm(e.source) ?? shortAddr(e.source)} ⇄ ${nm(e.target) ?? shortAddr(e.target)}` : '—'}
          </b>
          {e && !isFeeOnly(e) && (
            <span className="muted">
              {fmtSol(e.solForward)} / {fmtSol(e.solBackward)} SOL
            </span>
          )}
        </>
      );
    } else {
      const c = single ? connectionOf(single, selection.kind === 'connection' || selection.kind === 'path' ? selection.wallet : '') : undefined;
      const p = selection.kind === 'path' && c ? c.paths[selection.index] : null;
      const gl = selection.kind === 'grouplink' && group ? result.links[selection.index] : null;
      title = gl ? (
        <>
          <span className="d-kind">{TYPE_LABELS[gl.type] ?? 'Связь'}</span>
          <b>
            {nm(gl.a) ?? shortAddr(gl.a)} ⇄ {nm(gl.b) ?? shortAddr(gl.b)}
          </b>
          <span className="muted">{gl.reason}</span>
        </>
      ) : selection.kind === 'sibling' && single ? (
        <>
          <span className="d-kind">Вероятно, тот же владелец</span>
          <b className="mono">{shortAddr(selection.address)}</b>
          <span className="muted">
            {siblingsOf(single!).find((x) => x.address === selection.address)?.signals.map((g) => SIGNAL_LABELS[g]).join(' · ')}
          </span>
        </>
      ) : selection.kind === 'linkpath' && link ? (
        <>
          <span className="d-kind">{TYPE_LABELS[result.paths[selection.index]?.type ?? ''] ?? 'Путь'}</span>
          <b>Путь {selection.index + 1}</b>
          <span className="muted">{result.paths[selection.index]?.reason}</span>
        </>
      ) : (
        <>
          <span className="d-kind">{p ? TYPE_LABELS[p.type] : 'Связь'}</span>
          <b>{c ? `${c.wallet.emoji} ${c.wallet.name}` : selection.kind === 'connection' || selection.kind === 'path' ? shortAddr(selection.wallet) : '—'}</b>
          {p && <span className="muted">{p.reason}</span>}
        </>
      );
    }
    const coBuyEdges = edges.filter((e) => !!e.coBuy);
    const feeEdges = edges.filter((e) => !!e.feesPaid);
    const feeOnly = edges.length > 0 && edges.every(isFeeOnly);
    body = (
      <>
        {feeEdges.length > 0 && (
          <div className="fee-note">
            {feeEdges.map((e) => {
              const f = e.feesPaid!;
              const other = f.payer === e.source ? e.target : e.source;
              return (
                <div key={e.id}>
                  <b>{nm(f.payer) ?? shortAddr(f.payer)}</b> оплачивал комиссии за {f.txCount}{' '}
                  {plural(f.txCount, ['транзакцию', 'транзакции', 'транзакций'])} <b>{nm(other) ?? shortAddr(other)}</b> (из последних 100) — так обычно делают
                  со своими кошельками.
                </div>
              );
            })}
          </div>
        )}
        {coBuyEdges.length > 0 && (
          <div className="cobuy-note">
            {coBuyEdges.map((e) => (
              <div key={e.id}>
                <b>Совместные покупки.</b>{' '}
                {coBuyEdges.length > 1 && (
                  <span className="muted">
                    {nm(e.source) ?? shortAddr(e.source)} ⇄ {nm(e.target) ?? shortAddr(e.target)}:{' '}
                  </span>
                )}
                Покупали одни и те же токены в одном слоте: {coBuyCounts(e.coBuy!)} — так обычно работают бандлы одного владельца.
                {isCoBuyOnly(e) ? ' Переводов между этими кошельками нет.' : ''}
              </div>
            ))}
          </div>
        )}
        {!(feeOnly && rows.length === 0) && <TransferTable rows={rows} nm={nm} />}
      </>
    );
  }

  return (
    <div className="drawer">
      <div className="drawer-head">
        <div className="d-title">{title}</div>
        <button type="button" className="icon-btn big" onClick={onClose} title="Закрыть">
          ✕
        </button>
      </div>
      <div className="drawer-body">{body}</div>
    </div>
  );
}

function TransferTable({ rows, nm }: { rows: TransferRecord[]; nm: (a: string) => string | undefined }) {
  const [key, setKey] = useState<SortKey>('time');
  const [dir, setDir] = useState<1 | -1>(-1);
  const sorted = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      const va = key === 'time' ? a.blockTime ?? 0 : a.amount;
      const vb = key === 'time' ? b.blockTime ?? 0 : b.amount;
      return (va - vb) * dir;
    });
    return arr;
  }, [rows, key, dir]);
  const th = (k: SortKey, label: string, cls = '') => (
    <th className={'sortable ' + cls} onClick={() => (k === key ? setDir((d) => (d === 1 ? -1 : 1)) : (setKey(k), setDir(-1)))}>
      {label} {k === key ? (dir === -1 ? '▼' : '▲') : ''}
    </th>
  );
  const who = (a: string) => (
    <span title={a}>
      {nm(a) && <span className="addr-name">{nm(a)} </span>}
      <span className="mono">{shortAddr(a)}</span>
    </span>
  );
  return (
    <table className="tbl">
      <thead>
        <tr>
          {th('time', 'Время')}
          <th>Откуда → Куда</th>
          {th('amount', 'Сумма', 'num')}
          <th>Транзакция</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((t, i) => (
          <tr key={t.signature + i}>
            <td className="nowrap">{fmtTime(t.blockTime)}</td>
            <td>
              {who(t.from)} <span className="muted">→</span> {who(t.to)}
              {t.coBuy && (
                <span className="tag t-co-buy" title="Покупка токена: пул → кошелёк. Это не перевод между кошельками ребра.">
                  {' '}
                  покупка
                </span>
              )}
            </td>
            <td className="num nowrap">
              {fmtAmount(t.amount)} {t.symbol}
            </td>
            <td>
              <a className="link mono" href={solscanTx(t.signature)} target="_blank" rel="noreferrer noopener" title={t.signature}>
                {t.signature.slice(0, 6)}…{t.signature.slice(-4)} ↗
              </a>
            </td>
          </tr>
        ))}
        {sorted.length === 0 && (
          <tr>
            <td colSpan={4} className="muted">
              Нет переводов для отображения
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

