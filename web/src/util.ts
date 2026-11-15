import type { AnalyzeResult, Connection, GraphEdge, GraphNode, GroupResult, LinkResult, NodeKind, SiblingSignal } from '../../shared/types.ts';

export const SOL_MINT = 'So11111111111111111111111111111111111111111';
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isValidAddress(s: string): boolean {
  return B58.test(s.trim());
}

export function shortAddr(a: string): string {
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

export function solscanTx(sig: string): string {
  return `https://solscan.io/tx/${sig}`;
}
export function solscanAcc(a: string): string {
  return `https://solscan.io/account/${a}`;
}

export function plural(n: number, forms: [string, string, string]): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return forms[0];
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return forms[1];
  return forms[2];
}

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function entityHue(entity: string): number {
  return (hashStr(entity) * 137) % 360;
}
export function entityColor(entity: string): string {
  return `hsl(${entityHue(entity)} 68% 58%)`;
}

export const KIND_COLORS: Record<NodeKind, string> = {
  target: '#38bdf8',
  tracked: '#a78bfa',
  intermediary: '#94a3b8',
  funder: '#d4a24c',
  hub: '#ef6b73',
  sibling: '#2dd4bf',
  pair: '#f472b6',
  other: '#4b5565',
};
export const KIND_LABELS: Record<NodeKind, string> = {
  target: 'Цель',
  tracked: 'Отслеживаемый',
  intermediary: 'Посредник',
  funder: 'Звено финансирования',
  hub: 'Биржа / сервис',
  sibling: 'Вероятно, тот же владелец',
  pair: 'Второй кошелёк',
  other: 'Прочий контрагент',
};
export const TYPE_LABELS: Record<string, string> = {
  direct: 'Прямые переводы',
  'common-funder': 'Общий источник средств',
  'common-recipient': 'Общий получатель',
  'via-intermediary': 'Через посредника',
  'funding-chain': 'Цепочка финансирования',
  'shared-deposit': 'Общий депозит биржи',
  'co-buy': 'Совместные покупки',
  'fee-payer': 'Оплата комиссий',
};
export const SIGNAL_LABELS: Record<SiblingSignal, string> = {
  'funded-by-target': 'пополнен целью',
  'funded-target': 'пополнил цель',
  'common-funder': 'общий источник',
  'two-way': 'переводы в обе стороны',
  'token-moves': 'перемещения токенов',
  'shared-deposit': 'общий депозит биржи',
  'co-buy': 'покупки в одном слоте',
  'fee-payer': 'оплата комиссий',
};
/** Хаб — биржа (метка или поведение), а не инфраструктура. */
export function isExchangeHub(n: GraphNode): boolean {
  return n.kind === 'hub' && (n.hubCategory === 'cex' || n.hubCategory === 'service');
}

export function scoreLabel(s: number): 'сильная' | 'средняя' | 'слабая' {
  return s >= 0.7 ? 'сильная' : s >= 0.35 ? 'средняя' : 'слабая';
}
export function scoreColor(s: number): string {
  return s >= 0.7 ? 'var(--good)' : s >= 0.35 ? 'var(--warn)' : 'var(--muted)';
}

export function fmtSol(n: number): string {
  if (n >= 1000) return n.toLocaleString('ru-RU', { maximumFractionDigits: 0 });
  if (n >= 10) return n.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 3 });
}
export function fmtAmount(n: number): string {
  if (n === 0) return '0';
  if (Math.abs(n) >= 1000) return n.toLocaleString('ru-RU', { maximumFractionDigits: 0 });
  if (Math.abs(n) >= 1) return n.toLocaleString('ru-RU', { maximumFractionDigits: 3 });
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 6 });
}
export function fmtTime(t: number | null): string {
  if (t == null) return '—';
  return new Date(t * 1000).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
export function fmtDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} мс` : `${(ms / 1000).toFixed(1)} с`;
}

export async function copyText(s: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(s);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = s;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export type Selection =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; id: string }
  | { kind: 'connection'; wallet: string }
  | { kind: 'path'; wallet: string; index: number }
  | { kind: 'sibling'; address: string }
  | { kind: 'linkpath'; index: number }
  | { kind: 'grouplink'; index: number }
  | null;

export interface Highlight {
  nodes: Set<string>;
  edges: Set<string>;
  /** Основной выбранный узел/ребро (рисуется ярче). */
  focusNode?: string;
  focusEdge?: string;
}

/** То, что показывает карта: результат одного кошелька или связи двух. */
export type ViewData = AnalyzeResult | LinkResult | GroupResult;
export function isLink(d: ViewData): d is LinkResult {
  return 'paths' in d && 'a' in d;
}
export function isGroup(d: ViewData): d is GroupResult {
  return 'clusters' in d;
}
export function asSingle(d: ViewData): AnalyzeResult | null {
  return isLink(d) || isGroup(d) ? null : d;
}

/** Цвета кластеров выбранных кошельков (карта группы). */
export const CLUSTER_COLORS = ['#38bdf8', '#f472b6', '#facc15', '#34d399', '#fb923c', '#a78bfa', '#2dd4bf', '#f87171', '#a3e635', '#60a5fa'];
export function clusterColor(i: number): string {
  return CLUSTER_COLORS[i % CLUSTER_COLORS.length]!;
}
/** Старые ответы сервера могли не содержать siblings. */
export function siblingsOf(r: AnalyzeResult) {
  return r.siblings ?? [];
}

export function connectionOf(r: AnalyzeResult, wallet: string): Connection | undefined {
  return r.connections.find((c) => c.wallet.address === wallet);
}

export function computeHighlight(d: ViewData | null, sel: Selection): Highlight | null {
  if (!d || !sel) return null;
  const nodes = new Set<string>();
  const edges = new Set<string>();
  if (sel.kind === 'node') {
    nodes.add(sel.id);
    for (const e of d.edges) {
      if (e.source === sel.id || e.target === sel.id) {
        edges.add(e.id);
        nodes.add(e.source);
        nodes.add(e.target);
      }
    }
    return { nodes, edges, focusNode: sel.id };
  }
  if (sel.kind === 'edge') {
    const e = d.edges.find((x) => x.id === sel.id);
    if (!e) return null;
    nodes.add(e.source);
    nodes.add(e.target);
    edges.add(e.id);
    return { nodes, edges, focusEdge: e.id };
  }
  if (sel.kind === 'grouplink') {
    if (!isGroup(d)) return null;
    const l = d.links[sel.index];
    if (!l) return null;
    l.nodes.forEach((n) => nodes.add(n));
    l.edgeIds.forEach((id) => edges.add(id));
    return { nodes, edges };
  }
  if (sel.kind === 'linkpath') {
    if (!isLink(d)) return null;
    const p = d.paths[sel.index];
    if (!p) return null;
    p.nodes.forEach((n) => nodes.add(n));
    p.edgeIds.forEach((id) => edges.add(id));
    return { nodes, edges };
  }
  if (isLink(d) || isGroup(d)) return null;
  if (sel.kind === 'sibling') {
    const s = siblingsOf(d).find((x) => x.address === sel.address);
    if (!s) return null;
    nodes.add(s.address);
    nodes.add(d.target);
    s.edgeIds.forEach((id) => {
      edges.add(id);
      const e = d.edges.find((x) => x.id === id);
      if (e) {
        nodes.add(e.source);
        nodes.add(e.target);
      }
    });
    return { nodes, edges, focusNode: s.address };
  }
  const c = connectionOf(d, sel.wallet);
  if (!c) return null;
  const paths = sel.kind === 'path' ? c.paths.filter((_, i) => i === sel.index) : c.paths;
  for (const p of paths) {
    p.nodes.forEach((n) => nodes.add(n));
    p.edgeIds.forEach((id) => edges.add(id));
  }
  nodes.add(sel.wallet);
  return { nodes, edges, focusNode: sel.wallet };
}

export function edgesForSelection(d: ViewData, sel: Selection): GraphEdge[] {
  if (!sel || sel.kind === 'node') return [];
  const byId = new Map(d.edges.map((e) => [e.id, e]));
  const pick = (ids: Iterable<string>) => [...ids].map((id) => byId.get(id)).filter((e): e is GraphEdge => !!e);
  if (sel.kind === 'edge') return pick([sel.id]);
  if (sel.kind === 'linkpath') return isLink(d) ? pick(d.paths[sel.index]?.edgeIds ?? []) : [];
  if (sel.kind === 'grouplink') return isGroup(d) ? pick(d.links[sel.index]?.edgeIds ?? []) : [];
  if (isLink(d) || isGroup(d)) return [];
  if (sel.kind === 'sibling') return pick(siblingsOf(d).find((s) => s.address === sel.address)?.edgeIds ?? []);
  const c = connectionOf(d, sel.wallet);
  if (!c) return [];
  const ids = new Set<string>();
  (sel.kind === 'path' ? c.paths.filter((_, i) => i === sel.index) : c.paths).forEach((p) =>
    p.edgeIds.forEach((id) => ids.add(id)),
  );
  return pick(ids);
}

// ---------- Адресная строка ----------

export type SearchSpec =
  | { mode: 'single'; address: string; depth: 1 | 2 | 3 }
  | { mode: 'pair'; a: string; b: string; hops: 2 | 3 | 4 };

export function specKey(s: SearchSpec): string {
  return s.mode === 'single' ? `s:${s.address}:${s.depth}` : `p:${s.a}:${s.b}:${s.hops}`;
}

export function specToUrl(s: SearchSpec, mock: boolean): string {
  const q = new URLSearchParams();
  if (mock) q.set('mock', '1');
  if (s.mode === 'single') {
    q.set('address', s.address);
    q.set('depth', String(s.depth));
  } else {
    q.set('a', s.a);
    q.set('b', s.b);
    q.set('hops', String(s.hops));
  }
  return `${window.location.pathname}?${q.toString()}`;
}

/** Разбирает поиск из адресной строки; null, если в ней нет корректного запроса. */
export function parseSpec(search: string): SearchSpec | null {
  try {
    const q = new URLSearchParams(search);
    const a = (q.get('a') ?? '').trim();
    const b = (q.get('b') ?? '').trim();
    if (isValidAddress(a) && isValidAddress(b)) {
      const h = Number(q.get('hops'));
      return { mode: 'pair', a, b, hops: h === 2 || h === 4 ? h : 3 };
    }
    const address = (q.get('address') ?? '').trim();
    if (isValidAddress(address)) {
      const d = Number(q.get('depth'));
      return { mode: 'single', address, depth: d === 1 || d === 3 ? d : 2 };
    }
  } catch {
    /* ignore */
  }
  return null;
}

const LS_KEY = 'bubblesearch.v1';
export function loadPrefs(): { address?: string; depth?: 1 | 2 | 3 } {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as { address?: string; depth?: 1 | 2 | 3 }) : {};
  } catch {
    return {};
  }
}
export function savePrefs(p: { address: string; depth: 1 | 2 | 3 }): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

/** Ребро состоит только из совместных покупок (переводов между кошельками нет). */
export function isCoBuyOnly(e: GraphEdge): boolean {
  return !!e.coBuy && e.transferCount === 0;
}

/** Ребро состоит только из оплаты комиссий: переводов и совместных покупок нет. */
export function isFeeOnly(e: GraphEdge): boolean {
  return !!e.feesPaid && e.transferCount === 0 && !e.coBuy;
}

/** «N токенов в M слотах» для подписи совместных покупок. */
export function coBuyText(c: { mints: number; slots: number }): string {
  return `${c.mints} ${plural(c.mints, ['токен', 'токена', 'токенов'])} в ${c.slots} ${plural(c.slots, ['слоте', 'слотах', 'слотах'])}`;
}

/** «N токенов, M слотов» для строки в панели ребра. */
export function coBuyCounts(c: { mints: number; slots: number }): string {
  return `${c.mints} ${plural(c.mints, ['токен', 'токена', 'токенов'])}, ${c.slots} ${plural(c.slots, ['слот', 'слота', 'слотов'])}`;
}

/** «5 мин назад», «3 дн назад» по unix-секундам. */
export function fmtAgo(t: number | null, now = Date.now()): string {
  if (t == null) return '—';
  const s = Math.max(0, Math.floor(now / 1000 - t));
  if (s < 60) return 'только что';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24);
  if (d < 60) return `${d} дн назад`;
  const mo = Math.floor(d / 30.4);
  if (mo < 24) return `${mo} мес назад`;
  return `${Math.floor(d / 365)} г назад`;
}

/** Возраст кошелька по самому раннему переводу: «2 г 3 мес», «5 дн». */
export function fmtAge(first: number | null, now = Date.now()): string {
  if (first == null) return '—';
  const d = Math.max(0, Math.floor((now / 1000 - first) / 86400));
  if (d < 1) return '<1 дн';
  if (d < 60) return `${d} дн`;
  if (d < 365) return `${Math.floor(d / 30.4)} мес`;
  const y = Math.floor(d / 365);
  const mo = Math.floor((d - y * 365) / 30.4);
  return mo ? `${y} г ${mo} мес` : `${y} г`;
}
