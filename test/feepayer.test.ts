import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEngine } from '../server/analyze.ts';
import { SOL_MINT } from '../server/config.ts';
import { createDb } from '../server/db.ts';
import { newCtx } from '../server/http.ts';
import { createLinkFinder } from '../server/link.ts';
import type { Transfer, TransferProvider } from '../server/providers/types.ts';
import { COMMON_FEE_PAYER_SCORE, FEE_PAYER_MIN_TX, FEE_PAYER_SCORE, edgeIdOf } from '../server/scoring.ts';
import { buildTrackedIndex } from '../server/tracked.ts';

// Адреса в тестах — произвольные строки: движку важны только совпадения.
let sigN = 0;
function sol(from: string, to: string, amount: number, slot: number): Transfer {
  return { signature: `fsig${++sigN}`, slot, blockTime: 1_700_000_000 + slot, from, to, mint: SOL_MINT, amountRaw: String(Math.round(amount * 1e9)), decimals: 9, uiAmount: amount };
}

interface FakeOpts {
  /** Плательщики комиссий по адресам: адрес → (плательщик → число транзакций). Без опции метод fetchFeePayers отсутствует. */
  feePayers?: Record<string, Record<string, number>>;
}
type Fake = TransferProvider & { all: Transfer[]; calls: string[]; payerCalls: string[] };

function fakeProvider(all: Transfer[], o: FakeOpts = {}): Fake {
  const of = (a: string) => all.filter((t) => t.from === a || t.to === a);
  const p: Fake = {
    name: 'fake',
    note: '',
    all,
    calls: [],
    payerCalls: [],
    async fetchRecent(address, limit) {
      p.calls.push(`recent:${address}`);
      const rows = of(address).sort((x, y) => y.slot - x.slot);
      return { transfers: rows.slice(0, limit), complete: rows.length <= limit };
    },
    async fetchOldest(address, limit) {
      p.calls.push(`oldest:${address}`);
      return of(address).sort((x, y) => x.slot - y.slot).slice(0, limit);
    },
  };
  if (o.feePayers) {
    const fp = o.feePayers;
    p.fetchFeePayers = async (address) => {
      p.payerCalls.push(address);
      const m = new Map(Object.entries(fp[address] ?? {}));
      return { payers: m, txCount: [...m.values()].reduce((s, n) => s + n, 0) };
    };
  }
  return p;
}

function setup(all: Transfer[], trackedList: Array<[string, string]>, o: FakeOpts = {}) {
  const db = createDb(':memory:');
  if (trackedList.length === 0) trackedList = [[addr('Bystander'), 'Bystander']];
  const tracked = buildTrackedIndex(trackedList.map(([trackedWalletAddress, name]) => ({ trackedWalletAddress, name, emoji: '', groups: ['Main'] })));
  db.syncTracked(tracked.wallets.map((w) => w.address));
  const provider = fakeProvider(all, o);
  const classify = async (addresses: string[]) => new Map(addresses.map((a) => [a, 'wallet'] as const));
  const engine = createEngine({ db, provider, classify, tracked: () => tracked, recentTtlSec: 3600 });
  return { db, engine, provider, tracked, classify };
}

function setupLink(all: Transfer[], trackedList: Array<[string, string]> = [], o: FakeOpts = {}) {
  const { engine, provider, db, tracked, classify } = setup(all, trackedList, o);
  const linker = createLinkFinder({ db, provider, classify, tracked: () => tracked, loadHistory: engine.loadHistory, loadPayers: engine.loadPayers });
  return { linker, db, provider };
}

// 32–44 символа base58: buildTrackedIndex проверяет формат.
const addr = (name: string) => (name + 'x'.repeat(40)).slice(0, 40).replace(/[0OIl]/g, 'z');
const T = addr('Target');
const W = addr('Wallet');
const P = addr('Payer');
const A = addr('Alpha');
const B = addr('Beta');
const ROOT = addr('RootFunder');

/** Первое пополнение цели, чтобы у неё была история. */
const seed = (w: string, slot = 1) => sol(ROOT, w, 5, slot);

const feePathsOf = (r: { connections: Array<{ wallet: { address: string }; paths: Array<{ type: string; nodes: string[]; score: number }> }> }, wallet: string) =>
  (r.connections.find((c) => c.wallet.address === wallet)?.paths ?? []).filter((p) => p.type === 'fee-payer');

// ---------- 0. Провайдер без fetchFeePayers ----------

test('без fetchFeePayers: шаг плательщиков комиссий пропускается молча, путей fee-payer нет', async () => {
  const { engine, db, provider } = setup([seed(T)], [[W, 'Wally']]);
  db.setFeePayers(W, new Map([[T, 5]])); // даже если индекс что-то знает, без загрузки шаг не выполняется
  const r = await engine.analyze(T, { depth: 2 }, newCtx());
  assert.equal(provider.fetchFeePayers, undefined);
  assert.equal(await engine.loadPayers(T, newCtx()), false);
  assert.ok(!r.connections.some((c) => c.paths.some((p) => p.type === 'fee-payer')));
  assert.ok(!r.edges.some((e) => e.feesPaid));
  assert.ok(!r.warnings.some((w) => w.includes('комисси')));
});

test('без fetchFeePayers: link не падает и не даёт путей fee-payer', async () => {
  const { linker } = setupLink([seed(A), seed(B)]);
  const r = await linker.link(A, B, { maxHops: 3 }, newCtx());
  assert.ok(!r.paths.some((p) => p.type === 'fee-payer'));
});

// ---------- 1. Отслеживаемый платил за цель ----------

test('analyze: отслеживаемый P оплатил комиссии за 5 транзакций цели — путь fee-payer [T, P] с FEE_PAYER_SCORE, ребро feesPaid', async () => {
  const { engine } = setup([seed(T)], [[P, 'Payer']], { feePayers: { [T]: { [P]: 5 } } });
  const r = await engine.analyze(T, { depth: 2 }, newCtx());
  const paths = feePathsOf(r, P);
  assert.equal(paths.length, 1);
  assert.deepEqual(paths[0].nodes, [T, P]);
  assert.equal(paths[0].score, FEE_PAYER_SCORE);
  const e = r.edges.find((x) => x.id === edgeIdOf(T, P));
  assert.ok(e, 'на карте есть ребро T|P');
  assert.deepEqual(e!.feesPaid, { payer: P, txCount: 5 });
});

test('analyze: всего 1 оплаченная транзакция (< FEE_PAYER_MIN_TX) — пути fee-payer нет', async () => {
  const { engine } = setup([seed(T)], [[P, 'Payer']], { feePayers: { [T]: { [P]: FEE_PAYER_MIN_TX - 1 } } });
  const r = await engine.analyze(T, { depth: 2 }, newCtx());
  assert.equal(feePathsOf(r, P).length, 0);
  assert.ok(!r.edges.some((e) => e.feesPaid));
});

// ---------- 2. Цель платила за отслеживаемого ----------

test('analyze: цель оплачивала комиссии отслеживаемого W (по индексу) — путь fee-payer [T, W]', async () => {
  const { engine, db } = setup([seed(T)], [[W, 'Wally']], { feePayers: {} });
  db.setFeePayers(W, new Map([[T, 3]]));
  const r = await engine.analyze(T, { depth: 2 }, newCtx());
  const paths = feePathsOf(r, W);
  assert.equal(paths.length, 1);
  assert.deepEqual(paths[0].nodes, [T, W]);
  assert.equal(paths[0].score, FEE_PAYER_SCORE);
  assert.deepEqual(r.edges.find((x) => x.id === edgeIdOf(T, W))?.feesPaid, { payer: T, txCount: 3 });
});

// ---------- 3. Общий плательщик ----------

test('analyze: общий плательщик P (платит за цель и, по индексу, за отслеживаемого W) — путь [T, P, W] с COMMON_FEE_PAYER_SCORE, P в siblings', async () => {
  const { engine, db } = setup([seed(T)], [[W, 'Wally']], { feePayers: { [T]: { [P]: 4 } } });
  db.setFeePayers(W, new Map([[P, 4]]));
  const r = await engine.analyze(T, { depth: 2 }, newCtx());
  const paths = feePathsOf(r, W);
  assert.equal(paths.length, 1);
  assert.deepEqual(paths[0].nodes, [T, P, W]);
  assert.equal(paths[0].score, COMMON_FEE_PAYER_SCORE);
  const s = r.siblings.find((x) => x.address === P);
  assert.ok(s, 'P среди вероятных своих кошельков');
  assert.ok(s!.signals.includes('fee-payer'));
});

// ---------- 4. Ретрансляторы ----------

test('relayer: плательщик за кошельки трёх разных имён — путей через него нет, в siblings его нет', async () => {
  const R = addr('Relayer');
  const names: Array<[string, string]> = [[addr('TrackedA'), 'Ann'], [addr('TrackedB'), 'Bob'], [addr('TrackedC'), 'Cid']];
  const { engine, db } = setup([seed(T)], [[R, 'Relayer Owner'], ...names], { feePayers: { [T]: { [R]: 6 } } });
  for (const [w] of names) db.setFeePayers(w, new Map([[R, 3]]));
  const r = await engine.analyze(T, { depth: 2 }, newCtx());
  assert.equal(r.connections.filter((c) => c.paths.some((p) => p.type === 'fee-payer')).length, 0);
  assert.ok(!r.siblings.some((s) => s.address === R));
  assert.ok(!r.edges.some((e) => e.feesPaid), 'рёбер «оплачивал комиссии» нет');
});

test('relayer: сборщик комиссий по поведению (25 отправителей SOL, почти никому не платит) — игнорируется', async () => {
  const R = addr('Collector');
  const feeders = Array.from({ length: 25 }, (_, i) => sol(addr(`Feeder${i}q`), R, 1, 10 + i));
  const all = [seed(T), ...feeders, sol(R, addr('Cashout'), 20, 100)];
  const { engine, db } = setup(all, [[W, 'Wally']], { feePayers: { [T]: { [R]: 6 } } });
  db.setFeePayers(W, new Map([[R, 3]])); // и общий плательщик с W — тоже не должен учитываться
  const r = await engine.analyze(T, { depth: 2 }, newCtx());
  assert.equal(r.connections.filter((c) => c.paths.some((p) => p.type === 'fee-payer')).length, 0);
  assert.ok(!r.siblings.some((s) => s.address === R));
});

// ---------- 5. Неотслеживаемый плательщик ----------

test('analyze: неотслеживаемый плательщик попадает в siblings с сигналом fee-payer и оценкой не ниже 0.85', async () => {
  const { engine } = setup([seed(T)], [], { feePayers: { [T]: { [P]: 5 } } });
  const r = await engine.analyze(T, { depth: 2 }, newCtx());
  const s = r.siblings.find((x) => x.address === P);
  assert.ok(s);
  assert.ok(s!.signals.includes('fee-payer'));
  assert.ok(s!.score >= 0.85, `оценка ${s!.score}`);
});

// ---------- 6. link ----------

test('link: B оплачивал комиссии A — путь fee-payer [A, B] с FEE_PAYER_SCORE', async () => {
  const { linker } = setupLink([seed(A), seed(B)], [], { feePayers: { [A]: { [B]: 4 } } });
  const r = await linker.link(A, B, { maxHops: 3 }, newCtx());
  const p = r.paths.find((x) => x.type === 'fee-payer');
  assert.ok(p, 'путь fee-payer найден');
  assert.deepEqual(p!.nodes, [A, B]);
  assert.equal(p!.score, FEE_PAYER_SCORE);
});

test('link: общий плательщик P (не ретранслятор) платит за A и за B — путь fee-payer [A, P, B]', async () => {
  const { linker } = setupLink([seed(A), seed(B)], [], { feePayers: { [A]: { [P]: 3 }, [B]: { [P]: 2 } } });
  const r = await linker.link(A, B, { maxHops: 3 }, newCtx());
  const p = r.paths.find((x) => x.type === 'fee-payer' && x.nodes.length === 3);
  assert.ok(p, 'путь через общего плательщика найден');
  assert.deepEqual(p!.nodes, [A, P, B]);
  assert.equal(p!.score, COMMON_FEE_PAYER_SCORE);
});

test('link: общий плательщик, который платит за кошельки трёх имён, — ретранслятор, пути нет', async () => {
  const names: Array<[string, string]> = [[addr('TrackedA'), 'Ann'], [addr('TrackedB'), 'Bob'], [addr('TrackedC'), 'Cid']];
  const { linker, db } = setupLink([seed(A), seed(B)], names, { feePayers: { [A]: { [P]: 3 }, [B]: { [P]: 2 } } });
  for (const [w] of names) db.setFeePayers(w, new Map([[P, 3]]));
  const r = await linker.link(A, B, { maxHops: 3 }, newCtx());
  assert.ok(!r.paths.some((x) => x.type === 'fee-payer'));
});

// ---------- 7. Раскрытие вероятных своих кошельков (шаг 7б) ----------
// maxIntermediaries: 0 — иначе S раскрывается обычным шагом «посредники» (common-recipient / common-funder),
// а 7б пропускает уже раскрытые адреса; здесь проверяем именно путь через вероятный свой кошелёк.

const S = addr('Sibling');
const Z = addr('ZetaTracked');

test('7б: сильный свой кошелёк S (цель — его первый источник, переводы в обе стороны) — путь [T, S, Z] via-intermediary «вероятный свой кошелёк»', async () => {
  const all = [seed(T), sol(T, S, 3, 10), sol(S, T, 1, 20), sol(Z, S, 2, 30)];
  const { engine } = setup(all, [[Z, 'Zeta']]);
  const r = await engine.analyze(T, { depth: 2, maxIntermediaries: 0 }, newCtx());
  const s = r.siblings.find((x) => x.address === S);
  assert.ok(s && s.score >= 0.75, `S сильный: ${s?.score}`);
  const c = r.connections.find((x) => x.wallet.address === Z);
  assert.ok(c, 'связь с Z найдена');
  const p = c!.paths.find((x) => x.type === 'via-intermediary' && x.nodes.join() === [T, S, Z].join());
  assert.ok(p, 'путь [T, S, Z]: ' + JSON.stringify(c!.paths));
  assert.ok(p!.reason.includes('вероятный свой кошелёк'), p!.reason);
});

test('7б: слабый свой кошелёк S (только переводы в обе стороны, оценка < 0.75) — пути через «вероятный свой кошелёк» нет', async () => {
  // Первый источник S — посторонний, так что остаётся лишь two-way.
  const all = [seed(T), sol(addr('OtherSource'), S, 5, 1), sol(T, S, 3, 10), sol(S, T, 1, 20), sol(Z, S, 2, 30)];
  const { engine } = setup(all, [[Z, 'Zeta']]);
  const r = await engine.analyze(T, { depth: 2, maxIntermediaries: 0 }, newCtx());
  const s = r.siblings.find((x) => x.address === S);
  assert.ok(s && s.score < 0.75, `S слабый: ${s?.score}`);
  const c = r.connections.find((x) => x.wallet.address === Z);
  assert.ok(!c || !c.paths.some((p) => p.reason.includes('вероятный свой кошелёк')));
});
