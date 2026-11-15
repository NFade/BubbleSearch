import type { GroupResult } from '../../shared/types.ts';
import { PanelHead } from './PanelHead.tsx';
import { PivotButton } from './SidePanel.tsx';
import { clusterName, summarizeGroup } from './summary.ts';
import { AddrChip } from './ui.tsx';
import { clusterColor, plural, scoreColor, shortAddr, TYPE_LABELS, type Selection } from './util.ts';

interface Props {
  result: GroupResult;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onPivot: (address: string, label?: string) => void;
}

/** Боковая панель карты группы: кластеры, связи между выбранными, внешние связи со списком. */
export function GroupPanel({ result, selection, onSelect, onPivot }: Props) {
  const nameOf = (a: string) => {
    const n = result.nodes.find((x) => x.id === a);
    return n ? `${n.emoji ?? ''} ${n.label}`.trim() : shortAddr(a);
  };
  const clusterIdx = new Map<string, number>();
  result.clusters.forEach((c, i) => c.forEach((a) => clusterIdx.set(a, i)));
  const linkIdx = result.links.map((_, i) => i);
  const selIdx = selection?.kind === 'grouplink' ? selection.index : -1;
  const selNode = selection?.kind === 'node' ? selection.id : null;

  const linkRow = (i: number) => {
    const l = result.links[i]!;
    const sel = selIdx === i;
    return (
      <li key={i} className={sel ? 'sel' : ''} onClick={() => onSelect(sel ? null : { kind: 'grouplink', index: i })}>
        <div>
          <span className={`tag t-${l.type}`}>{TYPE_LABELS[l.type] ?? l.type}</span>
          <span className="muted"> {nameOf(l.a)} ⇄ {nameOf(l.b)} · </span>
          <span style={{ color: scoreColor(l.score) }}>{Math.round(l.score * 100)}%</span>
        </div>
        <div className="reason">{l.reason}</div>
      </li>
    );
  };

  const between = linkIdx.filter((i) => clusterIdx.get(result.links[i]!.a) !== clusterIdx.get(result.links[i]!.b));

  return (
    <div className="panel-body">
      <PanelHead data={result} title="Баблы группы" summary={summarizeGroup(result)} />
      {result.warnings.length > 0 && (
        <div className="warnings">
          {result.warnings.map((w, i) => (
            <div key={i} className="warning">
              <span className="w-ico">⚠</span>
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      <div className="sec-title">Кластеры</div>
      <div className="entity-list">
        {result.clusters.map((c, ci) => {
          const inner = linkIdx.filter((i) => c.includes(result.links[i]!.a) && c.includes(result.links[i]!.b));
          return (
            <div key={ci} className="entity open" style={{ borderLeft: `3px solid ${clusterColor(ci)}` }}>
              <div className="cl-head">
                <span className="lg-dot" style={{ background: clusterColor(ci) }} />
                <b>{clusterName(result, c)}</b>
                <span className="muted">
                  {c.length} {plural(c.length, ['кошелёк', 'кошелька', 'кошельков'])}
                </span>
              </div>
              <div className="cl-members">
                {c.map((a) => (
                  <button key={a} type="button" className={'cl-member' + (selNode === a ? ' sel' : '')} onClick={() => onSelect(selNode === a ? null : { kind: 'node', id: a })}>
                    {nameOf(a)}
                  </button>
                ))}
              </div>
              {inner.length > 0 ? (
                <ul className="paths">{inner.map(linkRow)}</ul>
              ) : (
                <div className="muted cl-note">{c.length > 1 ? 'Внутри кластера нет отдельных связей.' : 'Нет связей с другими выбранными кошельками (score ≥ 50%).'}</div>
              )}
            </div>
          );
        })}
      </div>

      {between.length > 0 && (
        <>
          <div className="sec-title">Слабые связи между кластерами</div>
          <ul className="paths">{between.map(linkRow)}</ul>
        </>
      )}

      <div className="sec-title">Связи со списком (не выбранные)</div>
      {result.external.length === 0 ? (
        <div className="muted sib-empty">Связей выбранных кошельков с другими кошельками списка не найдено.</div>
      ) : (
        <div className="siblings">
          {result.external.map((x, i) => (
            <div key={i} className={'sibling' + (selNode === x.wallet.address ? ' sel' : '')} role="button" tabIndex={0} onClick={() => onSelect({ kind: 'node', id: x.wallet.address })}>
              <div className="wallet-line">
                <span className="emoji">{x.wallet.emoji}</span>
                <span className="w-name">{x.wallet.name}</span>
                <AddrChip address={x.wallet.address} />
                <PivotButton address={x.wallet.address} label={x.wallet.name} onPivot={onPivot} />
              </div>
              <div className="wallet-line">
                <span className={`tag t-${x.type}`}>{TYPE_LABELS[x.type] ?? x.type}</span>
                <span style={{ color: scoreColor(x.score) }}>{Math.round(x.score * 100)}%</span>
                <span className="muted">с {nameOf(x.from)}</span>
              </div>
              <div className="reason">{x.reason}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
