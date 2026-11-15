import type {
  ConnectionType,
  GraphEdge,
  GraphNode,
  GroupLink,
  GroupResult,
  TrackedWallet,
  TransferRecord,
  WalletRow,
  WalletsResponse,
} from '../../shared/types.ts';
import { addr, mockTracked, MOCK_STATUS, sig } from './mock.ts';

const SOL = 'So11111111111111111111111111111111111111111';
const NAMES: Array<[string, string, string[]]> = [
  ['Ansem', '🐻', ['KOL']],
  ['Ansem', '🐻', ['KOL', 'Bundle']],
  ['Orangie', '🍊', ['KOL']],
  ['Kev', '🦅', ['Dev']],
  ['Kev DEV', '🦅', ['Dev']],
  ['Gake', '🐺', ['KOL']],
  ['Gake Side', '🐺', ['Bundle']],
  ['Euris', '🦉', ['Sniper']],
  ['Dave', '🎲', ['KOL']],
  ['Jijo', '🐙', ['Insider']],
  ['Jijo 2', '🐙', ['Insider', 'Bundle']],
  ['Leens', '🦁', ['KOL']],
  ['Bandit', '🥷', ['Sniper']],
  ['Daumen', '🐢', ['KOL']],
  ['Mitch', '🦈', ['KOL', 'Whale']],
  ['Radiance', '🌟', ['Dev']],
  ['Pow', '💥', ['Sniper']],
  ['Slingoor', '🧵', ['KOL']],
  ['Zrool', '🐍', ['Insider']],
  ['West', '🤠', ['KOL']],
  ['Sebastian', '🎩', ['Whale']],
  ['Waddles', '🦆', ['KOL']],
  ['Chairman', '🪑', ['Whale']],
  ['Trenchman', '⛏', ['Sniper']],
  ['Lectron', '⚡', ['Dev']],
  ['Nach', '🧠', ['KOL']],
  ['Skely', '💀', ['Insider']],
  ['Brox', '🪨', ['Sniper']],
  ['Hail', '🌨', ['KOL']],
  ['Hail', '🌨', ['Bundle']],
  ['Cented', '🪙', ['KOL']],
  ['Sheep', '🐑', ['Whale']],
  ['Tim', '🕰', ['Dev']],
  ['Printer', '🖨', ['Sniper']],
  ['Naruza', '🥋', ['KOL']],
  ['Bastille', '🏰', ['Insider']],
  ['Marcus', '🏛', ['Whale']],
  ['Cooker', '🍳', ['Dev']],
];

const NOW = () => Math.floor(Date.now() / 1000);

/** Кошельки для демо-режима: основа из mockTracked плюс несколько десятков других, есть одноимённые. */
export function mockWalletRows(): WalletRow[] {
  const base: TrackedWallet[] = [...mockTracked()];
  NAMES.forEach(([name, emoji, groups], i) => {
    const key = name.toLowerCase().replace(/ (dev|side|\d)$/, '');
    base.push({ address: addr('w' + i + name), name, emoji, entity: key, entityName: name.replace(/ (DEV|Side|\d)$/, ''), groups });
  });
  const now = NOW();
  return base.map((w, i) => {
    const r = (k: number) => ((i * 2654435761 + k * 40503) >>> 0) / 4294967296;
    const hasHistory = r(1) > 0.25;
    const lastAgo = [120, 3600 * 3, 86400 * 2, 86400 * 9, 86400 * 40, 86400 * 200][Math.floor(r(2) * 6)]! * (0.5 + r(3));
    return {
      ...w,
      balanceSol: r(4) > 0.08 ? Math.round(Math.pow(r(5), 3) * 900 * 100) / 100 : null,
      lastActive: r(6) > 0.1 ? Math.floor(now - lastAgo) : null,
      firstSeen: hasHistory && r(7) > 0.3 ? Math.floor(now - 86400 * (30 + r(8) * 900)) : null,
      indexed: { history: hasHistory, payers: hasHistory && r(9) > 0.5, fetchedAt: hasHistory ? Math.floor(now - 86400 * r(10) * 5) : null },
    };
  });
}

let rowsCache: WalletRow[] | null = null;
export function mockWallets(): WalletsResponse {
  rowsCache ??= mockWalletRows();
  return { wallets: rowsCache.map((w) => ({ ...w })), balancesAt: Date.now() };
}
export function mockRefresh(address: string): WalletRow {
  rowsCache ??= mockWalletRows();
  const w = rowsCache.find((x) => x.address === address);
  if (!w) throw new Error('Кошелёк не из списка отслеживания');
  w.lastActive = NOW() - 30;
  w.balanceSol = Math.round(Math.random() * 500 * 100) / 100;
  return { ...w };
}

export const MOCK_GROUP_PROGRESS = [
  'Читаю кэш переводов выбранных кошельков…',
  'Ищу переводы и совместные покупки между выбранными…',
  'Сопоставляю плательщиков комиссий и общие источники…',
  'Собираю кластеры и связи со списком…',
];
export const MOCK_GROUP_DEEP_PROGRESS = [
  'Догружаю истории выбранных кошельков…',
  'Проверяю пары через «Два кошелька» (3 из 15)…',
  'Проверяю пары через «Два кошелька» (11 из 15)…',
  'Раскрываю посредников…',
  'Собираю кластеры и связи со списком…',
];

/** Демо-результат группы: два кластера и одиночка (если выбрано достаточно кошельков), связи разных типов, несколько внешних. */
export function buildMockGroup(addresses: string[], deep: boolean): GroupResult {
  const rows = rowsCache ?? mockWalletRows();
  const byAddr = new Map(rows.map((w) => [w.address, w]));
  const n = addresses.length;
  const sizes: number[] = [];
  if (n >= 2) {
    const c0 = n <= 3 ? 2 : Math.ceil((n - 1) / 2);
    sizes.push(c0);
    if (n - c0 >= 3) sizes.push(n - c0 - 1);
  }
  const clusters: string[][] = [];
  let at = 0;
  for (const s of sizes) clusters.push(addresses.slice(at, (at += s)));
  while (at < n) clusters.push([addresses[at++]!]);
  clusters.sort((x, y) => y.length - x.length);
  const clusterOf = new Map<string, number>();
  clusters.forEach((c, i) => c.forEach((a) => clusterOf.set(a, i)));

  const baseT = NOW() - 86400 * 3;
  const edgeId = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);
  const edges = new Map<string, GraphEdge>();
  let counter = 0;
  const base = (from: string, to: string) => {
    const [source, target] = from < to ? [from, to] : [to, from];
    return { id: edgeId(from, to), source, target, fwd: from === source };
  };
  function transfers(from: string, to: string, sol: number, count: number, t0: number): TransferRecord[] {
    return Array.from({ length: count }, (_, i) => ({
      signature: sig(`g${from}${to}${i}${counter++}`),
      blockTime: t0 + i * 86400,
      slot: 290000000 + counter * 1000,
      from,
      to,
      mint: SOL,
      symbol: 'SOL',
      amount: Math.round((sol / count) * 1000) / 1000,
    })).reverse();
  }
  function mkTransfer(from: string, to: string, sol: number, strength: number, funding = false) {
    const b = base(from, to);
    const tr = transfers(from, to, sol, 3, baseT - 86400 * 30);
    edges.set(b.id, {
      id: b.id, source: b.source, target: b.target,
      solForward: b.fwd ? sol : 0, solBackward: b.fwd ? 0 : sol,
      tokenTransferCount: 0, transferCount: tr.length,
      firstTime: tr[tr.length - 1]!.blockTime, lastTime: tr[0]!.blockTime, strength, transfers: tr,
      ...(funding ? { fundingOf: to } : {}),
    });
    return b.id;
  }
  function mkCoBuy(x: string, y: string, strength: number) {
    const b = base(x, y);
    const pool = addr('gpool');
    const tr: TransferRecord[] = [];
    for (let i = 0; i < 3; i++) {
      for (const [k, w] of [x, y].entries()) {
        tr.push({ signature: sig(`gb${x}${y}${i}${k}`), blockTime: baseT - 86400 * (6 - i) + k, slot: 291000000 + i * 3000, from: pool, to: w, mint: addr('gm' + (i % 2)), symbol: ['BONK', 'WIF', 'POPCAT'][i]!, amount: 50000 + i * 9000, coBuy: true });
      }
    }
    edges.set(b.id, { id: b.id, source: b.source, target: b.target, solForward: 0, solBackward: 0, tokenTransferCount: 0, transferCount: 0, firstTime: tr[0]!.blockTime, lastTime: tr[tr.length - 1]!.blockTime, strength, coBuy: { mints: 2, slots: 3 }, transfers: tr });
    return b.id;
  }
  function mkFee(payer: string, other: string, strength: number) {
    const b = base(payer, other);
    edges.set(b.id, { id: b.id, source: b.source, target: b.target, solForward: 0, solBackward: 0, tokenTransferCount: 0, transferCount: 0, firstTime: null, lastTime: null, strength, feesPaid: { payer, txCount: 37 }, transfers: [] });
    return b.id;
  }

  const links: GroupLink[] = [];
  const nodeLabel = (a: string) => byAddr.get(a)?.name ?? a.slice(0, 4);
  const types: ConnectionType[] = ['co-buy', 'fee-payer', 'direct', 'common-funder'];
  const intermediaries: GraphNode[] = [];
  const addLink = (a: string, b: string, type: ConnectionType, score: number) => {
    let nodes = [a, b];
    let edgeIds: string[];
    let reason: string;
    if (type === 'co-buy') {
      edgeIds = [mkCoBuy(a, b, score)];
      reason = 'Покупали одни и те же токены в одном слоте: 2 токена, 3 слота — так обычно работают бандлы одного владельца.';
    } else if (type === 'fee-payer') {
      edgeIds = [mkFee(a, b, score)];
      reason = `${nodeLabel(a)} оплачивал комиссии за 37 транзакций ${nodeLabel(b)} — так обычно делают со своими кошельками.`;
    } else if (type === 'direct') {
      edgeIds = [mkTransfer(a, b, 12.4, score)];
      reason = 'Прямые переводы между кошельками: 12,4 SOL за 3 перевода.';
    } else {
      const f = addr(`gf${a}${b}`);
      intermediaries.push({ id: f, kind: 'intermediary', label: `${f.slice(0, 4)}…${f.slice(-4)}`, hop: 1, volumeSol: 30 });
      edgeIds = [mkTransfer(f, a, 15, 0.5, true), mkTransfer(f, b, 15, 0.5, true)];
      nodes = [a, f, b];
      reason = 'Один и тот же кошелёк первым пополнил оба адреса (по 15 SOL с разницей в день).';
    }
    links.push({ a, b, type, score, reason, nodes, edgeIds });
  };
  let t = 0;
  for (const c of clusters) {
    for (let i = 1; i < c.length; i++) addLink(c[i - 1]!, c[i]!, types[t++ % 4]!, 0.85 - (t % 4) * 0.12);
    if (c.length >= 3) addLink(c[0]!, c[c.length - 1]!, types[t++ % 4]!, 0.62);
  }
  // Слабая связь между кластерами (< 0.5): кластеры не сливаются.
  if (clusters.length >= 2) addLink(clusters[0]![0]!, clusters[1]![0]!, 'common-funder', 0.34);
  links.sort((x, y) => y.score - x.score);

  // Внешние: кошельки списка, не выбранные.
  const selected = new Set(addresses);
  const others = rows.filter((w) => !selected.has(w.address)).slice(0, 4);
  const external: GroupResult['external'] = [];
  const extNodes: GraphNode[] = [];
  others.forEach((w, i) => {
    const from = addresses[(i * 2) % Math.max(1, n)] ?? addresses[0]!;
    const type = (['direct', 'co-buy', 'fee-payer', 'direct'] as ConnectionType[])[i]!;
    const score = [0.74, 0.58, 0.46, 0.31][i]!;
    if (type === 'direct') mkTransfer(from, w.address, 6 + i, score);
    else if (type === 'co-buy') mkCoBuy(from, w.address, score);
    else mkFee(w.address, from, score);
    const reason = type === 'direct' ? 'Прямые переводы: 6 SOL.' : type === 'co-buy' ? 'Покупали одни и те же токены в одном слоте.' : `${w.name} оплачивал комиссии за 37 транзакций.`;
    external.push({ from, wallet: { address: w.address, name: w.name, emoji: w.emoji, entity: w.entity, entityName: w.entityName, groups: w.groups }, type, score, reason });
    extNodes.push({ id: w.address, kind: 'tracked', label: w.name, emoji: w.emoji, entity: w.entity, entityName: w.entityName, groups: w.groups, hop: 1, score, volumeSol: 6 + i });
  });

  const vol = new Map<string, number>();
  for (const e of edges.values()) {
    vol.set(e.source, (vol.get(e.source) ?? 0) + e.solForward + e.solBackward);
    vol.set(e.target, (vol.get(e.target) ?? 0) + e.solForward + e.solBackward);
  }
  const nodes: GraphNode[] = [
    ...addresses.map((a): GraphNode => {
      const w = byAddr.get(a);
      return { id: a, kind: 'target', label: w?.name ?? `${a.slice(0, 4)}…${a.slice(-4)}`, emoji: w?.emoji, entity: w?.entity, entityName: w?.entityName, groups: w?.groups, hop: 0, volumeSol: Math.round((vol.get(a) ?? 1) * 100) / 100, cluster: clusterOf.get(a) };
    }),
    ...intermediaries,
    ...extNodes,
  ];
  return {
    addresses,
    generatedAt: NOW(),
    options: { deep, minSol: 0.01 },
    links,
    clusters,
    external,
    nodes,
    edges: [...edges.values()],
    warnings: deep ? [] : ['Быстрый проход по кэшу: у части выбранных кошельков история не загружена, связи могут быть неполными.'],
    stats: { provider: MOCK_STATUS.provider, transfersLoaded: 5400, walletsFetched: n, apiCalls: deep ? 120 : 0, creditsEstimate: deep ? Math.round((n * (n - 1) * 5) + n * 70) : 0, durationMs: deep ? 21000 : 400, truncated: false },
  };
}
