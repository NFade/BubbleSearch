import { useEffect, useState } from 'react';
import type { AnalyzeResult, Connection, LinkResult } from '../../shared/types.ts';
import { AddrChip } from './ui.tsx';
import { PanelHead } from './PanelHead.tsx';
import { summarizeLink, summarizeSingle } from './summary.ts';
import {
  fmtSol,
  plural,
  scoreColor,
  scoreLabel,
  shortAddr,
  siblingsOf,
  SIGNAL_LABELS,
  TYPE_LABELS,
  type Selection,
} from './util.ts';

interface Props {
  result: AnalyzeResult;
  selection: Selection;
  onSelect: (s: Selection) => void;
  /** Начать новый поиск, центрированный на этом кошельке. */
  onPivot: (address: string, label?: string) => void;
}

export function PivotButton({ address, label, onPivot }: { address: string; label?: string; onPivot: Props['onPivot'] }) {
  return (
    <button
      type="button"
      className="pivot-btn"
      title="Искать связи этого кошелька"
      onClick={(e) => {
        e.stopPropagation();
        onPivot(address, label);
      }}
    >
      Искать связи ↗
    </button>
  );
}

function ScoreBar({ score }: { score: number }) {
  return (
    <span className="score">
      <span className="bar">
        <span style={{ width: `${Math.max(3, Math.round(score * 100))}%`, background: scoreColor(score) }} />
      </span>
      <span className="score-txt" style={{ color: scoreColor(score) }}>
        {scoreLabel(score)} · {Math.round(score * 100)}%
      </span>
    </span>
  );
}

export function SidePanel({ result, selection, onSelect, onPivot }: Props) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(result.entities.slice(0, 1).map((e) => e.entity)));
  useEffect(() => {
    setOpen(new Set(result.entities.slice(0, 1).map((e) => e.entity)));
  }, [result]);

  const byAddr = new Map<string, Connection>(result.connections.map((c) => [c.wallet.address, c]));
  const nConn = result.connections.length;
  const nEnt = result.entities.length;
  // Сводная оценка имени (несколько кошельков одного человека усиливают друг друга) — та же, что в списке ниже.
  const best = result.entities[0]?.score ?? 0;
  const selWallet = selection && (selection.kind === 'connection' || selection.kind === 'path') ? selection.wallet : null;

  const toggle = (k: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  return (
    <div className="panel-body">
      <PanelHead data={result} title="Результат" summary={summarizeSingle(result)} />
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

      {nConn === 0 ? (
        <div className="empty">
          <div className="empty-title">Связей со списком не найдено</div>
          <p>
            Среди контрагентов этого кошелька нет отслеживаемых адресов и нет общих источников средств. На карте показаны
            его самые заметные контрагенты — попробуйте глубину «До трёх шагов».
          </p>
        </div>
      ) : (
        <>
          <div className="summary">
            <b>{nConn}</b> {plural(nConn, ['связь', 'связи', 'связей'])} с <b>{nEnt}</b>{' '}
            {plural(nEnt, ['именем', 'именами', 'именами'])}
            <span className="muted">
              {' '}
              · сильнейшая {Math.round(best * 100)}% ({scoreLabel(best)})
            </span>
          </div>
          <div className="entity-list">
            {result.entities.map((ent) => {
              const isOpen = open.has(ent.entity);
              return (
                <div key={ent.entity} className={'entity' + (isOpen ? ' open' : '')}>
                  <button type="button" className="entity-head" onClick={() => toggle(ent.entity)}>
                    <span className="chev">{isOpen ? '▾' : '▸'}</span>
                    <span className="emoji">{ent.emoji}</span>
                    <span className="ent-name">{ent.entityName}</span>
                    <span className="muted ent-count">
                      {ent.wallets.length} {plural(ent.wallets.length, ['кошелёк', 'кошелька', 'кошельков'])}
                    </span>
                    <ScoreBar score={ent.score} />
                  </button>
                  {isOpen && (
                    <div className="wallets">
                      {ent.wallets.map((a) => {
                        const c = byAddr.get(a);
                        if (!c) return null;
                        const sel = selWallet === a;
                        return (
                          <div key={a} className={'wallet' + (sel ? ' sel' : '')}>
                            <div
                              className="wallet-head"
                              role="button"
                              tabIndex={0}
                              onClick={() => onSelect(sel && selection?.kind === 'connection' ? null : { kind: 'connection', wallet: a })}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') onSelect({ kind: 'connection', wallet: a });
                              }}
                            >
                              <div className="wallet-line">
                                <span className="emoji">{c.wallet.emoji}</span>
                                <span className="w-name">{c.wallet.name}</span>
                                <AddrChip address={a} />
                                <PivotButton address={a} label={c.wallet.name} onPivot={onPivot} />
                              </div>
                              <div className="wallet-line">
                                <ScoreBar score={c.score} />
                                <span className="muted meta">
                                  {c.hops} {plural(c.hops, ['шаг', 'шага', 'шагов'])} · {fmtSol(c.totalSol)} SOL ·{' '}
                                  {c.transferCount} {plural(c.transferCount, ['перевод', 'перевода', 'переводов'])}
                                </span>
                              </div>
                            </div>
                            <ul className="paths">
                              {c.paths.map((p, i) => {
                                const psel = selection?.kind === 'path' && selection.wallet === a && selection.index === i;
                                return (
                                  <li
                                    key={i}
                                    className={psel ? 'sel' : ''}
                                    onClick={() => onSelect(psel ? { kind: 'connection', wallet: a } : { kind: 'path', wallet: a, index: i })}
                                  >
                                    <span className={`tag t-${p.type}`}>{TYPE_LABELS[p.type] ?? p.type}</span>
                                    <span className="muted"> {Math.round(p.score * 100)}%</span>
                                    <div className="reason">{p.reason}</div>
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      <Siblings result={result} selection={selection} onSelect={onSelect} onPivot={onPivot} />
    </div>
  );
}

function Siblings({ result, selection, onSelect, onPivot }: Props) {
  const list = siblingsOf(result);
  if (list.length === 0) {
    return <div className="muted sib-empty">Других кошельков этого же человека не найдено.</div>;
  }
  return (
    <div className="siblings">
      <div className="sec-title">Вероятно, кошельки этого же человека</div>
      {list.map((s) => {
        const sel = selection?.kind === 'sibling' && selection.address === s.address;
        return (
          <div
            key={s.address}
            className={'sibling' + (sel ? ' sel' : '')}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(sel ? null : { kind: 'sibling', address: s.address })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSelect({ kind: 'sibling', address: s.address });
            }}
          >
            <div className="wallet-line">
              <AddrChip address={s.address} />
              <PivotButton address={s.address} onPivot={onPivot} />
            </div>
            <div className="wallet-line">
              <ScoreBar score={s.score} />
            </div>
            <div className="chips">
              {s.signals.map((g) => (
                <span key={g} className="sig-chip">
                  {SIGNAL_LABELS[g] ?? g}
                </span>
              ))}
            </div>
            <ul className="reasons">
              {s.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

// ---------- Режим «Два кошелька» ----------

interface LinkProps {
  link: LinkResult;
  selection: Selection;
  onSelect: (s: Selection) => void;
}

export function LinkPanel({ link, selection, onSelect }: LinkProps) {
  const nameOf = (addr: string): string => {
    const n = link.nodes.find((x) => x.id === addr);
    if (!n) return shortAddr(addr);
    if (n.kind === 'tracked') return n.label;
    if (n.hubLabel) return n.hubLabel;
    if (addr === link.a) return link.aTracked?.name ?? 'A';
    if (addr === link.b) return link.bTracked?.name ?? 'B';
    return shortAddr(addr);
  };
  const n = link.paths.length;
  return (
    <div className="panel-body">
      <PanelHead data={link} title="Связь двух кошельков" summary={summarizeLink(link)} />
      {link.warnings.length > 0 && (
        <div className="warnings">
          {link.warnings.map((w, i) => (
            <div key={i} className="warning">
              <span className="w-ico">⚠</span>
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      <div className="pair-ends">
        <div className="wallet-line">
          <span className="pair-dot a" /> <b>A</b>
          {link.aTracked && <span className="w-name">{link.aTracked.emoji} {link.aTracked.name}</span>}
          <AddrChip address={link.a} />
        </div>
        <div className="wallet-line">
          <span className="pair-dot b" /> <b>B</b>
          {link.bTracked && <span className="w-name">{link.bTracked.emoji} {link.bTracked.name}</span>}
          <AddrChip address={link.b} />
        </div>
      </div>

      {n === 0 ? (
        <div className="empty">
          <div className="empty-title">Связь не найдена в пределах {link.options.maxHops} шагов</div>
          <p>
            Между этими кошельками нет переводов, общих источников пополнения или общих депозитных адресов биржи. Попробуйте
            увеличить число шагов.
          </p>
        </div>
      ) : (
        <>
          <div className="summary">
            Общая связь: <ScoreBar score={link.score} />
            <div className="muted">
              {n} {plural(n, ['путь', 'пути', 'путей'])}
            </div>
          </div>
          <ul className="paths link-paths">
            {link.paths.map((p, i) => {
              const sel = selection?.kind === 'linkpath' && selection.index === i;
              const hops = p.edgeIds.length;
              return (
                <li key={i} className={sel ? 'sel' : ''} onClick={() => onSelect(sel ? null : { kind: 'linkpath', index: i })}>
                  <span className={`tag t-${p.type}`}>{TYPE_LABELS[p.type] ?? p.type}</span>
                  <span className="muted">
                    {' '}
                    {hops} {plural(hops, ['шаг', 'шага', 'шагов'])} · {Math.round(p.score * 100)}% ({scoreLabel(p.score)})
                  </span>
                  <div className="reason">{p.reason}</div>
                  <div className="chain muted">{p.nodes.map(nameOf).join(' › ')}</div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
