import { useEffect, useRef, useState } from 'react';
import { select } from 'd3-selection';
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';
import { zoom, zoomIdentity } from 'd3-zoom';
import { drag } from 'd3-drag';
import { scaleLog, scaleSqrt } from 'd3-scale';
import type { GraphEdge, GraphNode } from '../../shared/types.ts';
import {
  clusterColor,
  coBuyText,
  entityColor,
  fmtSol,
  isCoBuyOnly,
  isExchangeHub,
  isFeeOnly,
  KIND_COLORS,
  KIND_LABELS,
  plural,
  scoreLabel,
  shortAddr,
  type Highlight,
} from './util.ts';

interface SimNode extends SimulationNodeDatum {
  id: string;
  data: GraphNode;
  r: number;
}
interface SimLink extends SimulationLinkDatum<SimNode> {
  data: GraphEdge;
  width: number;
}

type Hover = { kind: 'node'; node: GraphNode; x: number; y: number } | { kind: 'edge'; edge: GraphEdge; x: number; y: number } | null;

/** Граф для карты: центры — узлы target и (в режиме «Два кошелька») pair. */
export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface Props {
  graph: GraphData | null;
  highlight: Highlight | null;
  resetKey: number;
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
  onClear: () => void;
}

function nodeColor(n: GraphNode): string {
  if (n.cluster != null) return clusterColor(n.cluster);
  return n.kind === 'tracked' && n.entity ? entityColor(n.entity) : KIND_COLORS[n.kind];
}

export function GraphView({ graph, highlight, resetKey, onSelectNode, onSelectEdge, onClear }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover>(null);

  const cb = useRef({ onSelectNode, onSelectEdge, onClear });
  cb.current = { onSelectNode, onSelectEdge, onClear };
  const hlRef = useRef<Highlight | null>(highlight);
  hlRef.current = highlight;
  const applyRef = useRef<((h: Highlight | null) => void) | null>(null);
  const resetRef = useRef<(() => void) | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const lastReset = useRef(resetKey);

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const svg = select(svgEl);
    svg.selectAll('*').remove();
    applyRef.current = null;
    resetRef.current = null;
    fitRef.current = null;
    setHover(null);
    if (!graph) return;

    const ids = new Set(graph.nodes.map((n) => n.id));
    const maxVol = Math.max(1, ...graph.nodes.map((n) => n.volumeSol));
    const rScale = scaleSqrt().domain([0, maxVol]).range([9, 34]).clamp(true);
    const wScale = scaleLog().domain([0.01, 5000]).range([1, 7]).clamp(true);

    // В режиме «Два кошелька» цели a и b закреплены по разным сторонам, остальное раскладывается между ними.
    const isPair = graph.nodes.some((n) => n.kind === 'pair');
    // Карта группы: несколько центров. Каждый кластер выбранных кошельков получает свою точку на окружности,
    // члены кластера слабо тянутся к ней, остальные узлы расставляются связями.
    const clusterIds = [...new Set(graph.nodes.filter((n) => n.cluster != null).map((n) => n.cluster!))].sort((a, b) => a - b);
    const isGroup = clusterIds.length > 0;
    const ringR = clusterIds.length > 1 ? 150 + 55 * clusterIds.length : 0;
    const centreOf = (c: number) => {
      const i = clusterIds.indexOf(c);
      const a = (i / Math.max(1, clusterIds.length)) * Math.PI * 2 - Math.PI / 2;
      return { x: Math.cos(a) * ringR, y: Math.sin(a) * ringR };
    };
    const pairGap = 270;
    const fixedX = (n: GraphNode): number | null =>
      isGroup ? null : n.kind === 'target' ? (isPair ? -pairGap : 0) : n.kind === 'pair' ? pairGap : null;
    const isCenter = (n: GraphNode) => n.kind === 'target' || n.kind === 'pair';
    const nodes: SimNode[] = graph.nodes.map((n, i) => {
      const a = (i / Math.max(1, graph.nodes.length)) * Math.PI * 2;
      const rr = Math.max(1, n.hop) * 150;
      const r = isCenter(n) ? Math.max(24, rScale(n.volumeSol)) : rScale(n.volumeSol);
      const sn: SimNode = { id: n.id, data: n, r, x: Math.cos(a) * rr, y: Math.sin(a) * rr };
      if (n.cluster != null) {
        const c = centreOf(n.cluster);
        sn.x = c.x + Math.cos(a * 7) * 50;
        sn.y = c.y + Math.sin(a * 7) * 50;
      }
      const fx = fixedX(n);
      if (fx != null) {
        sn.x = fx;
        sn.y = 0;
        sn.fx = fx;
        sn.fy = 0;
      }
      return sn;
    });
    const links: SimLink[] = graph.edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({
        source: e.source,
        target: e.target,
        data: e,
        width: isCoBuyOnly(e) || isFeeOnly(e) ? 2 : wScale(Math.max(0.01, e.solForward + e.solBackward)),
      }));

    // defs: стрелки
    const defs = svg.append('defs');
    const mkMarker = (id: string, color: string) => {
      defs
        .append('marker')
        .attr('id', id)
        .attr('viewBox', '0 0 10 10')
        .attr('refX', 9)
        .attr('refY', 5)
        .attr('markerWidth', 9)
        .attr('markerHeight', 9)
        .attr('markerUnits', 'userSpaceOnUse')
        .attr('orient', 'auto-start-reverse')
        .append('path')
        .attr('d', 'M0,0 L10,5 L0,10 z')
        .attr('fill', color);
    };
    mkMarker('ar-n', '#7488a3');
    mkMarker('ar-f', '#d4a24c');
    mkMarker('ar-p', '#4fd1c5');
    mkMarker('ar-h', '#f1f5fb');

    const viewport = svg.append('g').attr('class', 'viewport');
    const edgeLayer = viewport.append('g');
    const nodeLayer = viewport.append('g');

    const edgeG = edgeLayer
      .selectAll<SVGGElement, SimLink>('g')
      .data(links)
      .join('g')
      .attr('class', (d) => 'edge' + (d.data.fundingOf ? ' fund' : '') + (isCoBuyOnly(d.data) ? ' cobuy' : '') + (isFeeOnly(d.data) ? ' fee' : ''));
    const visLine = edgeG.append('line').attr('class', 'vis').attr('stroke-width', (d) => d.width);
    // Ребро с переводами и совместными покупками: маленькая точка-маркер посередине (подробности — в подсказке)
    edgeG
      .filter((d) => !!d.data.coBuy && !isCoBuyOnly(d.data))
      .append('circle')
      .attr('class', 'cb-mark')
      .attr('r', 4)
      .append('title')
      .text((d) => `Совместные покупки: ${coBuyText(d.data.coBuy!)}`);
    edgeG
      .append('line')
      .attr('class', 'hit')
      .attr('stroke-width', (d) => Math.max(12, d.width + 8))
      .on('click', (ev: MouseEvent, d) => {
        ev.stopPropagation();
        cb.current.onSelectEdge(d.data.id);
      })
      .on('mouseenter mousemove', (ev: MouseEvent, d) => {
        const rect = wrapRef.current?.getBoundingClientRect();
        if (rect) setHover({ kind: 'edge', edge: d.data, x: ev.clientX - rect.left, y: ev.clientY - rect.top });
      })
      .on('mouseleave', () => setHover(null));

    const nodeG = nodeLayer
      .selectAll<SVGGElement, SimNode>('g')
      .data(nodes)
      .join('g')
      .attr('class', (d) => `node ${d.data.kind}` + (d.data.cluster != null ? ' grp' : ''))
      .style('cursor', 'pointer')
      .on('click', (ev: MouseEvent, d) => {
        ev.stopPropagation();
        cb.current.onSelectNode(d.id);
      })
      .on('mouseenter mousemove', (ev: MouseEvent, d) => {
        const rect = wrapRef.current?.getBoundingClientRect();
        if (rect) setHover({ kind: 'node', node: d.data, x: ev.clientX - rect.left, y: ev.clientY - rect.top });
      })
      .on('mouseleave', () => setHover(null));

    nodeG
      .filter((d) => d.data.kind === 'target' || d.data.kind === 'pair')
      .append('circle')
      .attr('class', 'halo')
      .attr('r', (d) => d.r + 7)
      .attr('stroke', (d) => (d.data.cluster != null ? clusterColor(d.data.cluster) : null));
    nodeG
      .append('circle')
      .attr('class', 'main')
      .attr('r', (d) => d.r)
      .attr('fill', (d) => nodeColor(d.data))
      .attr('stroke', (d) => nodeColor(d.data))
      .attr('fill-opacity', (d) => (d.data.kind === 'other' ? 0.18 : d.data.kind === 'target' || d.data.kind === 'pair' ? 0.4 : 0.3))
      .attr('stroke-width', (d) => (d.data.kind === 'target' || d.data.kind === 'pair' ? 3 : 1.6))
      .attr('stroke-dasharray', (d) => (d.data.kind === 'hub' && !isExchangeHub(d.data) ? '4 3' : d.data.depositOf ? '2 3' : null));
    nodeG
      .filter((d) => ['tracked', 'target', 'pair', 'hub', 'sibling'].includes(d.data.kind))
      .append('text')
      .attr('class', 'emoji')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('font-size', (d) => Math.max(11, d.r * 0.95))
      .text((d) => {
        const n = d.data;
        if (n.kind === 'target' || n.kind === 'pair') return n.cluster != null ? (n.emoji ?? '◎') : '◎';
        if (n.kind === 'hub') return isExchangeHub(n) ? '🏦' : '⚙';
        if (n.kind === 'sibling') return '👤';
        return n.emoji ?? '•';
      });
    // Маркер депозитного адреса биржи
    const dep = nodeG
      .filter((d) => !!d.data.depositOf)
      .append('g')
      .attr('class', 'dep-mark')
      .attr('transform', (d) => `translate(${d.r * 0.72},${-d.r * 0.72})`);
    dep.append('title').text((d) => `Депозитный адрес биржи: ${d.data.depositOf}`);
    dep.append('circle').attr('r', 7);
    dep.append('text').attr('text-anchor', 'middle').attr('dominant-baseline', 'central').attr('font-size', 9).text('⇥');
    nodeG
      .append('text')
      .attr('class', (d) => 'lbl' + (d.data.kind === 'tracked' || d.data.cluster != null ? ' strong' : ''))
      .attr('text-anchor', 'middle')
      .attr('y', (d) => d.r + 13)
      .text((d) => {
        const n = d.data;
        if (n.kind === 'tracked' || n.cluster != null) return n.label;
        if (n.kind === 'hub') return n.hubLabel ?? n.label;
        if (n.depositOf) return `${shortAddr(n.id)} · депозит`;
        return shortAddr(n.id);
      });

    const dragB = drag<SVGGElement, SimNode>()
      .on('start', (ev, d) => {
        if (!ev.active) sim.alphaTarget(0.2).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (ev, d) => {
        d.fx = ev.x;
        d.fy = ev.y;
      })
      .on('end', (ev) => {
        if (!ev.active) sim.alphaTarget(0);
      });
    nodeG.call(dragB);

    const sim: Simulation<SimNode, SimLink> = forceSimulation<SimNode>(nodes)
      .force(
        'link',
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance((l) => {
            const s = l.source as SimNode;
            const t = l.target as SimNode;
            return 60 + s.r + t.r + (1 - l.data.strength) * 70;
          })
          .strength(0.55),
      )
      .force('charge', forceManyBody<SimNode>().strength((d) => -140 - d.r * 9))
      .force('collide', forceCollide<SimNode>().radius((d) => d.r + 16).iterations(2))
      .force('x', forceX<SimNode>((d) => (d.data.cluster != null ? centreOf(d.data.cluster).x : 0)).strength((d) => (d.data.cluster != null ? 0.13 : 0.035)))
      .force('y', forceY<SimNode>((d) => (d.data.cluster != null ? centreOf(d.data.cluster).y : 0)).strength((d) => (d.data.cluster != null ? 0.13 : 0.035)))
      .alphaDecay(0.04)
      .velocityDecay(0.5)
      .stop();

    const ticked = () => {
      edgeG.each(function (d) {
        const s = d.source as SimNode;
        const t = d.target as SimNode;
        const dx = (t.x ?? 0) - (s.x ?? 0);
        const dy = (t.y ?? 0) - (s.y ?? 0);
        const dist = Math.hypot(dx, dy) || 1;
        const ux = dx / dist;
        const uy = dy / dist;
        const x1 = (s.x ?? 0) + ux * (s.r + 1);
        const y1 = (s.y ?? 0) + uy * (s.r + 1);
        const x2 = (t.x ?? 0) - ux * (t.r + 2);
        const y2 = (t.y ?? 0) - uy * (t.r + 2);
        select(this)
          .selectAll('line')
          .attr('x1', x1)
          .attr('y1', y1)
          .attr('x2', x2)
          .attr('y2', y2);
        select(this)
          .select('circle.cb-mark')
          .attr('cx', (x1 + x2) / 2)
          .attr('cy', (y1 + y2) / 2);
      });
      nodeG.attr('transform', (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
    };
    sim.on('tick', ticked);

    const settle = () => {
      sim.alpha(1);
      for (let i = 0; i < 320; i++) sim.tick();
      sim.alpha(0);
      ticked();
    };
    settle();

    // зум / панорама
    const z = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 6])
      .on('zoom', (ev) => viewport.attr('transform', ev.transform.toString()));
    svg.call(z).on('dblclick.zoom', null);
    svg.on('click', (ev: MouseEvent) => {
      if (ev.target === svgEl) cb.current.onClear();
    });

    const fit = () => {
      const rect = svgEl.getBoundingClientRect();
      const w = rect.width || 800;
      const h = rect.height || 600;
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (const n of nodes) {
        x0 = Math.min(x0, (n.x ?? 0) - n.r - 20);
        x1 = Math.max(x1, (n.x ?? 0) + n.r + 20);
        y0 = Math.min(y0, (n.y ?? 0) - n.r - 20);
        y1 = Math.max(y1, (n.y ?? 0) + n.r + 30);
      }
      const bw = Math.max(1, x1 - x0);
      const bh = Math.max(1, y1 - y0);
      const k = Math.min(1.3, 0.92 * Math.min(w / bw, h / bh));
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      svg.call(z.transform, zoomIdentity.translate(w / 2 - k * cx, h / 2 - k * cy).scale(k));
    };
    fit();
    fitRef.current = fit;

    resetRef.current = () => {
      for (const n of nodes) {
        if (!isCenter(n.data)) {
          n.fx = null;
          n.fy = null;
        }
      }
      settle();
      fit();
    };

    const apply = (h: Highlight | null) => {
      nodeG
        .classed('dim', (d) => !!h && !h.nodes.has(d.id))
        .classed('focus', (d) => !!h && h.focusNode === d.id);
      edgeG
        .classed('dim', (d) => !!h && !h.edges.has(d.data.id))
        .classed('hl', (d) => !!h && h.edges.has(d.data.id))
        .classed('focus', (d) => !!h && h.focusEdge === d.data.id);
      visLine
        .attr('stroke-width', (d) => d.width + (h && h.edges.has(d.data.id) ? (h.focusEdge === d.data.id ? 2.5 : 1.2) : 0))
        .attr('marker-end', (d) => markerFor(d, h, 'end'))
        .attr('marker-start', (d) => markerFor(d, h, 'start'));
    };
    const markerFor = (d: SimLink, h: Highlight | null, end: 'end' | 'start'): string | null => {
      const e = d.data;
      let dir: 'fwd' | 'bwd' | 'none' = 'none';
      if (isFeeOnly(e)) dir = e.feesPaid!.payer === e.source ? 'fwd' : 'bwd';
      else if (e.fundingOf) dir = e.fundingOf === e.target ? 'fwd' : 'bwd';
      else if (e.solForward > 0 && e.solBackward === 0) dir = 'fwd';
      else if (e.solBackward > 0 && e.solForward === 0) dir = 'bwd';
      if (dir === 'none') return null;
      if ((dir === 'fwd') !== (end === 'end')) return null;
      const lit = !!h && h.edges.has(e.id);
      return `url(#${lit ? 'ar-h' : isFeeOnly(e) ? 'ar-p' : e.fundingOf ? 'ar-f' : 'ar-n'})`;
    };
    applyRef.current = apply;
    apply(hlRef.current);

    return () => {
      sim.stop();
      svg.on('.zoom', null).on('click', null);
      svg.selectAll('*').remove();
      applyRef.current = null;
      resetRef.current = null;
      fitRef.current = null;
    };
  }, [graph]);

  useEffect(() => {
    applyRef.current?.(highlight);
  }, [highlight]);

  // Размер карты изменился (сворачивание верхней панели, поворот экрана, панель связей) — подгоняем вид.
  useEffect(() => {
    const el = svgRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let last = '';
    let timer = 0;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const key = `${Math.round(r.width)}x${Math.round(r.height)}`;
      if (!r.width || !r.height || key === last) return;
      const first = last === '';
      last = key;
      if (first) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => fitRef.current?.(), 60);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (resetKey !== lastReset.current) {
      lastReset.current = resetKey;
      resetRef.current?.();
    }
  }, [resetKey]);

  return (
    <div className="graph" ref={wrapRef}>
      <svg ref={svgRef} className="graph-svg" />
      {hover && <Tooltip hover={hover} nodes={graph?.nodes ?? []} wrap={wrapRef} />}
    </div>
  );
}

function Tooltip({ hover, nodes, wrap }: { hover: NonNullable<Hover>; nodes: GraphNode[]; wrap: React.RefObject<HTMLDivElement> }) {
  const w = wrap.current?.clientWidth ?? 800;
  const flip = hover.x > w - 320;
  const style: React.CSSProperties = {
    top: hover.y + 14,
    left: flip ? undefined : hover.x + 14,
    right: flip ? w - hover.x + 14 : undefined,
  };
  if (hover.kind === 'node') {
    const n = hover.node;
    return (
      <div className="tooltip" style={style}>
        <div className="tt-title">
          {n.emoji ? `${n.emoji} ` : ''}
          {n.hubLabel ?? n.label}
          {n.entityName && n.entityName !== n.label ? <span className="muted"> · {n.entityName}</span> : null}
        </div>
        <div className="mono tt-addr">{n.id}</div>
        <div className="tt-row">
          <span>Тип</span>
          <b>{KIND_LABELS[n.kind]}</b>
        </div>
        {n.depositOf && (
          <div className="tt-row">
            <span>Депозитный адрес биржи</span>
            <b>{n.depositOf}</b>
          </div>
        )}
        {n.score != null && (
          <div className="tt-row">
            <span>Сила связи</span>
            <b>
              {Math.round(n.score * 100)}% · {scoreLabel(n.score)}
            </b>
          </div>
        )}
        <div className="tt-row">
          <span>Объём</span>
          <b>{fmtSol(n.volumeSol)} SOL</b>
        </div>
        {n.groups && n.groups.length > 0 && (
          <div className="tt-row">
            <span>Группы</span>
            <b>{n.groups.join(', ')}</b>
          </div>
        )}
      </div>
    );
  }
  const e = hover.edge;
  const name = (a: string) => {
    const n = nodes.find((x) => x.id === a);
    return n ? n.hubLabel ?? n.label : shortAddr(a);
  };
  return (
    <div className="tooltip" style={style}>
      <div className="tt-title">
        {name(e.source)} ⇄ {name(e.target)}
      </div>
      <div className="tt-row">
        <span>{name(e.source)} → {name(e.target)}</span>
        <b>{fmtSol(e.solForward)} SOL</b>
      </div>
      <div className="tt-row">
        <span>{name(e.target)} → {name(e.source)}</span>
        <b>{fmtSol(e.solBackward)} SOL</b>
      </div>
      <div className="tt-row">
        <span>Переводов</span>
        <b>
          {e.transferCount}
          {e.tokenTransferCount ? ` (токены: ${e.tokenTransferCount})` : ''}
        </b>
      </div>
      {e.fundingOf && <div className="tt-row"><span>Первое пополнение</span><b>{name(e.fundingOf)}</b></div>}
      {e.feesPaid && (
        <div className="tt-row tt-fee">
          <span>Оплачивал комиссии</span>
          <b>
            {name(e.feesPaid.payer)} за {e.feesPaid.txCount} {plural(e.feesPaid.txCount, ['транзакцию', 'транзакции', 'транзакций'])}
          </b>
        </div>
      )}
      {e.coBuy && (
        <div className="tt-row tt-cobuy">
          <span>Совместные покупки</span>
          <b>{coBuyText(e.coBuy)}</b>
        </div>
      )}
    </div>
  );
}
