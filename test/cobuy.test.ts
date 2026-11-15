import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEngine } from '../server/analyze.ts';
import { SOL_MINT } from '../server/config.ts';
import { createDb } from '../server/db.ts';
import { newCtx } from '../server/http.ts';
import { createLinkFinder } from '../server/link.ts';
import type { Transfer, TransferProvider } from '../server/providers/types.ts';
import { COBUY_MIN_MINTS, coBuyScore, edgeIdOf } from '../server/scoring.ts';
import { buildTrackedIndex } from '../server/tracked.ts';

// Адреса в тестах — произвольные строки: движку важны только совпадения.
let sigN = 0;
function sol(from: string, to: string, amount: number, slot: number): Transfer {
  return { signature: `csig${++sigN}`, slot, blockTime: 1_700_000_000 + slot, from, to, mint: SOL_MINT, amountRaw: String(Math.round(amount * 1e9)), decimals: 9, uiAmount: amount };
}
/** Токен-перевод с управляемыми минтом, слотом и подписью (по умолчанию подпись уникальна). */
function token(from: string, to: string, slot: number, mint = 'MemeMint1111111111111111111111111111111111', signature?: string): Transfer {
  return { signature: signature ?? `csig${++sigN}`, slot, blockTime: 1_700_000_000 + slot, from, to, mint, amountRaw: '1000000', decimals: 6, uiAmount: 1 };
}

interface FakeOpts {
  /** Сколько свежих строк отдаёт fetchRecent (обрезает историю, complete = false). */
  recentCap?: number;
  /** Сколько ранних строк отдаёт fetchOldest. */
  oldestCap?: number;
  /** Включить fetchBetween. */
  between?: boolean;
}
type Fake = TransferProvider & {
  all: Transfer[];
  calls: string[];
  untilSlots: Array<number | undefined>;
  betweenCalls: Array<[string, string]>;
  /** Принудительный ответ fetchRecent (имитация дыры в истории). */
  override: null | { take: number; reachedKnown?: boolean; complete?: boolean };
};

function fakeProvider(all: Transfer[], o: FakeOpts = {}): Fake {
  const of = (a: string) => all.filter((t) => t.from === a || t.to === a);
  const p: Fake = {
    name: 'fake',
    note: '',
    all,
    calls: [],
    untilSlots: [],
    betweenCalls: [],
    override: null,
    async fetchRecent(address, limit, _ctx, opts) {
      p.calls.push(`recent:${address}`);
      p.untilSlots.push(opts?.untilSlot);
      const rows = of(address).sort((x, y) => y.slot - x.slot);
      if (p.override) {
        return { transfers: rows.slice(0, p.override.take), reachedKnown: p.override.reachedKnown, complete: p.override.complete ?? false };
      }
      const cap = Math.min(limit, o.recentCap ?? Infinity);
      if (opts?.untilSlot != null) {
        const fresh = rows.filter((t) => t.slot > opts.untilSlot!);
        return { transfers: fresh.slice(0, cap), complete: false, reachedKnown: fresh.length <= cap };
      }
      return { transfers: rows.slice(0, cap), complete: rows.length <= cap };
    },
    async fetchOldest(address, limit) {
      p.calls.push(`oldest:${address}`);
      return of(address).sort((x, y) => x.slot - y.slot).slice(0, Math.min(limit, o.oldestCap ?? Infinity));
    },
  };
  if (o.between) {
    p.fetchBetween = async (a, b) => {
      p.betweenCalls.push([a, b]);
      return all.filter((t) => (t.from === a && t.to === b) || (t.from === b && t.to === a));
    };
  }
  return p;
}

function setup(all: Transfer[], trackedList: Array<[string, string]>, programs: string[] = [], o: FakeOpts & { recentTtlSec?: number } = {}) {
  const db = createDb(':memory:');
  // buildTrackedIndex не принимает пустой список: добавляем постороннего отслеживаемого, не связанного ни с чем.
  if (trackedList.length === 0) trackedList = [[addr('Bystander'), 'Bystander']];
  const tracked = buildTrackedIndex(trackedList.map(([trackedWalletAddress, name]) => ({ trackedWalletAddress, name, emoji: '', groups: ['Main'] })));
  db.syncTracked(tracked.wallets.map((w) => w.address));
  const provider = fakeProvider(all, o);
  const classify = async (addresses: string[]) => new Map(addresses.map((a) => [a, programs.includes(a) ? 'program' : 'wallet'] as const));
  const engine = createEngine({ db, provider, classify, tracked: () => tracked, recentTtlSec: o.recentTtlSec ?? 3600 });
  return { db, engine, provider, tracked, classify };
}

function setupLink(all: Transfer[], trackedList: Array<[string, string]> = [], o: FakeOpts = {}) {
  const { engine, provider, db, tracked, classify } = setup(all, trackedList, [], o);
  const linker = createLinkFinder({ db, provider, classify, tracked: () => tracked, loadHistory: engine.loadHistory });
  return { linker, db, provider };
}

// 32–44 символа base58: buildTrackedIndex проверяет формат.
const addr = (name: string) => (name + 'x'.repeat(40)).slice(0, 40).replace(/[0OIl]/g, 'z');
const T = addr('Target');
const W = addr('Wallet');
const U = addr('Untracked');
const A = addr('Alpha');
const B = addr('Beta');
const X = addr('Xenon');
const POOL = addr('Pool');

const mintsOf = (n: number, prefix = 'M') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}Mint`.padEnd(40, 'm'));

/** Покупки кошелька w: по одной на каждый минт, слот = base + i, подписи уникальны. */
function buys(w: string, mints: string[], base: number, tag: string): Transfer[] {
  return mints.map((m, i) => token(POOL, w, base + i, m, `${tag}-${i}`));
}

// ---------- 1. db.coBuysOf ----------

test('db.coBuysOf: одинаковые токены в одних слотах разными подписями — кошелёк найден, записи с обеих сторон', () => {
  const db = createDb(':memory:');
  const ms = mintsOf(3);
  db.insertTransfers([...buys(T, ms, 100, 'ts'), ...buys(W, ms, 100, 'ws')]);
  const r = db.coBuysOf(T);
  assert.equal(r.length, 1);
  assert.equal(r[0].wallet, W);
  assert.equal(r[0].mints.size, 3);
  assert.equal(r[0].slots.size, 3);
  assert.ok(r[0].records.some((x) => x.to === T), 'есть покупки цели');
  assert.ok(r[0].records.some((x) => x.to === W), 'есть покупки второго кошелька');
});

test('db.coBuysOf: одна и та же подпись (маршрутизация обмена) — совпадение игнорируется', () => {
  const db = createDb(':memory:');
  const ms = mintsOf(3);
  db.insertTransfers([...buys(T, ms, 100, 'same'), ...buys(W, ms, 100, 'same')]);
  assert.deepEqual(db.coBuysOf(T), []);
});

test('db.coBuysOf: слот отличается на 1 — совпадения нет', () => {
  const db = createDb(':memory:');
  const ms = mintsOf(3);
  db.insertTransfers([...buys(T, ms, 100, 'ts'), ...buys(W, ms, 101, 'ws')]);
  assert.deepEqual(db.coBuysOf(T), []);
});

test('db.coBuysOf: покупка, которую в слоте получили 10 других кошельков, не считается', () => {
  const db = createDb(':memory:');
  const ms = mintsOf(4);
  const crowd = Array.from({ length: 10 }, (_, i) => token(POOL, addr(`Crowd${i}`), 103, ms[3], `crowd-${i}`));
  db.insertTransfers([...buys(T, ms, 100, 'ts'), ...buys(W, ms, 100, 'ws'), ...crowd]);
  const r = db.coBuysOf(T);
  const w = r.find((c) => c.wallet === W);
  assert.ok(w);
  assert.equal(w!.mints.size, 3, 'четвёртый минт с толпой отброшен');
  assert.ok(!w!.mints.has(ms[3]));
  assert.ok(!r.some((c) => c.wallet.startsWith('Crowd')), 'участники толпы не возвращаются');
});

// ---------- 2. analyze: связь с отслеживаемым кошельком ----------

test('analyze: 4 совместные покупки с отслеживаемым — путь co-buy, ребро на карте с coBuy.mints = 4', async () => {
  const ms = mintsOf(4);
  const { engine, db } = setup(buys(T, ms, 100, 'ts'), [[W, 'Wally']], [POOL]);
  db.insertTransfers(buys(W, ms, 100, 'ws'));
  const r = await engine.analyze(T, { depth: 2 }, newCtx());

  const c = r.connections.find((x) => x.wallet.address === W);
  assert.ok(c, 'связь с отслеживаемым найдена');
  const p = c!.paths.find((x) => x.type === 'co-buy');
  assert.ok(p, 'есть путь co-buy');
  assert.deepEqual(p!.nodes, [T, W]);
  assert.ok(Math.abs(c!.score - coBuyScore(4)) < 0.01, `оценка ${c!.score} ≈ ${coBuyScore(4)}`);

  const e = r.edges.find((x) => x.id === edgeIdOf(T, W));
  assert.ok(e, 'на карте есть ребро T—W');
  assert.equal(e!.coBuy?.mints, 4);
  assert.equal(e!.transferCount, 0);
  assert.ok(e!.transfers.length > 0);
  assert.ok(e!.transfers.every((t) => t.coBuy === true));
});

test('analyze: всего 2 совместные покупки — связи нет', async () => {
  const ms = mintsOf(COBUY_MIN_MINTS - 1);
  const { engine, db } = setup(buys(T, ms, 100, 'ts'), [[W, 'Wally']], [POOL]);
  db.insertTransfers(buys(W, ms, 100, 'ws'));
  const r = await engine.analyze(T, { depth: 2 }, newCtx());
  assert.ok(!r.connections.some((x) => x.wallet.address === W));
  assert.ok(!r.edges.some((x) => x.id === edgeIdOf(T, W)));
});

// ---------- 3. analyze: siblings ----------

test('analyze: посторонний кошелёк с 5 совместными покупками попадает в siblings с сигналом co-buy', async () => {
  const ms = mintsOf(5);
  const { engine, db } = setup(buys(T, ms, 100, 'ts'), [], [POOL]);
  db.insertTransfers(buys(U, ms, 100, 'us'));
  const r = await engine.analyze(T, { depth: 2 }, newCtx());
  const s = r.siblings.find((x) => x.address === U);
  assert.ok(s, 'U среди вероятных своих кошельков');
  assert.ok(s!.signals.includes('co-buy'));
});

// ---------- 4. link ----------

test('link: A и B с 3 совместными покупками — путь co-buy [A, B]', async () => {
  const ms = mintsOf(3);
  const { linker } = setupLink([...buys(A, ms, 100, 'as'), ...buys(B, ms, 100, 'bs')]);
  const r = await linker.link(A, B, { maxHops: 3 }, newCtx());
  const p = r.paths.find((x) => x.type === 'co-buy');
  assert.ok(p, 'путь co-buy найден');
  assert.deepEqual(p!.nodes, [A, B]);
  assert.ok(r.score > 0);
});

test('link: A и B порознь по 3 совместные покупки с посторонним X — путь co-buy [A, X, B]', async () => {
  // Минты и слоты у пар разные: друг с другом A и B не совпадают.
  const msA = mintsOf(3, 'A');
  const msB = mintsOf(3, 'B');
  const { linker, db } = setupLink([...buys(A, msA, 100, 'as'), ...buys(B, msB, 200, 'bs')]);
  db.insertTransfers([...buys(X, msA, 100, 'xa'), ...buys(X, msB, 200, 'xb')]);
  const r = await linker.link(A, B, { maxHops: 3 }, newCtx());
  assert.ok(!r.paths.some((p) => p.type === 'co-buy' && p.nodes.length === 2), 'прямой co-buy A—B отсутствует');
  const p = r.paths.find((x) => x.type === 'co-buy');
  assert.ok(p, 'путь co-buy через X найден');
  assert.deepEqual(p!.nodes, [A, X, B]);
});

// ---------- 5. link: точечные проверки пар ----------

test('link: старый прямой перевод A → B вне свежего окна находится через fetchBetween(A, B)', async () => {
  const early = (w: string, n: number) => Array.from({ length: n }, (_, i) => sol(addr(`E${w.slice(0, 3)}${i}q`), w, 1, 1 + i));
  const late = (w: string, n: number) => Array.from({ length: n }, (_, i) => sol(w, addr(`L${w.slice(0, 3)}${i}q`), 1, 100 + i));
  const all = [...early(A, 3), ...early(B, 3), sol(A, B, 2, 50), ...late(A, 3), ...late(B, 3)];
  // Свежее окно (3) и ранние строки (3) старый перевод в середине не захватывают.
  const opts = { recentCap: 3, oldestCap: 3 };

  const without = setupLink(all, [], opts);
  const r0 = await without.linker.link(A, B, { maxHops: 2 }, newCtx());
  assert.ok(!r0.paths.some((p) => p.type === 'direct'), 'контроль: без fetchBetween прямой связи не видно');

  const withBetween = setupLink(all, [], { ...opts, between: true });
  const r = await withBetween.linker.link(A, B, { maxHops: 2 }, newCtx());
  assert.ok(r.paths.some((p) => p.type === 'direct' && p.nodes.join() === [A, B].join()), 'прямой путь найден благодаря fetchBetween');
  assert.ok(withBetween.provider.betweenCalls.some(([x, y]) => x === A && y === B), 'fetchBetween вызван с (A, B)');
});

// ---------- 6. loadHistory: догрузка ----------

test('loadHistory: повторный вызов после истечения TTL догружает только новое (untilSlot = topSlot), строки накапливаются', (t) => {
  return (async () => {
    let now = 1_800_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const all = [sol(R0, T, 1, 10), sol(R0, T, 1, 20), sol(R0, T, 1, 30)];
    const { engine, db, provider } = setup(all, [], [], { recentTtlSec: 60 });

    await engine.loadHistory(T, { recent: 100, oldest: 0 }, newCtx());
    const s1 = db.getFetch(T, 'recent')!;
    assert.equal(s1.rows, 3);
    assert.equal(s1.topSlot, 30);
    assert.deepEqual(provider.untilSlots, [undefined], 'первая загрузка — без untilSlot');

    now += 7200 * 1000;
    const fresh = sol(R0, T, 5, 40);
    all.push(fresh);
    const h = await engine.loadHistory(T, { recent: 100, oldest: 0 }, newCtx());
    assert.equal(provider.untilSlots[1], 30, 'догрузка просит переводы новее прежнего topSlot');
    assert.ok(h.transfers.some((x) => x.signature === fresh.signature), 'новый перевод сохранён');
    assert.equal(h.transfers.length, 4);
    const s2 = db.getFetch(T, 'recent')!;
    assert.equal(s2.rows, 4);
    assert.equal(s2.topSlot, 40);
    assert.equal(s2.rowLimit, 100);
  })();
});

test('loadHistory: дыра в истории (ни reachedKnown, ни complete) — состояние заменяется, rowLimit = запрошенный, complete = false', (t) => {
  return (async () => {
    let now = 1_800_000_000_000;
    t.mock.method(Date, 'now', () => now);
    const all = [sol(R0, T, 1, 10), sol(R0, T, 1, 20), sol(R0, T, 1, 30)];
    const { engine, db, provider } = setup(all, [], [], { recentTtlSec: 60 });

    await engine.loadHistory(T, { recent: 100, oldest: 0 }, newCtx());
    now += 7200 * 1000;
    all.push(sol(R0, T, 1, 50), sol(R0, T, 1, 60));
    provider.override = { take: 2, reachedKnown: false, complete: false };
    await engine.loadHistory(T, { recent: 50, oldest: 0 }, newCtx());

    assert.equal(provider.untilSlots[1], 30);
    const s = db.getFetch(T, 'recent')!;
    assert.equal(s.rowLimit, 50, 'rowLimit равен запрошенному лимиту');
    assert.equal(s.complete, false);
    assert.equal(s.rows, 2, 'rows — только загруженное сейчас');
    assert.equal(s.topSlot, 60);
  })();
});

const R0 = addr('RootSource');

// ---------- 7. Калибровка 15.11.2026: снайпинг и «депозит на троих» ----------

test('снайпер: совместные покупки с трейдерами 4+ разных имён не учитываются, бандл одного имени — учитывается', async () => {
  const names = ['Ann', 'Bob', 'Cid', 'Dan', 'Eve'];
  const others = names.map((n) => addr(`Sniper${n}`));
  const all: Transfer[] = [sol(addr('RootS'), T, 1, 1)];
  const theirs: Transfer[] = [];
  others.forEach((w, k) => {
    const ms = mintsOf(3, `S${k}`);
    all.push(...buys(T, ms, 1000 + k * 10, `t${k}`));
    theirs.push(...buys(w, ms, 1000 + k * 10, `w${k}`));
  });
  const { engine, db } = setup(all, others.map((w, k) => [w, names[k]] as [string, string]));
  db.insertTransfers(theirs); // как после индексации списка
  const r = await engine.analyze(T, { depth: 1 }, newCtx());
  assert.ok(!r.connections.some((c) => c.paths.some((p) => p.type === 'co-buy')), 'совместные покупки снайпера отброшены');
  assert.ok(r.warnings.some((w) => w.includes('снайпинг')));

  // Два кошелька одного имени — это бандл, учитывается.
  const y1 = addr('YugiOne');
  const y2 = addr('YugiTwo');
  const ms1 = mintsOf(3, 'Y1');
  const ms2 = mintsOf(3, 'Y2');
  const ok = setup([sol(addr('RootS'), T, 1, 1), ...buys(T, ms1, 2000, 'a'), ...buys(T, ms2, 3000, 'c')], [[y1, 'Yugi'], [y2, 'Yugi Bundle']]);
  ok.db.insertTransfers([...buys(y1, ms1, 2000, 'b'), ...buys(y2, ms2, 3000, 'd')]);
  const r2 = await ok.engine.analyze(T, { depth: 1 }, newCtx());
  assert.equal(r2.connections.filter((c) => c.paths.some((p) => p.type === 'co-buy')).length, 2);
});

test('депозитный адрес, через который платят три разных имени, — не личный: связь не считается общим депозитом', async () => {
  const COINBASE = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS';
  const P = addr('SharedDeposit');
  const S1 = addr('SigmaW');
  const S2 = addr('OmegaW');
  const S3 = addr('PsiWal');
  const all = [sol(addr('RootD'), T, 5, 1), sol(T, P, 2, 10), sol(S1, P, 3, 11), sol(S2, P, 1, 12), sol(S3, P, 1, 13), sol(P, COINBASE, 6.9, 20)];
  const { engine } = setup(all, [[S1, 'Sigma'], [S2, 'Omega'], [S3, 'Psi']]);
  const r = await engine.analyze(T, { depth: 2 }, newCtx());
  assert.ok(r.connections.length > 0, 'связь через общего получателя всё же есть');
  assert.ok(!r.connections.some((c) => c.paths.some((p) => p.type === 'shared-deposit')), 'общим депозитом не считается');
});

test('раздатчик наград держателям (раунды выплат многим разным именам) — хаб «rewards», связей через него нет', async () => {
  const R = addr('RewardsDist');
  const holders = [addr('HolderAnn'), addr('HolderBob'), addr('HolderCid'), addr('HolderX1q'), addr('HolderX2q')];
  const all: Transfer[] = [sol(addr('RootR'), T, 1, 1), sol(addr('TokenFees'), R, 5, 2)];
  for (const slot of [100, 200]) {
    all.push(sol(R, T, 0.05, slot));
    holders.forEach((h, i) => all.push(sol(R, h, 0.03 + i * 0.01, slot)));
  }
  const { engine } = setup(all, [[holders[0], 'Ann'], [holders[1], 'Bob'], [holders[2], 'Cid']]);
  const r = await engine.analyze(T, { depth: 2 }, newCtx());
  assert.equal(r.connections.length, 0, 'держатели одного токена — не связь');
  const node = r.nodes.find((n) => n.id === R);
  if (node) assert.equal(node.kind, 'hub');
  assert.ok(r.warnings.some((w) => w.toLowerCase().includes('раздача наград')), 'в предупреждении назван раздатчик наград');
});
