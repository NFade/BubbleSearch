import type {
  AnalyzeResult,
  Connection,
  ConnectionPath,
  Depth,
  EntityConnection,
  GraphEdge,
  GraphNode,
  LinkPath,
  LinkResult,
  SiblingCandidate,
  StatusResponse,
  TrackedWallet,
  TransferRecord,
} from '../../shared/types.ts';

const SOL = 'So11111111111111111111111111111111111111111';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function pseudo(seed: string, len: number): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let out = '';
  for (let i = 0; i < len; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) + i;
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    out += B58[(h >>> 0) % 58];
  }
  return out;
}
export const addr = (s: string) => pseudo('addr:' + s, 44);
export const sig = (s: string) => pseudo('sig:' + s, 88);

export const MOCK_STATUS: StatusResponse = {
  provider: 'Public RPC (mock)',
  providerNote:
    'Ключ Helius не задан: используется публичный RPC, история загружается медленнее и с лимитами. Это демонстрационные данные.',
  hasHeliusKey: false,
  trackedCount: 3112,
  entityCount: 1279,
  indexedCount: 842,
};

export const MOCK_PROGRESS = [
  'Загружаю последние переводы кошелька…',
  'Загружено 1 874 перевода, ищу прямые связи со списком…',
  'Раскрываю посредников (2 из 12)…',
  'Строю цепочку финансирования: 3 звена до «Binance 2»…',
  'Считаю силу связей и собираю граф…',
];

export const MOCK_LINK_PROGRESS = [
  'Загружаю последние переводы первого кошелька…',
  'Загружаю последние переводы второго кошелька…',
  'Ищу общие источники пополнения и депозитные адреса…',
  'Раскрываю посредников между кошельками…',
  'Считаю силу связи и собираю граф…',
];

function tw(key: string, name: string, emoji: string, entity: string, entityName: string, groups: string[], salt = ''): TrackedWallet {
  return { address: addr(key + salt), name, emoji, entity, entityName, groups };
}

function mkMockWallets(sl: string) {
  return {
    cupsey: tw('cupsey', 'Cupsey', '🦊', 'cupsey', 'Cupsey', ['KOL'], sl),
    cupseySide: tw('cupsey-side', 'Cupsey Side', '🦊', 'cupsey', 'Cupsey', ['KOL'], sl),
    cupsey2: tw('cupsey-2', 'Cupsey 2', '🦊', 'cupsey', 'Cupsey', ['KOL', 'Bundle'], sl),
    frank: tw('frank', 'Frank', '🐸', 'frank', 'Frank', ['KOL'], sl),
    frankDev: tw('frank-dev', 'Frank DEV', '🐸', 'frank', 'Frank', ['Dev'], sl),
    marcel: tw('marcel', 'Marcel', '🎩', 'marcel', 'Marcel', ['KOL'], sl),
    marcelSide: tw('marcel-side', 'Marcel Side', '🎩', 'marcel', 'Marcel', ['Bundle'], sl),
    yugi: tw('yugi', 'Yugi', '🐉', 'yugi', 'Yugi', ['KOL', 'Bundle'], sl),
  };
}

/** Список отслеживаемых для подсказок в демо-режиме: часть имён повторяется у нескольких кошельков. */
export function mockTracked(): TrackedWallet[] {
  const base = Object.values(mkMockWallets(''));
  const extra: TrackedWallet[] = [
    tw('yugi-2', 'Yugi', '🐉', 'yugi', 'Yugi', ['KOL'], ''),
    tw('yugi-3', 'Yugi Bundle', '🐉', 'yugi', 'Yugi', ['Bundle'], ''),
    tw('yugi-4', 'Yugi Side', '🐉', 'yugi', 'Yugi', ['Bundle', 'Dev'], ''),
    tw('orangie', 'Orangie', '🍊', 'orangie', 'Orangie', ['KOL'], ''),
    tw('cooker', 'Cooker', '🍳', 'cooker', 'Cooker', ['Dev'], ''),
    tw('marcel-3', 'Marcel', '🎩', 'marcel', 'Marcel', ['Sniper'], ''),
  ];
  return [...base, ...extra];
}

export function buildMockResult(target: string, depth: Depth): AnalyzeResult {
  const T = target;
  // Адреса не из списка зависят от цели, чтобы при переходе на любой узел карта не содержала дублей.
  const salt = T.slice(0, 6);
  const ad = (k: string) => addr(salt + k);
  let W = mkMockWallets('');
  if (Object.values(W).some((w) => w.address === T)) W = mkMockWallets('-alt');
  const I1 = ad('inter-1');
  const I2 = ad('inter-2');
  const F1 = ad('funder-1');
  const F2 = ad('funder-2');
  const HUB = ad('binance-2');
  const JITO = ad('jito-tip');
  const D1 = ad('deposit-1');
  const S1 = ad('sibling-1');
  const S2 = ad('sibling-2');
  const S3 = ad('sibling-3');
  const S4 = ad('sibling-4');
  const O1 = ad('other-1');
  const O2 = ad('other-2');
  const O3 = ad('other-3');
  const baseT = 1731500000;

  const edgeId = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  let counter = 0;
  const edges: GraphEdge[] = [];
  /** from → to: solAB; to → from: solBA. Строит ребро с правдоподобными переводами. */
  function mk(
    a: string,
    b: string,
    solAB: number,
    solBA: number,
    opts: { tokens?: number; count?: number; fundingOf?: string; strength: number; t0?: number; coBuy?: { mints: number; slots: number }; fees?: { payer: string; txCount: number } },
  ): GraphEdge {
    const [source, target2] = a < b ? [a, b] : [b, a];
    const solForward = a < b ? solAB : solBA;
    const solBackward = a < b ? solBA : solAB;
    const count = opts.count ?? 4;
    const tokens = opts.tokens ?? 0;
    const t0 = opts.t0 ?? baseT - 86400 * 40;
    const transfers: TransferRecord[] = [];
    // count = 0: ребро состоит только из совместных покупок
    const nSol = count === 0 ? 0 : Math.max(1, count - tokens);
    for (let i = 0; i < nSol; i++) {
      const fwd = solForward > 0 && (solBackward === 0 || i % 2 === 0);
      const total = fwd ? solForward : solBackward;
      const share = total / Math.ceil(nSol / (solForward > 0 && solBackward > 0 ? 2 : 1));
      transfers.push({
        signature: sig(`${a}${b}${i}${counter++}`),
        blockTime: t0 + i * 86400 * 3 + (i % 3) * 3600,
        slot: 290000000 + counter * 1500,
        from: fwd ? source : target2,
        to: fwd ? target2 : source,
        mint: SOL,
        symbol: 'SOL',
        amount: Math.round(share * 1000) / 1000,
      });
    }
    for (let i = 0; i < tokens; i++) {
      transfers.push({
        signature: sig(`${a}${b}tok${i}${counter++}`),
        blockTime: t0 + 86400 * (i + 1) * 5,
        slot: 290100000 + counter * 1500,
        from: i % 2 ? source : target2,
        to: i % 2 ? target2 : source,
        mint: USDC,
        symbol: 'USDC',
        amount: 250 * (i + 2),
      });
    }
    // Совместные покупки: оба кошелька покупают токен у пула в одном слоте, разными транзакциями
    const nPlain = transfers.length;
    if (opts.coBuy) {
      const pool = ad('pool');
      const syms = ['BONK', 'WIF', 'POPCAT', 'MEW'];
      for (let i = 0; i < opts.coBuy.slots; i++) {
        const slot = 291000000 + i * 4000 + counter;
        const bt = t0 + 86400 * (i + 2) * 4;
        const mi = i % Math.max(1, opts.coBuy.mints);
        for (const [k, w] of [a, b].entries()) {
          transfers.push({
            signature: sig(`${a}${b}buy${i}${k}${counter++}`),
            blockTime: bt + k,
            slot,
            from: pool,
            to: w,
            mint: addr('mint' + mi),
            symbol: syms[mi % syms.length]!,
            amount: 120000 + 35000 * i + 9000 * k,
            coBuy: true,
          });
        }
      }
    }
    transfers.sort((x, y) => (y.blockTime ?? 0) - (x.blockTime ?? 0));
    const times = transfers.map((t) => t.blockTime ?? 0);
    const e: GraphEdge = {
      id: edgeId(a, b),
      source,
      target: target2,
      solForward,
      solBackward,
      tokenTransferCount: tokens,
      transferCount: nPlain,
      firstTime: times.length ? Math.min(...times) : null,
      lastTime: times.length ? Math.max(...times) : null,
      strength: opts.strength,
      transfers,
      ...(opts.fundingOf ? { fundingOf: opts.fundingOf } : {}),
      ...(opts.coBuy ? { coBuy: opts.coBuy } : {}),
      ...(opts.fees ? { feesPaid: opts.fees } : {}),
    };
    edges.push(e);
    return e;
  }

  // Прямые
  mk(T, W.cupsey.address, 312.4, 148.9, { count: 9, tokens: 2, strength: 0.95 });
  mk(T, W.marcel.address, 1.6, 0, { count: 2, strength: 0.28, coBuy: { mints: 3, slots: 2 } });
  // Только совместные покупки, переводов между кошельками нет
  mk(T, W.yugi.address, 0, 0, { count: 0, strength: 0.5, coBuy: { mints: 4, slots: 3 } });
  // Общий источник: I1 пополнил цель, Cupsey Side и Frank
  mk(I1, T, 24, 0, { count: 3, fundingOf: T, strength: 0.6, t0: baseT - 86400 * 120 });
  mk(I1, W.cupseySide.address, 18.5, 0, { count: 2, strength: 0.55, t0: baseT - 86400 * 110 });
  mk(I1, W.frank.address, 6, 0, { count: 2, strength: 0.38, t0: baseT - 86400 * 100 });
  // Через посредника I2 (смешанные направления) и общий получатель
  mk(T, I2, 42.7, 12.3, { count: 8, strength: 0.7 });
  mk(I2, W.frankDev.address, 9.8, 3.1, { count: 5, tokens: 1, strength: 0.52 });
  mk(I2, W.cupseySide.address, 4.2, 2.4, { count: 3, strength: 0.4 });
  mk(W.cupsey2.address, I2, 55, 0, { count: 3, strength: 0.5 });
  // Цепочка финансирования: HUB → F2 → F1 → T, Marcel Side → F2
  mk(F1, T, 8.2, 0, { count: 1, fundingOf: T, strength: 0.45, t0: baseT - 86400 * 220 });
  mk(F2, F1, 8.6, 0, { count: 1, fundingOf: F1, strength: 0.45, t0: baseT - 86400 * 230 });
  mk(HUB, F2, 9, 0, { count: 1, fundingOf: F2, strength: 0.3, t0: baseT - 86400 * 240 });
  mk(W.marcelSide.address, F2, 3.5, 0, { count: 2, strength: 0.33, t0: baseT - 86400 * 236 });
  // Депозитный адрес биржи: цель, Frank и кандидат S3 пополняют один адрес, который сливает всё на Binance
  mk(T, D1, 40, 0, { count: 3, strength: 0.5 });
  mk(W.frank.address, D1, 12, 0, { count: 2, strength: 0.4 });
  mk(S3, D1, 31, 0, { count: 3, strength: 0.5 });
  mk(D1, HUB, 83, 0, { count: 4, strength: 0.4 });
  // Вероятные кошельки того же владельца
  mk(T, S1, 64, 0.8, { count: 6, tokens: 2, fundingOf: S1, strength: 0.85 });
  mk(I1, S2, 11, 0, { count: 2, fundingOf: S2, strength: 0.5, t0: baseT - 86400 * 105 });
  mk(T, S4, 0, 0, { count: 0, strength: 0.4, coBuy: { mints: 2, slots: 2 } });
  // Только оплата комиссий: переводов нет
  mk(T, S2, 0, 0, { count: 0, strength: 0.4, fees: { payer: S2, txCount: 6 } });
  mk(T, W.marcelSide.address, 0, 0, { count: 0, strength: 0.35, fees: { payer: T, txCount: 4 } });
  // Инфраструктура
  mk(T, JITO, 0.8, 0, { count: 14, strength: 0.1 });
  // Прочие контрагенты
  mk(T, O1, 0, 96.3, { count: 6, tokens: 3, strength: 0.2 });
  mk(T, O2, 14.1, 0.4, { count: 5, strength: 0.15 });
  mk(O3, T, 2.2, 0, { count: 2, tokens: 1, strength: 0.1 });

  const eid = (a: string, b: string) => edgeId(a, b);
  const p = (
    type: ConnectionPath['type'],
    nodes: string[],
    score: number,
    reason: string,
  ): ConnectionPath => ({
    type,
    nodes,
    edgeIds: nodes.slice(0, -1).map((n, i) => eid(n, nodes[i + 1]!)),
    score,
    reason,
  });

  const sumEdges = (ids: string[]) => {
    const set = new Set(ids);
    const es = edges.filter((e) => set.has(e.id));
    return {
      totalSol: es.reduce((s, e) => s + e.solForward + e.solBackward, 0),
      transferCount: es.reduce((s, e) => s + e.transferCount, 0),
      firstTime: Math.min(...es.map((e) => e.firstTime ?? Infinity)),
      lastTime: Math.max(...es.map((e) => e.lastTime ?? 0)),
    };
  };
  const conn = (wallet: TrackedWallet, paths: ConnectionPath[], score: number): Connection => {
    const ids = [...new Set(paths.flatMap((x) => x.edgeIds))];
    return { wallet, score, hops: Math.min(...paths.map((x) => x.edgeIds.length)), paths, ...sumEdges(ids) };
  };

  const connections: Connection[] = [
    conn(
      W.cupsey,
      [p('direct', [T, W.cupsey.address], 0.95, 'Прямые переводы: 312,4 SOL от цели и 148,9 SOL обратно за 9 транзакций.')],
      0.95,
    ),
    conn(
      W.cupseySide,
      [
        p('common-funder', [T, I1, W.cupseySide.address], 0.55, 'Один и тот же кошелёк пополнил цель (24 SOL) и «Cupsey Side» (18,5 SOL) в течение недели.'),
        p('via-intermediary', [T, I2, W.cupseySide.address], 0.4, 'Обмен с посредником в обе стороны, через него проходят и средства «Cupsey Side».'),
      ],
      0.71,
    ),
    conn(
      W.cupsey2,
      [p('common-recipient', [T, I2, W.cupsey2.address], 0.5, 'И цель, и «Cupsey 2» отправляли SOL на один и тот же кошелёк-посредник.')],
      0.5,
    ),
    conn(
      W.frankDev,
      [p('via-intermediary', [T, I2, W.frankDev.address], 0.52, 'Цель и «Frank DEV» обмениваются SOL с общим посредником в обе стороны.')],
      0.52,
    ),
    conn(
      W.frank,
      [
        p('shared-deposit', [T, D1, W.frank.address], 0.46, 'Цель и «Frank» пополняли один и тот же депозитный адрес Binance.'),
        p('common-funder', [T, I1, W.frank.address], 0.38, 'Общий источник пополнения: один кошелёк отправил SOL и цели, и «Frank».'),
      ],
      0.58,
    ),
    conn(
      W.marcelSide,
      [
        p('funding-chain', [T, F1, F2, W.marcelSide.address], 0.33, '«Marcel Side» стоит в цепочке финансирования выше цели: через 2 звена.'),
        p('fee-payer', [T, W.marcelSide.address], 0.85, 'Цель оплачивала комиссии за 4 транзакции этого кошелька (из последних 100).'),
      ],
      0.85,
    ),
    conn(
      W.yugi,
      [p('co-buy', [T, W.yugi.address], 0.64, 'Покупали одни и те же токены в одном слоте: 4 токена, 3 слота — так обычно работают бандлы одного владельца.')],
      0.64,
    ),
    conn(
      W.marcel,
      [p('direct', [T, W.marcel.address], 0.28, 'Единичные прямые переводы: 1,6 SOL от цели.')],
      0.28,
    ),
  ];
  connections.sort((a, b) => b.score - a.score);

  const vol = new Map<string, number>();
  for (const e of edges) {
    const t = e.solForward + e.solBackward;
    vol.set(e.source, (vol.get(e.source) ?? 0) + t);
    vol.set(e.target, (vol.get(e.target) ?? 0) + t);
  }
  const node = (id: string, kind: GraphNode['kind'], label: string, hop: number, extra: Partial<GraphNode> = {}): GraphNode => ({
    id,
    kind,
    label,
    hop,
    volumeSol: Math.round((vol.get(id) ?? 0) * 100) / 100,
    ...extra,
  });
  const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
  const tn = (w: TrackedWallet, hop: number, score: number): GraphNode =>
    node(w.address, 'tracked', w.name, hop, {
      emoji: w.emoji,
      entity: w.entity,
      entityName: w.entityName,
      groups: w.groups,
      score,
      degree: 6 + (hop * 7) % 11,
    });
  const sc = (w: TrackedWallet) => connections.find((c) => c.wallet.address === w.address)!.score;

  const nodes: GraphNode[] = [
    node(T, 'target', short(T), 0, { degree: 57 }),
    tn(W.cupsey, 1, sc(W.cupsey)),
    tn(W.marcel, 1, sc(W.marcel)),
    tn(W.cupseySide, 2, sc(W.cupseySide)),
    tn(W.cupsey2, 2, sc(W.cupsey2)),
    tn(W.frank, 2, sc(W.frank)),
    tn(W.frankDev, 2, sc(W.frankDev)),
    tn(W.marcelSide, 3, sc(W.marcelSide)),
    tn(W.yugi, 1, sc(W.yugi)),
    node(I1, 'intermediary', short(I1), 1, { degree: 14 }),
    node(I2, 'intermediary', short(I2), 1, { degree: 9 }),
    node(F1, 'funder', short(F1), 1),
    node(F2, 'funder', short(F2), 2),
    node(HUB, 'hub', 'Binance 2', 3, { hubLabel: 'Binance 2', hubCategory: 'cex', degree: 100000 }),
    node(JITO, 'hub', 'Jito tip', 1, { hubLabel: 'Jito tip', hubCategory: 'jito', degree: 50000 }),
    node(D1, 'intermediary', short(D1), 1, { depositOf: 'Binance', degree: 5 }),
    node(S1, 'sibling', short(S1), 1, { score: 0.86, degree: 8 }),
    node(S2, 'sibling', short(S2), 2, { score: 0.52, degree: 4 }),
    node(S3, 'sibling', short(S3), 2, { score: 0.61, degree: 6 }),
    node(S4, 'sibling', short(S4), 1, { score: 0.47, degree: 3 }),
    node(O1, 'other', short(O1), 1),
    node(O2, 'other', short(O2), 1),
    node(O3, 'other', short(O3), 1),
  ];

  const entMap = new Map<string, EntityConnection>();
  for (const c of connections) {
    const w = c.wallet;
    const cur = entMap.get(w.entity);
    if (cur) {
      cur.wallets.push(w.address);
      cur.score = Math.max(cur.score, c.score);
    } else {
      entMap.set(w.entity, { entity: w.entity, entityName: w.entityName, emoji: w.emoji, score: c.score, wallets: [w.address] });
    }
  }
  const entities = [...entMap.values()].sort((a, b) => b.score - a.score);

  const siblings: SiblingCandidate[] =
    depth === 1
      ? []
      : [
          {
            address: S1,
            score: 0.86,
            signals: ['funded-by-target', 'two-way', 'token-moves'],
            reasons: [
              'Цель — первый источник SOL этого кошелька (64 SOL).',
              'Есть переводы SOL обратно (0,8 SOL).',
              'Между кошельками перемещались токены (USDC).',
            ],
            edgeIds: [eid(T, S1)],
            totalSol: 64.8,
            transferCount: 6,
          },
          {
            address: S3,
            score: 0.61,
            signals: ['shared-deposit'],
            reasons: ['Оба кошелька пополняли один и тот же депозитный адрес Binance.'],
            edgeIds: [eid(T, D1), eid(S3, D1)],
            totalSol: 0,
            transferCount: 0,
          },
          {
            address: S4,
            score: 0.47,
            signals: ['co-buy'],
            reasons: ['Покупали одни и те же токены в одном слоте: 2 токена, 2 слота.'],
            edgeIds: [eid(T, S4)],
            totalSol: 0,
            transferCount: 0,
          },
          {
            address: S2,
            score: 0.52,
            signals: ['common-funder', 'fee-payer'],
            reasons: ['У цели и этого кошелька один и тот же первый источник SOL.', 'Этот кошелёк оплачивал комиссии за 6 транзакций цели (из последних 100).'],
            edgeIds: [eid(I1, T), eid(I1, S2), eid(T, S2)],
            totalSol: 0,
            transferCount: 0,
          },
        ];

  return {
    target: T,
    targetTracked: null,
    generatedAt: Math.floor(Date.now() / 1000),
    options: { depth, maxTransfers: 2000, minSol: 0.01, maxIntermediaries: 12, refresh: false },
    nodes,
    edges,
    connections,
    entities,
    siblings: [...siblings].sort((x, y) => y.score - x.score),
    warnings: [
      'История цели загружена не полностью: достигнут лимит 2000 переводов, более ранние связи могут быть не найдены.',
      'Кошелёк «Binance 2» распознан как биржа, цепочка финансирования дальше не раскрывается.',
    ],
    stats: {
      provider: MOCK_STATUS.provider,
      transfersLoaded: 1874,
      walletsFetched: 14,
      apiCalls: 61,
      creditsEstimate: 0,
      durationMs: 2140,
      truncated: true,
    },
  };
}

/** Демо-связь двух кошельков. Адреса, начинающиеся с «1111», дают пустой результат. */
export function buildMockLink(a: string, b: string, maxHops: 2 | 3 | 4): LinkResult {
  const salt = a.slice(0, 4) + b.slice(0, 4);
  const ad = (k: string) => addr(salt + k);
  const CF = ad('common-funder');
  const M1 = ad('mid-1');
  const M2 = ad('mid-2');
  const DEP = ad('deposit');
  const HUB = ad('hub');
  const X1 = ad('x1');
  const X3 = ad('x3');
  const baseT = 1731500000;
  const edgeId = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);
  let counter = 0;
  const edges = new Map<string, GraphEdge>();
  function mk(from: string, to: string, sol: number, opts: { count?: number; funding?: boolean; strength: number; t0?: number }) {
    const [source, target] = from < to ? [from, to] : [to, from];
    const count = opts.count ?? 2;
    const t0 = opts.t0 ?? baseT - 86400 * 50;
    const transfers: TransferRecord[] = [];
    for (let i = 0; i < count; i++) {
      transfers.push({
        signature: sig(`${from}${to}${i}${counter++}`),
        blockTime: t0 + i * 86400 * 2,
        slot: 290000000 + counter * 1500,
        from,
        to,
        mint: SOL,
        symbol: 'SOL',
        amount: Math.round((sol / count) * 1000) / 1000,
      });
    }
    transfers.sort((x, y) => (y.blockTime ?? 0) - (x.blockTime ?? 0));
    const fwd = from === source;
    edges.set(edgeId(from, to), {
      id: edgeId(from, to),
      source,
      target,
      solForward: fwd ? sol : 0,
      solBackward: fwd ? 0 : sol,
      tokenTransferCount: 0,
      transferCount: count,
      firstTime: transfers[transfers.length - 1]!.blockTime,
      lastTime: transfers[0]!.blockTime,
      strength: opts.strength,
      transfers,
      ...(opts.funding ? { fundingOf: to } : {}),
    });
  }
  /** Совместные покупки: оба кошелька покупают токены у пула в одном слоте. */
  function mkCoBuy(x: string, y: string, mints: number, slots: number, strength: number) {
    const [source, target] = x < y ? [x, y] : [y, x];
    const pool = ad('pool');
    const transfers: TransferRecord[] = [];
    for (let i = 0; i < slots; i++) {
      const slot = 291000000 + i * 4000;
      for (const [k, w] of [x, y].entries()) {
        transfers.push({
          signature: sig(`${x}${y}buy${i}${k}${counter++}`),
          blockTime: baseT - 86400 * (20 - i * 3) + k,
          slot,
          from: pool,
          to: w,
          mint: addr('mint' + (i % mints)),
          symbol: ['BONK', 'WIF', 'POPCAT'][i % 3]!,
          amount: 90000 + 20000 * i + 7000 * k,
          coBuy: true,
        });
      }
    }
    transfers.sort((p, q) => (q.blockTime ?? 0) - (p.blockTime ?? 0));
    edges.set(edgeId(x, y), {
      id: edgeId(x, y),
      source,
      target,
      solForward: 0,
      solBackward: 0,
      tokenTransferCount: 0,
      transferCount: 0,
      firstTime: transfers[transfers.length - 1]!.blockTime,
      lastTime: transfers[0]!.blockTime,
      strength,
      coBuy: { mints, slots },
      transfers,
    });
  }
  const mkPath = (type: LinkPath['type'], nodes: string[], score: number, reason: string): LinkPath => ({
    type,
    nodes,
    edgeIds: nodes.slice(0, -1).map((n, i) => edgeId(n, nodes[i + 1]!)),
    score,
    reason,
  });

  const none = a.startsWith('1111') || b.startsWith('1111');
  const paths: LinkPath[] = [];
  if (!none) {
    mk(CF, a, 18, { funding: true, strength: 0.6, t0: baseT - 86400 * 90 });
    mk(CF, b, 14.5, { funding: true, strength: 0.55, t0: baseT - 86400 * 88 });
    paths.push(mkPath('common-funder', [a, CF, b], 0.62, 'Один и тот же кошелёк первым пополнил оба адреса (18 SOL и 14,5 SOL с разницей в два дня).'));
    mkCoBuy(a, b, 2, 3, 0.45);
    paths.push(mkPath('co-buy', [a, b], 0.48, 'Покупали одни и те же токены в одном слоте: 2 токена, 3 слота — так обычно работают бандлы одного владельца.'));
    mk(a, DEP, 25, { strength: 0.5 });
    mk(b, DEP, 22, { strength: 0.5 });
    mk(DEP, HUB, 47, { strength: 0.4 });
    paths.push(mkPath('shared-deposit', [a, DEP, b], 0.55, 'Оба кошелька отправляли SOL на один и тот же депозитный адрес Binance.'));
    if (maxHops >= 3) {
      mk(a, M1, 33, { count: 4, strength: 0.6 });
      mk(M1, M2, 30, { count: 3, strength: 0.55 });
      mk(M2, b, 28, { count: 3, strength: 0.5 });
      paths.push(mkPath('via-intermediary', [a, M1, M2, b], 0.41, 'Средства идут по цепочке из двух посредников: 33 SOL от первого кошелька и 28 SOL на второй.'));
    }
    if (maxHops >= 4) {
      mk(X1, a, 6, { funding: true, strength: 0.3, t0: baseT - 86400 * 200 });
      mk(HUB, X1, 6.4, { funding: true, strength: 0.3, t0: baseT - 86400 * 210 });
      mk(HUB, X3, 5, { funding: true, strength: 0.25, t0: baseT - 86400 * 205 });
      mk(X3, b, 4.8, { funding: true, strength: 0.25, t0: baseT - 86400 * 204 });
      paths.push(mkPath('funding-chain', [a, X1, HUB, X3, b], 0.18, 'Оба кошелька получили стартовые средства с одной биржи (4 шага).'));
    }
  }
  paths.sort((x, y) => y.score - x.score);
  const score = paths.length ? Math.round((1 - paths.reduce((p, x) => p * (1 - x.score), 1)) * 100) / 100 : 0;

  const vol = new Map<string, number>();
  for (const e of edges.values()) {
    const t = e.solForward + e.solBackward;
    vol.set(e.source, (vol.get(e.source) ?? 0) + t);
    vol.set(e.target, (vol.get(e.target) ?? 0) + t);
  }
  const short = (x: string) => `${x.slice(0, 4)}…${x.slice(-4)}`;
  const nd = (id: string, kind: GraphNode['kind'], hop: number, extra: Partial<GraphNode> = {}): GraphNode => ({
    id,
    kind,
    label: short(id),
    hop,
    volumeSol: Math.round((vol.get(id) ?? 0) * 100) / 100,
    ...extra,
  });
  const nodes: GraphNode[] = [nd(a, 'target', 0), nd(b, 'pair', paths.length ? Math.max(...paths.map((p) => p.edgeIds.length)) : 2)];
  if (!none) {
    nodes.push(nd(CF, 'intermediary', 1), nd(DEP, 'intermediary', 1, { depositOf: 'Binance' }), nd(HUB, 'hub', 2, { hubLabel: 'Binance 2', hubCategory: 'cex', label: 'Binance 2' }));
    if (maxHops >= 3) nodes.push(nd(M1, 'intermediary', 1), nd(M2, 'intermediary', 2));
    if (maxHops >= 4) nodes.push(nd(X1, 'funder', 1), nd(X3, 'funder', 3));
  }

  return {
    a,
    b,
    aTracked: null,
    bTracked: null,
    generatedAt: Math.floor(Date.now() / 1000),
    options: { maxHops, minSol: 0.01, refresh: false },
    score,
    paths,
    nodes,
    edges: [...edges.values()],
    warnings: none ? ['Демо: адреса, начинающиеся с «1111», всегда дают пустой результат.'] : ['Кошелёк «Binance 2» распознан как биржа, через него пути не раскрываются дальше.'],
    stats: { provider: MOCK_STATUS.provider, transfersLoaded: 3120, walletsFetched: 9, apiCalls: 38, creditsEstimate: 0, durationMs: 3400, truncated: false },
  };
}
