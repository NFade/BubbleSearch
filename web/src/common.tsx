import { useEffect, useState } from 'react';
import type { NodeKind } from '../../shared/types.ts';
import { clusterColor, KIND_COLORS, KIND_LABELS } from './util.ts';

export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  return <>{((now - since) / 1000).toFixed(1)} с</>;
}

const LEGEND_ORDER: NodeKind[] = ['target', 'pair', 'tracked', 'sibling', 'intermediary', 'funder', 'hub', 'other'];

export function Legend({ nodes, clusters = 0 }: { nodes: NodeKind[]; clusters?: number }) {
  const [open, setOpen] = useState(() => window.innerWidth >= 1200);
  const present = new Set(nodes);
  return (
    <div className="legend">
      <button type="button" className="legend-head" onClick={() => setOpen((o) => !o)}>
        Легенда {open ? '▾' : '▸'}
      </button>
      {open && (
        <div className="legend-body">
          {clusters > 0 && (
            <div className="lg-row">
              Цвет выбранных — кластер:
              {Array.from({ length: Math.min(clusters, 10) }, (_, i) => (
                <span key={i} className="lg-dot" style={{ background: clusterColor(i) }} title={`Кластер ${i + 1}`} />
              ))}
            </div>
          )}
          {LEGEND_ORDER.filter((k) => (present.has(k) && !(clusters > 0 && k === 'target')) || (k === 'target' && clusters === 0)).map((k) => (
            <div key={k} className="lg-row">
              <span className="lg-dot" style={{ background: KIND_COLORS[k] }} />
              {KIND_LABELS[k]}
              {k === 'tracked' && <span className="muted"> (цвет — по имени)</span>}
              {k === 'hub' && <span className="muted"> (🏦 биржа, ⚙ инфраструктура)</span>}
            </div>
          ))}
          <div className="lg-row">
            <span className="lg-dep">⇥</span> Депозитный адрес биржи
          </div>
          <div className="lg-row">
            <span className="lg-line" /> Переводы · толщина — объём SOL
          </div>
          <div className="lg-row">
            <span className="lg-line">
              <i>▶</i>
            </span>{' '}
            Стрелка — SOL шёл в одну сторону
          </div>
          <div className="lg-row">
            <span className="lg-line cobuy" /> Совместные покупки (без переводов)
          </div>
          <div className="lg-row">
            <span className="lg-line fee" /> Оплата комиссий (плательщик → за кого)
          </div>
          <div className="lg-row">
            <span className="lg-line fund" /> Первое пополнение (от кого → кому)
          </div>
          <div className="lg-row muted">Размер пузыря — объём SOL</div>
        </div>
      )}
    </div>
  );
}

/** Узкий экран (телефон): панель связей и карта переключаются вкладками. */
export function useNarrow(): boolean {
  const q = '(max-width: 768px)';
  const [n, setN] = useState(() => {
    try {
      return window.matchMedia(q).matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let m: MediaQueryList;
    try {
      m = window.matchMedia(q);
    } catch {
      return;
    }
    const h = () => setN(m.matches);
    m.addEventListener('change', h);
    return () => m.removeEventListener('change', h);
  }, []);
  return n;
}

