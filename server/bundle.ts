// Поиск бандла: кошельки, которые покупают и продают те же токены, что и цель, в те же минуты.
//
// Идея. Бандл одного владельца (бот на многих кошельках) заходит в токен вместе с основным кошельком — в одной
// транзакции, одном слоте или в течение нескольких минут, — и часто вместе выходит. Поэтому:
// 1) из истории цели берутся её последние покупки токенов; у каждой сделки есть контрагент — пул токена
//    (бондинг-кривая pump.fun, пул PumpSwap, Meteora и т. п.);
// 2) по истории пула (getTransfersByAddress) читаются все сделки в окне ±windowMin минут вокруг покупки и продажи цели;
// 3) кошелёк, который торговал в окнах нескольких разных токенов, — кандидат. Совпадение весит тем больше, чем ближе
//    по времени (одна транзакция > слот > 30 с > окно) и чем меньше толпа в окне;
// 4) отсеиваются боты (десятки сделок в одном окне), сэндвичи (покупка и продажа за пару слотов) и аккаунты программ;
// 5) максимальный поиск: у сильных кандидатов загружаются первые пополнения и собственные покупки — общий источник SOL,
//    пополнение от цели и «покупает почти только токены цели» отличают бандл от копитрейдеров; затем второй круг
//    по токенам самых сильных кандидатов находит кошельки бандла, которые торговали без цели.

import type { BundleMatch, BundleOptions, BundleResult, BundleSignal, BundleToken, BundleWallet } from '../shared/types.ts';
import type { Classifier } from './accounts.ts';
import { SOL_MINT, USDC_MINT, USDT_MINT, WSOL_MINT, shortAddr } from './config.ts';
import type { Db } from './db.ts';
import type { Ctx } from './http.ts';
import { mapLimit } from './http.ts';
import type { Transfer, TransferProvider } from './providers/types.ts';
import { clamp, fmtSol, symbolOf, tokensText } from './scoring.ts';
import type { TrackedIndex } from './tracked.ts';
import type { LoadHistory } from './workspace.ts';
import { createWorkspace } from './workspace.ts';

/** Наибольшее число страниц истории пула (по 100 переводов, 10 кредитов) на одно окно. */
export const BUNDLE_MAX_PAGES = 20;
/** «Почти одновременно»: в пределах стольких секунд. */
export const NEAR_SEC = 30;
/** Больше стольких сделок одного кошелька в окне одного токена — бот или роутер. */
export const BOT_TRADES = 20;
/** Покупка и продажа одного кошелька не дальше стольких слотов друг от друга — сэндвич или скальп-бот. */
export const SANDWICH_SLOTS = 2;
/** Сила совпадения по признаку; в окне сила падает от NEAR до WINDOW_FAR к краю окна. */
const W_SAME_TX = 1;
const W_SAME_SLOT = 0.9;
const W_NEAR = 0.75;
const W_WINDOW_FAR = 0.4;
/** Продажа вместе весит меньше покупки: выходят вместе и копитрейдеры, и толпа на падении. */
const SELL_FACTOR = 0.8;
/** Совпадения в N токенах складываются как 1 − exp(−Σw / SCORE_SCALE): 2 токена «≤30 с» ≈ 0.6, 3 ≈ 0.75. */
const SCORE_SCALE = 1.6;
/** Толпа: при 3 и меньше других участниках совпадение весит полностью, при 50 — около 0.4, не меньше 0.25. */
const CROWD_REF = 200;
const CROWD_FULL = 3;
const CROWD_MIN_W = 0.25;
/** Признаки из максимального поиска и истории (складываются как 1 − Π(1 − w)). */
const W_TOKEN_MOVES = 0.7;
const W_SOL_TRANSFERS = 0.5;
const W_FUNDED_BY_TARGET = 0.75;
const W_COMMON_FUNDER_TARGET = 0.55;
const W_COMMON_FUNDER_BUNDLE = 0.4;
const W_OVERLAP = 0.5;
const OVERLAP_MIN = 0.5;
const OVERLAP_MIN_TOKENS = 3;
/** Копитрейдер: 3+ покупки, 80%+ с одной стороны от цели, медиана задержки ≤ 20 с. Без других признаков оценка × 0.6. */
const COPY_MIN_MATCHES = 3;
const COPY_SIDE_SHARE = 0.8;
const COPY_MEDIAN_SEC = 20;
const COPY_PENALTY = 0.6;
/** Второй круг: совпадение с кошельком первого круга весит score этого кошелька × ROUND2_DECAY. */
const ROUND2_DECAY = 0.85;
const EXPAND_CHECK = 15;
const EXPAND_SEEDS = 3;
const EXPAND_TOKENS = 4;
const EXPAND_SEED_MIN = 0.6;
const TARGET_RECENT = 2000;
const CANDIDATE_RECENT = 300;
const OLDEST_ROWS = 100;
const MIN_SCORE = 0.25;
const MAX_WALLETS = 60;
const MAX_MATCHES = 40;
const MIN_SOL = 0.01;

/** Адреса площадок, общие для всех пулов: их история — сделки по тысячам токенов, окно в минуты не прочитать. */
const SHARED_POOLS = new Map<string, string>([
  ['5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', 'Raydium AMM v4'],
  ['GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL', 'Raydium CPMM'],
  ['WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh', 'Raydium LaunchLab'],
  ['FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM', 'Meteora DBC'],
  ['HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC', 'Meteora DAMM v2'],
]);
/** Общий адрес площадки распознаётся и по истории: больше стольких разных токенов в прочитанном промежутке. */
const SHARED_MINTS = 3;
const SHARED_LABEL = 'Общий адрес площадки';

/** Адрес — общий для многих пулов: в его переводах много разных токенов, и наш — не основной. */
export function looksShared(mint: string, rows: Transfer[]): boolean {
  const tok = rows.filter((t) => !isBase(t.mint));
  if (tok.length < 20) return false;
  const mints = new Set(tok.map((t) => t.mint));
  return mints.size > SHARED_MINTS && tok.filter((t) => t.mint === mint).length / tok.length < 0.5;
}

const BASE = new Set([SOL_MINT, WSOL_MINT, USDC_MINT, USDT_MINT]);
const isBase = (m: string) => BASE.has(m);

/** Сделка кошелька с токеном: покупка или продажа через пул. */
export interface Trade {
  mint: string;
  kind: 'buy' | 'sell';
  signature: string;
  slot: number;
  time: number | null;
  /** Контрагент по токену: пул, бондинг-кривая. */
  pool: string;
  /** Количество токена. */
  amount: number;
  /** SOL, отданный (покупка) или полученный (продажа) в этой транзакции; null — не виден. */
  sol: number | null;
}

/**
 * Сделки кошелька по его переводам. Покупка — в одной транзакции кошелёк получил токен и что-то отдал
 * (SOL, стейблкоин, другой токен); продажа — наоборот. Перевод токена без встречной части — не сделка.
 */
export function extractTrades(wallet: string, transfers: Transfer[]): Trade[] {
  const bySig = new Map<string, Transfer[]>();
  for (const t of transfers) {
    if (t.from !== wallet && t.to !== wallet) continue;
    (bySig.get(t.signature) ?? bySig.set(t.signature, []).get(t.signature)!).push(t);
  }
  const out: Trade[] = [];
  for (const [signature, rows] of bySig) {
    const tokIn = rows.filter((t) => t.to === wallet && !isBase(t.mint) && t.uiAmount > 0);
    const tokOut = rows.filter((t) => t.from === wallet && !isBase(t.mint) && t.uiAmount > 0);
    const baseOut = rows.filter((t) => t.from === wallet && isBase(t.mint));
    const baseIn = rows.filter((t) => t.to === wallet && isBase(t.mint));
    const solOf = (list: Transfer[], pool: string) => {
      const sol = list.filter((t) => t.mint === SOL_MINT);
      if (sol.length === 0) return null;
      const toPool = sol.filter((t) => t.from === pool || t.to === pool);
      return (toPool.length ? toPool : sol).reduce((s, t) => s + t.uiAmount, 0);
    };
    const mintsIn = new Set(tokIn.map((t) => t.mint));
    const mintsOut = new Set(tokOut.map((t) => t.mint));
    for (const mint of mintsIn) {
      if (mintsOut.has(mint)) continue;
      const legs = tokIn.filter((t) => t.mint === mint);
      const paid = baseOut.length > 0 || tokOut.length > 0;
      if (!paid) continue;
      const main = legs.reduce((a, b) => (b.uiAmount > a.uiAmount ? b : a));
      out.push({ mint, kind: 'buy', signature, slot: main.slot, time: main.blockTime, pool: main.from, amount: legs.reduce((s, t) => s + t.uiAmount, 0), sol: solOf(baseOut, main.from) });
    }
    for (const mint of mintsOut) {
      if (mintsIn.has(mint)) continue;
      const legs = tokOut.filter((t) => t.mint === mint);
      const got = baseIn.length > 0 || tokIn.length > 0;
      if (!got) continue;
      const main = legs.reduce((a, b) => (b.uiAmount > a.uiAmount ? b : a));
      out.push({ mint, kind: 'sell', signature, slot: main.slot, time: main.blockTime, pool: main.to, amount: legs.reduce((s, t) => s + t.uiAmount, 0), sol: solOf(baseIn, main.to) });
    }
  }
  return out.sort((a, b) => b.slot - a.slot);
}

/** Токен для проверки: первая покупка (вход) и крупнейшая продажа (выход) в загруженной истории. */
export interface TokenPick {
  mint: string;
  buy: Trade;
  sell: Trade | null;
}

/** Последние n разных купленных токенов (по последней покупке, новые сверху). */
export function pickTokens(trades: Trade[], n: number, exclude: ReadonlySet<string> = new Set()): TokenPick[] {
  const byMint = new Map<string, Trade[]>();
  for (const t of trades) (byMint.get(t.mint) ?? byMint.set(t.mint, []).get(t.mint)!).push(t);
  const picks: Array<TokenPick & { last: number }> = [];
  for (const [mint, list] of byMint) {
    if (exclude.has(mint)) continue;
    const buys = list.filter((t) => t.kind === 'buy').sort((a, b) => a.slot - b.slot);
    if (buys.length === 0) continue;
    const sells = list.filter((t) => t.kind === 'sell' && t.slot >= buys[0]!.slot);
    const sell = sells.length ? sells.reduce((a, b) => (b.amount > a.amount ? b : a)) : null;
    picks.push({ mint, buy: buys[0]!, sell, last: buys[buys.length - 1]!.slot });
  }
  return picks.sort((a, b) => b.last - a.last).slice(0, n).map(({ last: _l, ...p }) => p);
}

/** Сделка с токеном по истории пула. */
export interface PoolTrade {
  wallet: string;
  kind: 'buy' | 'sell';
  signature: string;
  slot: number;
  time: number | null;
  amount: number;
  sol: number | null;
}

/** Сделки по токену mint из переводов пула: покупка — пул отдал токен кошельку, продажа — кошелёк отдал токен пулу. */
export function poolTrades(pool: string, mint: string, transfers: Transfer[]): PoolTrade[] {
  const bySig = new Map<string, Transfer[]>();
  for (const t of transfers) (bySig.get(t.signature) ?? bySig.set(t.signature, []).get(t.signature)!).push(t);
  const out: PoolTrade[] = [];
  for (const [signature, rows] of bySig) {
    const acc = new Map<string, PoolTrade>();
    for (const t of rows) {
      if (t.mint !== mint) continue;
      const kind = t.from === pool ? 'buy' : t.to === pool ? 'sell' : null;
      if (!kind) continue;
      const wallet = kind === 'buy' ? t.to : t.from;
      const key = `${wallet}:${kind}`;
      const cur = acc.get(key);
      if (cur) cur.amount += t.uiAmount;
      else acc.set(key, { wallet, kind, signature, slot: t.slot, time: t.blockTime, amount: t.uiAmount, sol: null });
    }
    for (const p of acc.values()) {
      const sol = rows.filter((t) => t.mint === SOL_MINT && (p.kind === 'buy' ? t.from === p.wallet && t.to === pool : t.from === pool && t.to === p.wallet));
      p.sol = sol.length ? sol.reduce((s, t) => s + t.uiAmount, 0) : null;
      out.push(p);
    }
  }
  return out.sort((a, b) => a.slot - b.slot);
}

export function crowdWeight(crowd: number): number {
  if (crowd <= CROWD_FULL) return 1;
  return clamp(Math.log(1 + CROWD_REF / crowd) / Math.log(1 + CROWD_REF / CROWD_FULL), CROWD_MIN_W, 1);
}

/** Признак и сила совпадения сделки кандидата со сделкой seed. */
export function matchWeight(seed: { signature: string; slot: number; time: number | null }, t: { signature: string; slot: number; time: number | null }, windowSec: number, crowd: number) {
  const dt = seed.time != null && t.time != null ? t.time - seed.time : null;
  if (t.signature === seed.signature) return { signal: 'same-tx' as const, dt, weight: W_SAME_TX };
  const cw = crowdWeight(crowd);
  if (t.slot === seed.slot) return { signal: 'same-slot' as const, dt, weight: W_SAME_SLOT * cw };
  const ad = dt == null ? windowSec : Math.abs(dt);
  if (ad <= NEAR_SEC) return { signal: 'near' as const, dt, weight: W_NEAR * cw };
  const far = clamp((ad - NEAR_SEC) / Math.max(1, windowSec - NEAR_SEC), 0, 1);
  return { signal: 'window' as const, dt, weight: (W_NEAR - (W_NEAR - W_WINDOW_FAR) * far) * cw };
}

/** Окно вокруг одной сделки seed. */
export interface WindowInput {
  mint: string;
  seed: string;
  seedTrade: { kind: 'buy' | 'sell'; signature: string; slot: number; time: number | null };
  /** Все сделки по токену в прочитанном промежутке (обе стороны: нужны для отсева сэндвичей). */
  trades: PoolTrade[];
  windowSec: number;
  /** Множитель силы (второй круг: score seed × ROUND2_DECAY). */
  factor: number;
}

export interface WindowOutcome {
  matches: Array<{ wallet: string; match: BundleMatch }>;
  crowd: number;
  bots: Set<string>;
  sandwich: Set<string>;
}

/** Совпадения в одном окне: для каждого кошелька — ближайшая сделка той же стороны. */
export function matchWindow(w: WindowInput, skip: ReadonlySet<string>): WindowOutcome {
  const { seedTrade: s } = w;
  const byWallet = new Map<string, PoolTrade[]>();
  for (const t of w.trades) {
    if (t.wallet === w.seed || skip.has(t.wallet)) continue;
    (byWallet.get(t.wallet) ?? byWallet.set(t.wallet, []).get(t.wallet)!).push(t);
  }
  const bots = new Set<string>();
  const sandwich = new Set<string>();
  const eligible = new Map<string, PoolTrade[]>();
  for (const [wallet, list] of byWallet) {
    if (list.length > BOT_TRADES) {
      bots.add(wallet);
      continue;
    }
    const buys = list.filter((t) => t.kind === 'buy');
    const sells = list.filter((t) => t.kind === 'sell');
    if (buys.some((b) => sells.some((x) => Math.abs(x.slot - b.slot) <= SANDWICH_SLOTS))) {
      sandwich.add(wallet);
      continue;
    }
    const same = (s.kind === 'buy' ? buys : sells).filter((t) => s.time == null || t.time == null || Math.abs(t.time - s.time) <= w.windowSec);
    if (same.length) eligible.set(wallet, same);
  }
  const crowd = eligible.size;
  const matches: WindowOutcome['matches'] = [];
  for (const [wallet, list] of eligible) {
    let best: { t: PoolTrade; m: ReturnType<typeof matchWeight> } | null = null;
    for (const t of list) {
      const m = matchWeight(s, t, w.windowSec, crowd);
      if (!best || m.weight > best.m.weight) best = { t, m };
    }
    if (!best) continue;
    matches.push({
      wallet,
      match: {
        mint: w.mint,
        kind: s.kind,
        seed: w.seed,
        signal: best.m.signal,
        dtSec: best.m.dt,
        slotDelta: best.t.slot - s.slot,
        signature: best.t.signature,
        seedSignature: s.signature,
        time: best.t.time,
        sol: best.t.sol,
        weight: Math.round(best.m.weight * w.factor * 1000) / 1000,
      },
    });
  }
  return { matches, crowd, bots, sandwich };
}

/** Оценка по совпадениям: по каждому токену — лучшая покупка и лучшая продажа, токены складываются. */
export function coTradeScore(matches: BundleMatch[]): { score: number; tokens: number } {
  const perToken = new Map<string, { buy: number; sell: number }>();
  for (const m of matches) {
    const p = perToken.get(m.mint) ?? perToken.set(m.mint, { buy: 0, sell: 0 }).get(m.mint)!;
    if (m.kind === 'buy') p.buy = Math.max(p.buy, m.weight);
    else p.sell = Math.max(p.sell, m.weight);
  }
  let base = 0;
  for (const p of perToken.values()) base += 1 - (1 - p.buy) * (1 - SELL_FACTOR * p.sell);
  return { score: 1 - Math.exp(-base / SCORE_SCALE), tokens: perToken.size };
}

/** Похоже на копитрейдера: покупки стабильно с одной стороны от цели с малой задержкой. */
export function looksLikeCopytrader(matches: BundleMatch[], seed: string): boolean {
  const dts = matches.filter((m) => m.kind === 'buy' && m.seed === seed && m.dtSec != null && m.signal !== 'same-tx').map((m) => m.dtSec!);
  if (dts.length < COPY_MIN_MATCHES) return false;
  const after = dts.filter((d) => d > 0).length;
  const before = dts.filter((d) => d < 0).length;
  if (Math.max(after, before) / dts.length < COPY_SIDE_SHARE) return false;
  const abs = dts.map(Math.abs).sort((a, b) => a - b);
  return abs[Math.floor(abs.length / 2)]! <= COPY_MEDIAN_SEC;
}

const combine = (ws: number[]) => 1 - ws.reduce((p, w) => p * (1 - clamp(w, 0, 1)), 1);

function fmtDt(sec: number | null): string {
  if (sec == null) return '';
  const a = Math.abs(sec);
  const t = a < 60 ? `${a} с` : `${Math.floor(a / 60)} мин${a % 60 ? ` ${a % 60} с` : ''}`;
  return sec === 0 ? 'в ту же секунду' : sec > 0 ? `через ${t}` : `за ${t} до`;
}

export interface BundleDeps {
  db: Db;
  provider: TransferProvider;
  classify: Classifier;
  tracked: () => TrackedIndex;
  loadHistory: LoadHistory;
}

interface Candidate {
  address: string;
  matches: BundleMatch[];
  via: string | null;
  extras: Array<{ signal: BundleSignal; w: number; reason: string }>;
  copytrader: boolean;
  firstFunder: string | null;
  overlap: number | null;
  totalSol: number;
  transferCount: number;
}

export function createBundleFinder(deps: BundleDeps) {
  const { db, provider, classify } = deps;

  async function find(target: string, optsIn: BundleOptions, ctx: Ctx): Promise<BundleResult> {
    const startedAt = Date.now();
    const opts: Required<BundleOptions> = {
      tokens: clamp(Math.round(optsIn.tokens ?? 10), 3, 30),
      windowMin: ([1, 3, 5, 10, 30] as const).includes(optsIn.windowMin as any) ? optsIn.windowMin! : 5,
      sells: optsIn.sells !== false,
      expand: !!optsIn.expand,
      refresh: !!optsIn.refresh,
    };
    if (!provider.fetchWindow) throw new Error('Поиск бандла требует ключа Helius (метод getTransfersByAddress).');
    const windowSec = opts.windowMin * 60;
    const tracked = deps.tracked();
    const warnings: string[] = [];
    const ws = createWorkspace({ db, classify, tracked, loadHistory: deps.loadHistory, minSol: MIN_SOL, refresh: opts.refresh, ctx, self: new Set([target]) });
    let transfersScanned = 0;
    let tokensScanned = 0;
    let historiesLoaded = 0;
    const excluded = { bots: new Set<string>(), sandwich: new Set<string>(), programs: 0 };

    ctx.log('Загружаю историю кошелька…');
    const h = await ws.hist(target, TARGET_RECENT, OLDEST_ROWS);
    historiesLoaded++;
    const targetTrades = extractTrades(target, h.transfers);
    const picks = pickTokens(targetTrades, opts.tokens);
    if (picks.length === 0) {
      throw new Error('В загруженной истории кошелька нет покупок токенов — искать бандл не по чему.');
    }
    if (picks.length < opts.tokens) warnings.push(`В загруженной истории только ${tokensText(picks.length)} с покупками — проверены все.`);
    ctx.log(`Покупок токенов в истории: ${targetTrades.filter((t) => t.kind === 'buy').length}; проверяю ${tokensText(picks.length)}, окно ±${opts.windowMin} мин.`);

    /** Промежуток истории пула: из кэша или из сети. */
    async function readPool(pool: string, from: number, to: number): Promise<{ rows: Transfer[]; complete: boolean }> {
      const cached = opts.refresh ? null : db.getPoolWindow(pool, from, to);
      if (cached) return { rows: cached, complete: true };
      const r = await provider.fetchWindow!(pool, from, to, BUNDLE_MAX_PAGES, ctx);
      if (r.complete) db.setPoolWindow(pool, from, to, r.transfers);
      return { rows: r.transfers, complete: r.complete };
    }

    const tokens: BundleToken[] = [];
    const sharedSeen = new Set<string>();
    const cands = new Map<string, Candidate>();
    const cand = (a: string, via: string | null) =>
      cands.get(a) ?? cands.set(a, { address: a, matches: [], via, extras: [], copytrader: false, firstFunder: null, overlap: null, totalSol: 0, transferCount: 0 }).get(a)!;

    /** Проверка одного токена: окна вокруг покупки и продажи seed. */
    async function scanToken(seed: string, pick: TokenPick, withSells: boolean, factor: number, skip: ReadonlySet<string>): Promise<void> {
      const tok: BundleToken = {
        mint: pick.mint,
        symbol: symbolOf(pick.mint),
        seed,
        pool: pick.buy.pool,
        buySlot: pick.buy.slot,
        buyTime: pick.buy.time,
        buySignature: pick.buy.signature,
        sellSlot: withSells ? (pick.sell?.slot ?? null) : null,
        sellTime: withSells ? (pick.sell?.time ?? null) : null,
        sellSignature: withSells ? (pick.sell?.signature ?? null) : null,
        crowd: 0,
        matched: 0,
        transfersScanned: 0,
        truncated: false,
        skipped: null,
      };
      tokens.push(tok);
      const shared = SHARED_POOLS.get(pick.buy.pool) ?? (sharedSeen.has(pick.buy.pool) || db.getService(pick.buy.pool, 90 * 86400)?.label === SHARED_LABEL ? 'этой площадки' : undefined);
      if (shared) {
        tok.skipped = `Сделка шла через общий адрес площадки ${shared}: его история — сделки по всем токенам площадки, окно не прочитать.`;
        return;
      }
      if (pick.buy.time == null) {
        tok.skipped = 'Неизвестно время покупки.';
        return;
      }
      const events: Array<{ trade: Trade; pool: string }> = [{ trade: pick.buy, pool: pick.buy.pool }];
      if (withSells && pick.sell?.time != null && !SHARED_POOLS.has(pick.sell.pool) && !sharedSeen.has(pick.sell.pool)) events.push({ trade: pick.sell, pool: pick.sell.pool });
      // Окна одного пула, которые перекрываются, читаются одним промежутком.
      const ranges: Array<{ pool: string; from: number; to: number }> = [];
      for (const e of events) {
        const from = e.trade.time! - windowSec;
        const to = e.trade.time! + windowSec;
        const r = ranges.find((x) => x.pool === e.pool && from <= x.to && to >= x.from);
        if (r) {
          r.from = Math.min(r.from, from);
          r.to = Math.max(r.to, to);
        } else ranges.push({ pool: e.pool, from, to });
      }
      const rowsByPool = new Map<string, Transfer[]>();
      try {
        for (const r of ranges) {
          const got = await readPool(r.pool, r.from, r.to);
          if (!got.complete) tok.truncated = true;
          tok.transfersScanned += got.rows.length;
          rowsByPool.set(r.pool, [...(rowsByPool.get(r.pool) ?? []), ...got.rows]);
        }
      } catch (e) {
        tok.skipped = `Не удалось прочитать историю пула: ${e instanceof Error ? e.message : String(e)}`;
        return;
      }
      transfersScanned += tok.transfersScanned;
      // Общий адрес площадки: если окно прочитано целиком, сделки по нашему токену пригодны; если нет — токен пропускаем
      // и больше этот адрес не читаем.
      for (const [pool, rows] of rowsByPool) {
        if (!looksShared(pick.mint, rows)) continue;
        sharedSeen.add(pool);
        db.setService(pool, SHARED_LABEL, 'program');
        if (tok.truncated) {
          tok.skipped = `Контрагент ${shortAddr(pool)} — общий адрес площадки (сделки по многим токенам): окно не прочитано целиком.`;
          return;
        }
      }
      tokensScanned++;
      const matchedHere = new Set<string>();
      for (const e of events) {
        const trades = poolTrades(e.pool, pick.mint, rowsByPool.get(e.pool) ?? []);
        if (trades.length === 0 && (rowsByPool.get(e.pool)?.length ?? 0) > 0) {
          tok.skipped ??= 'В истории контрагента нет сделок с этим токеном: вероятно, сделка шла через маршрутизатор, а не напрямую через пул.';
          continue;
        }
        const out = matchWindow({ mint: pick.mint, seed, seedTrade: e.trade, trades, windowSec, factor }, skip);
        tok.crowd = Math.max(tok.crowd, out.crowd);
        for (const b of out.bots) excluded.bots.add(b);
        for (const s of out.sandwich) excluded.sandwich.add(s);
        for (const { wallet, match } of out.matches) {
          cand(wallet, seed === target ? null : seed).matches.push(match);
          matchedHere.add(wallet);
        }
      }
      if (tok.skipped && matchedHere.size > 0) tok.skipped = null;
      tok.matched = matchedHere.size;
    }

    let done = 0;
    await mapLimit(picks, 3, async (p) => {
      await scanToken(target, p, opts.sells, 1, new Set());
      done++;
      if (done % 3 === 0 || done === picks.length) ctx.log(`Проверено токенов: ${done} из ${picks.length}; кандидатов: ${cands.size}.`);
    });
    // Порядок токенов — как в выборке (новые сверху), а не в порядке завершения.
    const order = new Map(picks.map((p, i) => [p.mint, i]));
    tokens.sort((a, b) => (order.get(a.mint) ?? 0) - (order.get(b.mint) ?? 0));

    // Боты и сэндвичи в одном токене не участвуют в оценке нигде: это одни и те же MEV-кошельки.
    for (const a of [...excluded.bots, ...excluded.sandwich]) cands.delete(a);
    cands.delete(target);

    // Прямые переводы с целью (не сделки): токены между кошельками бандла и SOL на пополнение.
    const tradeSigs = new Set(targetTrades.map((t) => t.signature));
    for (const t of h.transfers) {
      const other = t.from === target ? t.to : t.to === target ? t.from : null;
      if (!other) continue;
      const c = cands.get(other);
      if (!c) continue;
      c.transferCount++;
      if (t.mint === SOL_MINT) c.totalSol += t.uiAmount;
    }
    for (const c of cands.values()) {
      if (c.transferCount === 0) continue;
      const tokMoves = h.transfers.filter((t) => !isBase(t.mint) && !tradeSigs.has(t.signature) && ((t.from === target && t.to === c.address) || (t.to === target && t.from === c.address))).length;
      if (tokMoves > 0) c.extras.push({ signal: 'transfers', w: W_TOKEN_MOVES, reason: `Между ним и целью перемещались токены (${tokMoves} перев.) — так собирают и раздают позиции бандла.` });
      else if (c.totalSol >= MIN_SOL) c.extras.push({ signal: 'transfers', w: W_SOL_TRANSFERS, reason: `Прямые переводы SOL с целью: ${fmtSol(c.totalSol)} SOL, ${c.transferCount} перев.` });
    }

    const scoreOf = (c: Candidate) => {
      const co = coTradeScore(c.matches);
      // «Те же токены» не отличает бандл от копитрейдера, который копирует только эту цель: снимают подозрение
      // только пополнения и переводы. У копитрейдера без них совпадение токенов не засчитывается.
      const linked = c.extras.some((e) => e.signal !== 'overlap');
      const penalize = c.copytrader && opts.expand && !linked;
      const coAdj = penalize ? co.score * COPY_PENALTY : co.score;
      const extras = c.extras.filter((e) => !(penalize && e.signal === 'overlap')).map((e) => e.w);
      return { score: combine([coAdj, ...extras]), tokens: co.tokens };
    };
    const ranked = () => [...cands.values()].map((c) => ({ c, ...scoreOf(c) })).sort((a, b) => b.score - a.score);
    for (const c of cands.values()) c.copytrader = looksLikeCopytrader(c.matches, target);

    if (opts.expand && cands.size > 0) {
      const top = ranked()
        .filter((x) => x.tokens >= 2 || x.c.matches.some((m) => m.signal === 'same-tx'))
        .slice(0, EXPAND_CHECK)
        .map((x) => x.c);
      ctx.log(`Максимальный поиск: проверяю первые пополнения и покупки ${top.length} сильнейших кандидатов…`);
      const hists = new Map<string, Transfer[]>();
      const funders = new Map<string, string | null>();
      funders.set(target, ws.findFunder(target, h)?.from ?? null);
      await mapLimit(top, 4, async (c) => {
        try {
          const ch = await ws.hist(c.address, CANDIDATE_RECENT, OLDEST_ROWS);
          historiesLoaded++;
          hists.set(c.address, ch.transfers);
          const f = ws.findFunder(c.address, ch)?.from ?? null;
          funders.set(c.address, f);
          c.firstFunder = f;
        } catch (e) {
          warnings.push(`Не удалось загрузить историю ${shortAddr(c.address)}: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
      // Источник, общий для нескольких кошельков, проверяется на «биржа или сервис»: общий горячий кошелёк биржи ничего не значит.
      const funderCount = new Map<string, number>();
      for (const f of funders.values()) if (f) funderCount.set(f, (funderCount.get(f) ?? 0) + 1);
      const isService = new Map<string, boolean>();
      await mapLimit([...funderCount].filter(([f, n]) => n >= 2 && f !== target && !cands.has(f)).map(([f]) => f), 4, async (f) => {
        try {
          isService.set(f, !!(await ws.profile(f)).service);
        } catch {
          isService.set(f, true);
        }
      });
      const targetFunder = funders.get(target) ?? null;
      const targetMints = new Set(targetTrades.filter((t) => t.kind === 'buy').map((t) => t.mint));
      const topSet = new Set(top.map((c) => c.address));
      for (const c of top) {
        const f = funders.get(c.address) ?? null;
        if (f === target) c.extras.push({ signal: 'funded-by-target', w: W_FUNDED_BY_TARGET, reason: 'Первое пополнение SOL пришло от цели.' });
        else if (targetFunder === c.address) c.extras.push({ signal: 'funded-by-target', w: W_FUNDED_BY_TARGET, reason: 'Этот кошелёк первым пополнил цель.' });
        else if (f && f === targetFunder && !isService.get(f)) c.extras.push({ signal: 'common-funder', w: W_COMMON_FUNDER_TARGET, reason: `Общий с целью первый источник SOL: ${shortAddr(f)}.` });
        else if (f && topSet.has(f)) c.extras.push({ signal: 'common-funder', w: W_COMMON_FUNDER_BUNDLE, reason: `Первое пополнение — от другого кандидата бандла ${shortAddr(f)}.` });
        else if (f && (funderCount.get(f) ?? 0) >= 2 && !isService.get(f)) {
          const n = funderCount.get(f)!;
          c.extras.push({ signal: 'common-funder', w: W_COMMON_FUNDER_BUNDLE, reason: `Общий первый источник SOL ${shortAddr(f)} ещё с ${n - 1} кандидатами.` });
        }
        const own = hists.get(c.address);
        if (own) {
          const mints = new Set(extractTrades(c.address, own).filter((t) => t.kind === 'buy').map((t) => t.mint));
          if (mints.size >= OVERLAP_MIN_TOKENS) {
            const common = [...mints].filter((m) => targetMints.has(m)).length;
            c.overlap = Math.round((common / mints.size) * 100) / 100;
            if (c.overlap >= OVERLAP_MIN) c.extras.push({ signal: 'overlap', w: W_OVERLAP * c.overlap, reason: `Из ${tokensText(mints.size)}, купленных им недавно, ${common} покупала и цель (${Math.round(c.overlap * 100)}%).` });
          }
        }
      }

      // Второй круг: токены сильнейших кандидатов, которых нет у цели.
      const seeds = ranked()
        .filter((x) => x.score >= EXPAND_SEED_MIN && !x.c.copytrader && hists.has(x.c.address))
        .slice(0, EXPAND_SEEDS);
      if (seeds.length > 0) {
        ctx.log(`Второй круг: токены ${seeds.length} сильнейших кошельков бандла…`);
        const seen = new Set(picks.map((p) => p.mint));
        const skip = new Set([target, ...excluded.bots, ...excluded.sandwich]);
        for (const s of seeds) {
          const sp = pickTokens(extractTrades(s.c.address, hists.get(s.c.address)!), EXPAND_TOKENS, seen);
          for (const p of sp) seen.add(p.mint);
          await mapLimit(sp, 3, (p) => scanToken(s.c.address, p, false, s.score * ROUND2_DECAY, skip));
        }
        for (const a of [...excluded.bots, ...excluded.sandwich]) cands.delete(a);
        cands.delete(target);
      } else {
        warnings.push('Второй круг не запускался: нет кандидата с оценкой от 60%, не похожего на копитрейдера.');
      }
    }

    // Итог: оценка, отсев слабых и аккаунтов программ.
    let list = ranked().filter((x) => x.score >= MIN_SCORE && (x.tokens >= 2 || x.c.extras.length > 0 || x.c.matches.some((m) => m.signal === 'same-tx')));
    if (list.length > 0) {
      const kinds = await classify(list.slice(0, MAX_WALLETS * 2).map((x) => x.c.address), ctx);
      const before = list.length;
      list = list.filter((x) => kinds.get(x.c.address) !== 'program');
      excluded.programs = before - list.length;
    }
    const wallets: BundleWallet[] = list.slice(0, MAX_WALLETS).map(({ c, score, tokens: nTok }) => {
      const signals = new Set<BundleSignal>();
      for (const m of c.matches) signals.add(m.kind === 'sell' ? 'co-sell' : m.signal);
      for (const e of c.extras) signals.add(e.signal);
      if (c.copytrader) signals.add('copytrader');
      const reasons: string[] = [];
      const buys = c.matches.filter((m) => m.kind === 'buy');
      const sells = c.matches.filter((m) => m.kind === 'sell');
      const sameTx = c.matches.filter((m) => m.signal === 'same-tx');
      if (sameTx.length) reasons.push(`Купил в одной транзакции с ${sameTx[0]!.seed === target ? 'целью' : shortAddr(sameTx[0]!.seed)}: ${tokensText(new Set(sameTx.map((m) => m.mint)).size)} — одна транзакция на несколько кошельков.`);
      const buyMints = new Set(buys.map((m) => m.mint)).size;
      if (buyMints) {
        const near = buys.filter((m) => m.signal !== 'window').length;
        const dts = buys.map((m) => m.dtSec).filter((d): d is number => d != null).sort((a, b) => Math.abs(a) - Math.abs(b));
        reasons.push(`Покупал те же токены в окне ±${opts.windowMin} мин: ${tokensText(buyMints)}${near ? `, из них ${near} — в пределах ${NEAR_SEC} с` : ''}${dts.length ? `; ближайшая покупка ${fmtDt(dts[0]!)} цели` : ''}.`);
      }
      const sellMints = new Set(sells.map((m) => m.mint)).size;
      if (sellMints) reasons.push(`Продавал вместе с ${c.via ? 'кошельком бандла' : 'целью'}: ${tokensText(sellMints)}.`);
      if (c.via) reasons.push(`Найден во втором круге через кошелёк ${shortAddr(c.via)}.`);
      for (const e of c.extras) reasons.push(e.reason);
      if (c.copytrader)
        reasons.push(
          opts.expand && !c.extras.some((e) => e.signal !== 'overlap')
            ? 'Похоже на копитрейдера: стабильно заходит через несколько секунд после цели, пополнений и переводов с целью или бандлом нет. Оценка снижена.'
            : 'Заходит стабильно через несколько секунд после цели: это копитрейдер или бот того же владельца. Максимальный поиск помогает различить.',
        );
      return {
        address: c.address,
        score: Math.round(score * 1000) / 1000,
        tokensMatched: nTok,
        signals: [...signals],
        reasons,
        matches: [...c.matches].sort((a, b) => b.weight - a.weight).slice(0, MAX_MATCHES),
        tracked: tracked.byAddress.get(c.address) ?? null,
        via: c.via,
        totalSol: Math.round(c.totalSol * 1000) / 1000,
        transferCount: c.transferCount,
        firstFunder: c.firstFunder,
        overlap: c.overlap,
        copytrader: c.copytrader,
      };
    });
    const shown = new Set(wallets.map((w) => w.address));
    for (const t of tokens) {
      t.matched = new Set(wallets.filter((w) => w.matches.some((m) => m.mint === t.mint)).map((w) => w.address)).size;
    }

    if (h.truncated) warnings.push(`История цели загружена не полностью (последние ${TARGET_RECENT} переводов) — проверены только недавние токены.`);
    const skipped = tokens.filter((t) => t.skipped).length;
    if (skipped) warnings.push(`Пропущено токенов: ${skipped} — причины в таблице токенов.`);
    const truncated = tokens.filter((t) => t.truncated).length;
    if (truncated) warnings.push(`У ${tokensText(truncated)} окно прочитано не полностью (больше ${BUNDLE_MAX_PAGES * 100} переводов пула): совпадения в них могут быть неполными.`);
    if (wallets.length === 0) warnings.push('Повторяющихся кошельков не найдено. Попробуйте окно шире, больше токенов или максимальный поиск.');
    ctx.log(`Готово: ${wallets.length} кошельков${shown.size ? `, сильнейший — ${Math.round(wallets[0]!.score * 100)}%` : ''}.`);

    return {
      target,
      targetTracked: tracked.byAddress.get(target) ?? null,
      generatedAt: Date.now(),
      options: opts,
      tokens,
      wallets,
      excluded: { bots: excluded.bots.size, sandwich: excluded.sandwich.size, programs: excluded.programs },
      warnings,
      stats: {
        provider: provider.name,
        transfersLoaded: h.transfers.length,
        walletsFetched: historiesLoaded,
        apiCalls: ctx.meter.calls,
        creditsEstimate: ctx.meter.credits,
        durationMs: Date.now() - startedAt,
        truncated: h.truncated,
        tokensScanned,
        transfersScanned,
      },
    };
  }

  return { find };
}
