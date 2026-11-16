import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEngine } from '../server/analyze.ts';
import { coTradeScore, createBundleFinder, crowdWeight, extractTrades, looksLikeCopytrader, looksShared, matchWindow, pickTokens, poolTrades } from '../server/bundle.ts';
import { SOL_MINT } from '../server/config.ts';
import { createDb } from '../server/db.ts';
import { RpcError, newCtx } from '../server/http.ts';
import { readWindow } from '../server/providers/helius.ts';
import type { Transfer, TransferProvider } from '../server/providers/types.ts';
import { buildTrackedIndex } from '../server/tracked.ts';

const addr = (name: string) => (name + 'x'.repeat(40)).slice(0, 40).replace(/[0OIl]/g, 'z');
const T0 = 1_700_000_000;
let n = 0;

function tr(signature: string, from: string, to: string, mint: string, amount: number, time: number, slot = time * 2): Transfer {
  const decimals = mint === SOL_MINT ? 9 : 6;
  return { signature, slot, blockTime: time, from, to, mint, amountRaw: String(Math.round(amount * 10 ** decimals)), decimals, uiAmount: amount };
}
/** Покупка через пул: SOL кошелёк → пул и токен пул → кошелёк в одной транзакции. */
function buyTx(wallet: string, pool: string, mint: string, time: number, solAmt = 1, sig = `b${++n}`, slot?: number): Transfer[] {
  return [tr(sig, wallet, pool, SOL_MINT, solAmt, time, slot), tr(sig, pool, wallet, mint, 1000, time, slot)];
}
function sellTx(wallet: string, pool: string, mint: string, time: number, solAmt = 1, sig = `s${++n}`, slot?: number): Transfer[] {
  return [tr(sig, wallet, pool, mint, 1000, time, slot), tr(sig, pool, wallet, SOL_MINT, solAmt, time, slot)];
}

const TARGET = addr('Target');
const BUNDLE = addr('Bundle');
const BUNDLE2 = addr('Bundlo');
const COPY = addr('Copy');
const SAND = addr('Sand');
const FUNDER = addr('Funder');

test('extractTrades: покупка, продажа; перевод токена без встречной части — не сделка', () => {
  const rows = [
    ...buyTx(TARGET, addr('PoolA'), 'MintA', T0, 2),
    ...sellTx(TARGET, addr('PoolA'), 'MintA', T0 + 100, 3),
    tr('gift', BUNDLE, TARGET, 'MintB', 50, T0 + 200),
  ];
  const t = extractTrades(TARGET, rows);
  assert.equal(t.length, 2);
  const b = t.find((x) => x.kind === 'buy')!;
  assert.equal(b.pool, addr('PoolA'));
  assert.equal(b.sol, 2);
  const s = t.find((x) => x.kind === 'sell')!;
  assert.equal(s.sol, 3);
});

test('pickTokens: последние токены по последней покупке, вход — первая покупка, выход — крупнейшая продажа', () => {
  const P = addr('Pool');
  const rows = [
    ...buyTx(TARGET, P, 'Old', T0),
    ...buyTx(TARGET, P, 'New', T0 + 50),
    ...buyTx(TARGET, P, 'New', T0 + 500),
    ...buyTx(TARGET, P, 'Mid', T0 + 300),
    tr('sx1', TARGET, P, 'New', 10, T0 + 600),
    tr('sx1', P, TARGET, SOL_MINT, 0.1, T0 + 600),
    tr('sx2', TARGET, P, 'New', 990, T0 + 700),
    tr('sx2', P, TARGET, SOL_MINT, 5, T0 + 700),
  ];
  const picks = pickTokens(extractTrades(TARGET, rows), 2);
  assert.deepEqual(picks.map((p) => p.mint), ['New', 'Mid']);
  assert.equal(picks[0]!.buy.time, T0 + 50);
  assert.equal(picks[0]!.sell!.signature, 'sx2');
});

test('poolTrades и matchWindow: признаки, толпа, сэндвич, бот', () => {
  const P = addr('Pool');
  const seed = { kind: 'buy' as const, signature: 'seed', slot: 1000, time: T0 };
  const rows = [
    ...buyTx(TARGET, P, 'M', T0, 1, 'seed', 1000),
    tr('seed', P, BUNDLE, 'M', 500, T0, 1000), // та же транзакция — инструмент бандлера
    ...buyTx(BUNDLE2, P, 'M', T0, 1, 'slot', 1000),
    ...buyTx(COPY, P, 'M', T0 + 5, 1, 'near', 1010),
    ...buyTx(addr('Late'), P, 'M', T0 + 250, 1, 'late', 1500),
    ...buyTx(SAND, P, 'M', T0 + 1, 1, 'sw1', 1002),
    ...sellTx(SAND, P, 'M', T0 + 1, 1.1, 'sw2', 1003),
  ];
  for (let i = 0; i < 25; i++) rows.push(...buyTx(addr('Bot'), P, 'M', T0 + 10 + i, 0.1, `bot${i}`, 1020 + i));
  const trades = poolTrades(P, 'M', rows);
  assert.ok(trades.some((t) => t.wallet === BUNDLE && t.signature === 'seed' && t.sol === null));
  const out = matchWindow({ mint: 'M', seed: TARGET, seedTrade: seed, trades, windowSec: 300, factor: 1 }, new Set());
  const by = new Map(out.matches.map((m) => [m.wallet, m.match]));
  assert.equal(by.get(BUNDLE)!.signal, 'same-tx');
  assert.equal(by.get(BUNDLE)!.weight, 1);
  assert.equal(by.get(BUNDLE2)!.signal, 'same-slot');
  assert.equal(by.get(COPY)!.signal, 'near');
  assert.equal(by.get(COPY)!.dtSec, 5);
  assert.equal(by.get(addr('Late'))!.signal, 'window');
  assert.ok(by.get(addr('Late'))!.weight < by.get(COPY)!.weight);
  assert.ok(out.sandwich.has(SAND) && !by.has(SAND));
  assert.ok(out.bots.has(addr('Bot')) && !by.has(addr('Bot')));
  assert.equal(out.crowd, 4);
});

test('crowdWeight и coTradeScore: толпа ослабляет, токены складываются, продажи весят меньше', () => {
  assert.equal(crowdWeight(2), 1);
  assert.ok(crowdWeight(50) < 0.5 && crowdWeight(50) > 0.3);
  assert.equal(crowdWeight(5000), 0.25);
  const m = (mint: string, kind: 'buy' | 'sell', weight: number) => ({ mint, kind, seed: TARGET, signal: 'near' as const, dtSec: 3, slotDelta: 1, signature: 'x', seedSignature: 'y', time: T0, sol: 1, weight });
  const one = coTradeScore([m('A', 'buy', 0.75)]);
  const three = coTradeScore([m('A', 'buy', 0.75), m('B', 'buy', 0.75), m('C', 'buy', 0.75)]);
  assert.equal(one.tokens, 1);
  assert.equal(three.tokens, 3);
  assert.ok(one.score < 0.4 && three.score > 0.7);
  assert.ok(coTradeScore([m('A', 'sell', 0.75)]).score < one.score);
  // Лучшая сделка по токену, а не сумма: повтор того же токена не добавляет.
  assert.equal(coTradeScore([m('A', 'buy', 0.75), m('A', 'buy', 0.5)]).score, one.score);
});

test('looksLikeCopytrader: стабильно через секунды после цели — да; вперемешку в течение минут — нет', () => {
  const m = (mint: string, dtSec: number) => ({ mint, kind: 'buy' as const, seed: TARGET, signal: 'near' as const, dtSec, slotDelta: 1, signature: mint, seedSignature: 'y', time: T0, sol: 1, weight: 0.7 });
  assert.equal(looksLikeCopytrader([m('A', 2), m('B', 3), m('C', 4), m('D', 2)], TARGET), true);
  assert.equal(looksLikeCopytrader([m('A', -90), m('B', 40), m('C', -15), m('D', 120)], TARGET), false);
  assert.equal(looksLikeCopytrader([m('A', 2), m('B', 3)], TARGET), false);
});

test('looksShared: общий адрес площадки по разнообразию токенов', () => {
  const P = addr('Shared');
  const rows: Transfer[] = [];
  for (let i = 0; i < 30; i++) rows.push(tr(`x${i}`, P, addr('W'), `Mint${i % 6}`, 1, T0 + i));
  assert.equal(looksShared('Mint0', rows), true);
  const own = rows.map((r) => ({ ...r, mint: 'Mint0' }));
  assert.equal(looksShared('Mint0', own), false);
});

// ---------- readWindow: чтение промежутка истории пула ----------

/** История пула: по одной строке в секунду с T0 до T0 + len. Страницы по 100. */
function fakePages(len: number, opts: { filter: 'ok' | 'ignored' | 'error' }) {
  const all = Array.from({ length: len }, (_, i) => tr(`p${i}`, addr('Pool'), addr('W' + (i % 7)), 'M', 1, T0 + i, i));
  const calls: string[] = [];
  const page = async (order: 'asc' | 'desc', token: string | undefined, filtered: boolean) => {
    calls.push(`${order}${filtered ? '+f' : ''}`);
    if (filtered && opts.filter === 'error') throw new RpcError(-32602, 'Invalid params: unknown field filters');
    let rows = order === 'asc' ? all : [...all].reverse();
    if (filtered && opts.filter === 'ok') rows = rows.filter((t) => t.blockTime! >= win[0] && t.blockTime! <= win[1]);
    const start = token ? Number(token) : 0;
    const slice = rows.slice(start, start + 100);
    return { transfers: slice, times: slice.map((t) => t.blockTime!), token: start + 100 < rows.length ? String(start + 100) : undefined };
  };
  let win: [number, number] = [0, 0];
  return { page, calls, setWin: (w: [number, number]) => (win = w) };
}

test('readWindow: фильтр по времени поддержан — читаются только страницы окна', async () => {
  const f = fakePages(5000, { filter: 'ok' });
  const w: [number, number] = [T0 + 2000, T0 + 2150];
  f.setWin(w);
  let state: boolean | null = null;
  const r = await readWindow(f.page, w[0], w[1], 20, { get: () => state, set: (v) => void (state = v) });
  assert.equal(state, true);
  assert.equal(r.transfers.length, 151);
  assert.equal(r.complete, true);
  assert.equal(r.pages, 2);
});

test('readWindow: фильтр не поддержан — окно в середине, идём с ближней стороны', async () => {
  for (const mode of ['ignored', 'error'] as const) {
    const f = fakePages(5000, { filter: mode });
    const w: [number, number] = [T0 + 4500, T0 + 4600]; // ближе к концу истории
    f.setWin(w);
    let state: boolean | null = null;
    const r = await readWindow(f.page, w[0], w[1], 20, { get: () => state, set: (v) => void (state = v) });
    assert.equal(state, false, mode);
    assert.equal(r.transfers.length, 101, mode);
    assert.equal(r.complete, true, mode);
    assert.ok(r.pages <= 9, `${mode}: ${r.pages} страниц`);
    assert.ok(f.calls.filter((c) => c === 'desc').length >= 5, `${mode}: шёл с конца`);
  }
});

test('readWindow: предел страниц — complete = false', async () => {
  const f = fakePages(20000, { filter: 'ignored' });
  const w: [number, number] = [T0 + 10000, T0 + 10100];
  f.setWin(w);
  let state: boolean | null = false;
  const r = await readWindow(f.page, w[0], w[1], 5, { get: () => state, set: (v) => void (state = v) });
  assert.equal(r.complete, false);
  assert.equal(r.pages, 5);
});

// ---------- Полный поиск на подставных данных ----------

function scenario() {
  const all: Transfer[] = [];
  const pools = ['A', 'B', 'C', 'D'].map((x) => addr('Pool' + x));
  const mints = ['MintA', 'MintB', 'MintC', 'MintD'];
  const funding = [tr('f0', FUNDER, TARGET, SOL_MINT, 10, T0 - 9000), tr('f1', TARGET, BUNDLE, SOL_MINT, 3, T0 - 8000), tr('f2', TARGET, BUNDLE2, SOL_MINT, 3, T0 - 7900)];
  all.push(...funding);
  mints.forEach((mint, i) => {
    const P = pools[i]!;
    const t = T0 + i * 10_000;
    all.push(...buyTx(TARGET, P, mint, t, 1));
    all.push(...buyTx(BUNDLE, P, mint, t + 40 + i * 13, 0.8)); // бандл заходит в течение минуты-двух
    all.push(...buyTx(BUNDLE2, P, mint, t - 70 + i * 7, 0.6));
    all.push(...buyTx(COPY, P, mint, t + 2, 0.5)); // копитрейдер: всегда через 2 с
    all.push(...buyTx(addr('Rand' + i), P, mint, t + 100, 0.3)); // случайные: по одному токену
    all.push(...buyTx(SAND, P, mint, t + 1, 5, `sa${i}`, (t + 1) * 2));
    all.push(...sellTx(SAND, P, mint, t + 1, 5.1, `sb${i}`, (t + 1) * 2 + 1));
    all.push(...sellTx(TARGET, P, mint, t + 3000, 2));
    all.push(...sellTx(BUNDLE, P, mint, t + 3030, 1.5));
  });
  // Бандл покупает и свои токены без цели — для второго круга.
  const P2 = addr('PoolE');
  all.push(...buyTx(BUNDLE, P2, 'MintE', T0 + 90_000, 1), ...buyTx(BUNDLE2, P2, 'MintE', T0 + 90_020, 1), ...buyTx(addr('Hidden'), P2, 'MintE', T0 + 90_030, 1));
  all.push(...buyTx(BUNDLE, P2, 'MintF', T0 + 95_000, 1, undefined), ...buyTx(addr('Hidden'), P2, 'MintF', T0 + 95_010, 1));
  return all;
}

function setupFind(all: Transfer[]) {
  const db = createDb(':memory:');
  const tracked = buildTrackedIndex([{ trackedWalletAddress: BUNDLE2, name: 'Bundler Joe', emoji: '', groups: ['Main'] }]);
  db.syncTracked(tracked.wallets.map((w) => w.address));
  const of = (a: string) => all.filter((t) => t.from === a || t.to === a);
  const windowCalls: string[] = [];
  const provider: TransferProvider = {
    name: 'fake',
    note: '',
    async fetchRecent(address, limit) {
      const rows = of(address).sort((x, y) => y.slot - x.slot);
      return { transfers: rows.slice(0, limit), complete: rows.length <= limit };
    },
    async fetchOldest(address, limit) {
      return of(address).sort((x, y) => x.slot - y.slot).slice(0, limit);
    },
    async fetchWindow(address, from, to) {
      windowCalls.push(address);
      return { transfers: of(address).filter((t) => t.blockTime! >= from && t.blockTime! <= to), complete: true, pages: 1 };
    },
  };
  const classify = async (addresses: string[]) => new Map(addresses.map((a) => [a, 'wallet'] as const));
  const engine = createEngine({ db, provider, classify, tracked: () => tracked, recentTtlSec: 3600 });
  const b = createBundleFinder({ db, provider, classify, tracked: () => tracked, loadHistory: engine.loadHistory });
  return { b, windowCalls };
}

test('поиск бандла: кошельки бандла сверху, копитрейдер помечен, сэндвич и случайные отсеяны', async () => {
  const { b, windowCalls } = setupFind(scenario());
  const r = await b.find(TARGET, { tokens: 10, windowMin: 5 }, newCtx());
  assert.equal(r.tokens.length, 4);
  const by = new Map(r.wallets.map((w) => [w.address, w]));
  const bundle = by.get(BUNDLE)!;
  assert.ok(bundle, 'бандл найден');
  assert.equal(bundle.tokensMatched, 4);
  assert.ok(bundle.signals.includes('co-sell'));
  assert.ok(bundle.signals.includes('transfers'), 'цель переводила ему SOL');
  assert.ok(bundle.score > 0.9, `оценка ${bundle.score}`);
  assert.ok(by.get(BUNDLE2), 'второй кошелёк бандла найден');
  assert.equal(by.get(BUNDLE2)!.tracked?.name, 'Bundler Joe');
  assert.ok(by.get(COPY)!.copytrader);
  assert.ok(!by.has(SAND));
  assert.equal(r.excluded.sandwich, 1);
  assert.ok(![...by.keys()].some((a) => a.startsWith('Rand')), 'один общий токен — не бандл');
  // Окна покупки и продажи одного пула далеко друг от друга — два чтения; повтор из кэша — ни одного.
  assert.equal(windowCalls.length, 8);
  const again = await b.find(TARGET, { tokens: 10, windowMin: 5 }, newCtx());
  assert.equal(windowCalls.length, 8);
  assert.deepEqual(again.wallets.map((w) => w.address), r.wallets.map((w) => w.address));
});

test('максимальный поиск: пополнение от цели, снижение копитрейдера, второй круг', async () => {
  const { b } = setupFind(scenario());
  const plain = await b.find(TARGET, { tokens: 10, windowMin: 5 }, newCtx());
  const r = await b.find(TARGET, { tokens: 10, windowMin: 5, expand: true }, newCtx());
  const by = new Map(r.wallets.map((w) => [w.address, w]));
  assert.ok(by.get(BUNDLE2)!.signals.includes('funded-by-target'));
  assert.equal(by.get(BUNDLE2)!.firstFunder, TARGET);
  assert.ok(by.get(BUNDLE)!.overlap! >= 0.5);
  const copyPlain = plain.wallets.find((w) => w.address === COPY)!.score;
  assert.ok(by.get(COPY)!.score < copyPlain, 'копитрейдер без других связей ослаблен');
  const hidden = by.get(addr('Hidden'));
  assert.ok(hidden, 'второй круг нашёл кошелёк, торговавший без цели');
  assert.ok(hidden.via === BUNDLE || hidden.via === BUNDLE2);
  assert.ok(r.tokens.some((t) => t.seed !== TARGET));
});
