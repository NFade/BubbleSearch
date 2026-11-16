import type { BundleMatch, BundleRequest, BundleResult, BundleSignal, BundleToken, BundleWallet } from '../../shared/types.ts';
import { addr, mockTracked, sig } from './mock.ts';

export const MOCK_BUNDLE_PROGRESS = [
  'Читаю последние сделки цели и выбираю купленные токены…',
  'Определяю слоты покупок и продаж каждого токена…',
  'Нахожу пулы токенов (контрагентов сделок цели)…',
  'Читаю историю пулов в окне сделок (3 из 10)…',
  'Читаю историю пулов в окне сделок (8 из 10)…',
  'Ищу кошельки, торговавшие теми же токенами в те же минуты…',
  'Отсеиваю ботов, сэндвичи и программы…',
  'Считаю оценки и собираю результат…',
];

const SLOT0 = 312_400_000;

/** Демо-результат поиска бандла: ~8 токенов, ~12 кошельков с разными признаками, один из списка, один найденный через второй круг. */
export function buildMockBundle(req: BundleRequest): BundleResult {
  const target = req.address;
  const tracked = mockTracked();
  const now = Math.floor(Date.now() / 1000);
  const win = req.windowMin ?? 5;
  const sells = req.sells ?? true;
  const expand = req.expand ?? false;
  const nTokens = Math.min(8, req.tokens ?? 10);

  const tokens: BundleToken[] = [];
  for (let i = 0; i < nTokens; i++) {
    const mint = addr(`mint-${i}`);
    const buySlot = SLOT0 - i * 41_000;
    const sold = sells && i % 3 !== 2;
    tokens.push({
      mint,
      symbol: `${mint.slice(0, 4)}…${mint.slice(-4)}`,
      seed: target,
      pool: i === 5 ? null : addr(`pool-${i}`),
      buySlot,
      buyTime: now - 3600 * (i * 5 + 2),
      buySignature: sig(`buy-${i}`),
      sellSlot: sold ? buySlot + 900 + i * 37 : null,
      sellTime: sold ? now - 3600 * (i * 5 + 2) + 380 : null,
      sellSignature: sold ? sig(`sell-${i}`) : null,
      crowd: 4 + ((i * 7) % 23),
      matched: 0,
      transfersScanned: i === 5 ? 0 : 180 + i * 61,
      truncated: i === 3,
      skipped: i === 5 ? 'пул не найден (токен вне бондинг-кривой и известных пулов)' : null,
    });
  }
  const viaSeed = addr('w-1');
  if (expand) {
    const mint = addr('mint-x');
    tokens.push({
      mint,
      symbol: `${mint.slice(0, 4)}…${mint.slice(-4)}`,
      seed: viaSeed,
      pool: addr('pool-x'),
      buySlot: SLOT0 - 400_000,
      buyTime: now - 86400 * 4,
      buySignature: sig('buy-x'),
      sellSlot: null,
      sellTime: null,
      sellSignature: null,
      crowd: 9,
      matched: 1,
      transfersScanned: 240,
      truncated: false,
      skipped: null,
    });
  }

  const mkMatch = (ti: number, kind: 'buy' | 'sell', signal: BundleMatch['signal'], dtSec: number | null, weight: number, tag: string, sol: number | null, seed = target): BundleMatch => {
    const t = tokens[ti]!;
    const base = (kind === 'buy' ? t.buyTime : t.sellTime) ?? null;
    return {
      mint: t.mint,
      kind,
      seed,
      signal,
      dtSec,
      slotDelta: dtSec == null ? 0 : Math.round(dtSec / 0.4),
      signature: sig(`m-${tag}-${ti}-${kind}`),
      seedSignature: (kind === 'buy' ? t.buySignature : t.sellSignature) ?? sig('seed'),
      time: base != null && dtSec != null ? base + dtSec : base,
      sol,
      weight,
    };
  };

  type Spec = { key: string; score: number; signals: BundleSignal[]; toks: number[]; signal: BundleMatch['signal']; dt: number; trackedIdx?: number; via?: string; transfers?: [number, number]; copy?: boolean; funder?: string; overlap?: number; reasons: string[] };
  const spec: Spec[] = [
    { key: 'w-0', score: 0.96, signals: ['same-tx', 'same-slot', 'co-sell', 'transfers', 'funded-by-target', 'overlap'], toks: [0, 1, 2, 3, 4, 6, 7], signal: 'same-slot', dt: 0, transfers: [14.2, 5], funder: target, overlap: 0.92, reasons: ['Купил в одной транзакции с целью в токене 1 из 8.', 'Покупал в том же слоте в 7 токенах.', 'Продавал вместе с целью в 5 токенах.', 'Цель первой пополнила этот кошелёк.', 'Есть прямые переводы с целью: 14,2 SOL, 5 переводов.'] },
    { key: 'w-1', score: 0.88, signals: ['same-slot', 'near', 'co-sell', 'common-funder', 'overlap'], toks: [0, 1, 2, 4, 6, 7], signal: 'same-slot', dt: 0, funder: addr('funder-a'), overlap: 0.8, reasons: ['Покупал в том же слоте в 6 токенах.', 'Продавал вместе с целью в 4 токенах.', 'Общий первый источник SOL с целью.'] },
    { key: 'cupsey', score: 0.81, signals: ['near', 'co-sell', 'overlap'], toks: [0, 1, 3, 4, 6], signal: 'near', dt: 6, trackedIdx: 0, overlap: 0.7, reasons: ['Покупал в пределах 30 секунд от цели в 5 токенах.', 'Продавал вместе с целью в 3 токенах.'] },
    { key: 'w-3', score: 0.74, signals: ['near', 'co-sell'], toks: [1, 2, 3, 7], signal: 'near', dt: -12, reasons: ['Покупал в пределах 30 секунд от цели в 4 токенах.'] },
    { key: 'w-4', score: 0.66, signals: ['same-slot', 'near', 'common-funder'], toks: [0, 2, 4, 6], signal: 'same-slot', dt: 0, funder: addr('funder-a'), reasons: ['Покупал в том же слоте в 4 токенах.', 'Общий первый источник SOL с кошельком из списка выше.'] },
    { key: 'w-5', score: 0.61, signals: ['near', 'window'], toks: [2, 3, 6], signal: 'near', dt: 21, reasons: ['Покупал в пределах 30 секунд от цели в 3 токенах.'] },
    { key: 'w-6', score: 0.52, signals: ['window', 'transfers'], toks: [1, 4, 7], signal: 'window', dt: 95, transfers: [2.5, 2], reasons: ['Торговал в окне вокруг сделок цели в 3 токенах.', 'Есть прямые переводы с целью: 2,5 SOL, 2 перевода.'] },
    { key: 'w-7', score: 0.2, signals: ['near', 'copytrader'], toks: [0, 3, 6, 7], signal: 'near', dt: 8, copy: true, overlap: 0.15, reasons: ['Стабильно заходит через несколько секунд после цели и больше ничем не связан: похоже на копитрейдера.'] },
    { key: 'w-8', score: 0.38, signals: ['window'], toks: [2, 6], signal: 'window', dt: -140, reasons: ['Торговал в окне вокруг сделок цели в 2 токенах.'] },
    { key: 'w-9', score: 0.31, signals: ['window'], toks: [4, 7], signal: 'window', dt: 210, reasons: ['Торговал в окне в 2 токенах; в этих токенах толпа больше 20 кошельков.'] },
    { key: 'w-10', score: 0.18, signals: ['near', 'copytrader'], toks: [1, 5], signal: 'near', dt: 14, copy: true, reasons: ['Похоже на копитрейдера: заходит через несколько секунд после цели.'] },
    { key: 'w-11', score: 0.17, signals: ['window'], toks: [3], signal: 'window', dt: 60, reasons: ['Торговал в окне в одном токене.'] },
  ];
  if (expand) {
    spec.splice(6, 0, { key: 'w-x', score: 0.58, signals: ['same-slot', 'co-sell', 'common-funder'], toks: [nTokens], signal: 'same-slot', dt: 0, via: viaSeed, funder: addr('funder-a'), reasons: ['Найден во втором круге: торговал в том же слоте, что и кошелёк, через который найден.'] });
  }
  spec.sort((x, y) => y.score - x.score);

  const wallets: BundleWallet[] = spec.map((sp) => {
    const tw = sp.trackedIdx != null ? tracked[sp.trackedIdx] ?? null : null;
    const matches: BundleMatch[] = [];
    sp.toks.forEach((ti, k) => {
      const t = tokens[ti];
      if (!t || t.skipped) return;
      const dt = sp.dt === 0 ? 0 : sp.dt + ((k % 3) - 1) * 3;
      matches.push(mkMatch(ti, 'buy', sp.signal, dt, 0.1 + sp.score * 0.12, sp.key, -(0.4 + ti * 0.35), sp.via ?? target));
      if (sp.signals.includes('co-sell') && t.sellSignature) matches.push(mkMatch(ti, 'sell', sp.signal === 'same-slot' ? 'near' : 'window', 4 + k * 5, 0.08, sp.key, 0.5 + ti * 0.4));
    });
    if (sp.signals.includes('same-tx') && matches[0]) matches[0] = { ...matches[0], signal: 'same-tx', dtSec: 0, slotDelta: 0, weight: 0.5 };
    matches.sort((a, b) => b.weight - a.weight);
    return {
      address: addr(sp.key),
      score: sp.score,
      tokensMatched: sp.toks.filter((ti) => tokens[ti] && !tokens[ti]!.skipped).length,
      signals: sp.signals,
      reasons: sp.reasons,
      matches,
      tracked: tw,
      via: sp.via ?? null,
      totalSol: sp.transfers?.[0] ?? 0,
      transferCount: sp.transfers?.[1] ?? 0,
      firstFunder: expand ? sp.funder ?? null : null,
      overlap: expand ? sp.overlap ?? null : null,
      copytrader: !!sp.copy,
    };
  });
  for (const t of tokens) if (t.seed === target) t.matched = wallets.filter((w) => !w.via && w.matches.some((m) => m.mint === t.mint)).length;

  const scanned = tokens.filter((t) => !t.skipped).length * (sells ? 2 : 1);
  const transfers = tokens.reduce((n, t) => n + t.transfersScanned, 0) * (sells ? 2 : 1);
  return {
    target,
    targetTracked: tracked.find((t) => t.address === target) ?? null,
    generatedAt: Date.now(),
    options: { tokens: req.tokens ?? 10, windowMin: win, sells, expand, refresh: req.refresh ?? false },
    tokens,
    wallets,
    excluded: { bots: 7, sandwich: 3, programs: 2 },
    warnings: [
      'Токен с наибольшей толпой (23 кошелька): совпадения в нём учтены с пониженным весом.',
      ...(tokens.some((t) => t.truncated) ? ['У части токенов окно прочитано не полностью (предел страниц истории пула): результат по ним неполный.'] : []),
    ],
    stats: {
      provider: 'Helius (демо)',
      transfersLoaded: 1240,
      walletsFetched: 0,
      apiCalls: scanned * 6 + 6,
      creditsEstimate: transfers / 10 + (expand ? 600 : 0),
      durationMs: 14_400 + scanned * 900,
      truncated: false,
      tokensScanned: scanned,
      transfersScanned: transfers,
    },
  };
}
