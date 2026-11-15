import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEngine } from '../server/analyze.ts';
import { SOL_MINT } from '../server/config.ts';
import { createDb } from '../server/db.ts';
import { newCtx } from '../server/http.ts';
import { createLinkFinder } from '../server/link.ts';
import type { Transfer, TransferProvider } from '../server/providers/types.ts';
import { buildTrackedIndex } from '../server/tracked.ts';

// Адреса в тестах — произвольные строки: движку важны только совпадения.
let sigN = 0;
function sol(from: string, to: string, amount: number, slot: number): Transfer {
  return { signature: `fsig${++sigN}`, slot, blockTime: 1_700_000_000 + slot, from, to, mint: SOL_MINT, amountRaw: String(Math.round(amount * 1e9)), decimals: 9, uiAmount: amount };
}
function token(from: string, to: string, slot: number): Transfer {
  return { signature: `fsig${++sigN}`, slot, blockTime: 1_700_000_000 + slot, from, to, mint: 'MemeMint1111111111111111111111111111111111', amountRaw: '1000000', decimals: 6, uiAmount: 1 };
}

function fakeProvider(all: Transfer[]): TransferProvider & { calls: string[] } {
  const calls: string[] = [];
  const of = (a: string) => all.filter((t) => t.from === a || t.to === a);
  return {
    name: 'fake',
    note: '',
    calls,
    async fetchRecent(address, limit) {
      calls.push(`recent:${address}`);
      const rows = of(address).sort((p, q) => q.slot - p.slot);
      return { transfers: rows.slice(0, limit), complete: rows.length <= limit };
    },
    async fetchOldest(address, limit) {
      calls.push(`oldest:${address}`);
      return of(address).sort((p, q) => p.slot - q.slot).slice(0, limit);
    },
  };
}

function setup(all: Transfer[], trackedList: Array<[string, string]>, programs: string[] = []) {
  const db = createDb(':memory:');
  // buildTrackedIndex не принимает пустой список: добавляем постороннего отслеживаемого, не связанного ни с чем.
  if (trackedList.length === 0) trackedList = [[addr('Bystander'), 'Bystander']];
  const tracked = buildTrackedIndex(trackedList.map(([trackedWalletAddress, name]) => ({ trackedWalletAddress, name, emoji: '', groups: ['Main'] })));
  db.syncTracked(tracked.wallets.map((w) => w.address));
  const provider = fakeProvider(all);
  const classify = async (addresses: string[]) => new Map(addresses.map((a) => [a, programs.includes(a) ? 'program' : 'wallet'] as const));
  const engine = createEngine({ db, provider, classify, tracked: () => tracked, recentTtlSec: 3600 });
  return { db, engine, provider, tracked, classify };
}

function setupLink(all: Transfer[], trackedList: Array<[string, string]> = []) {
  const { engine, provider, db, tracked, classify } = setup(all, trackedList);
  const linker = createLinkFinder({ db, provider, classify, tracked: () => tracked, loadHistory: engine.loadHistory });
  return linker;
}

// 32–44 символа base58: buildTrackedIndex проверяет формат.
const addr = (name: string) => (name + 'x'.repeat(40)).slice(0, 40).replace(/[0OIl]/g, 'z');
const T = addr('Target');
const A = addr('Alpha');
const B = addr('Beta');
const R = addr('Root');
const X = addr('Exchangeish');
const D = addr('Distributor');
const P = addr('Deposit');
const SS = addr('Sigma');
const F = addr('Funder');
const COINBASE = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS';

/** n разных обычных кошельков-получателей. */
const wallets = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => addr(`${prefix}${i}q`));

// ---------- 1–2. Сервисы по поведению ----------

test('хот-кошелёк биржи по поведению: связь через него скрыта, узел — хаб-сервис', async () => {
  const transfers: Transfer[] = [sol(X, T, 1, 10)]; // цель получила SOL от X
  const recipients = [A, ...wallets('cex', 119)]; // 120 разных получателей, один из них Alpha
  recipients.forEach((w, i) => transfers.push(sol(X, w, 0.05, 20 + i)));
  const { engine } = setup(transfers, [[A, 'Alpha']]);

  const r = await engine.analyze(T, { depth: 2 }, newCtx());
  assert.ok(!r.connections.some((c) => c.wallet.address === A), 'через сервис связи с Alpha нет');
  const node = r.nodes.find((n) => n.id === X);
  if (node) {
    assert.equal(node.kind, 'hub');
    assert.equal(node.hubCategory, 'service');
  }
  assert.ok(!r.nodes.some((n) => n.id === X && n.kind === 'intermediary'));
});

test('личный раздатчик (один отправитель — цель, 45 получателей) не считается сервисом', async () => {
  const transfers: Transfer[] = [sol(T, D, 5, 10)];
  const recipients = [B, ...wallets('dist', 44)];
  recipients.forEach((w, i) => transfers.push(sol(D, w, 0.2, 20 + i)));
  const { engine } = setup(transfers, [[B, 'Beta']]);

  const r = await engine.analyze(T, { depth: 2 }, newCtx());
  const c = r.connections.find((x) => x.wallet.address === B);
  assert.ok(c, 'Beta найдена через раздатчика');
  assert.deepEqual(c!.paths[0].nodes, [T, D, B]);
  assert.equal(r.nodes.find((n) => n.id === D)?.kind, 'intermediary');
});

test('цепочка финансирования останавливается на сервисе, найденном по поведению', async () => {
  const transfers: Transfer[] = [sol(R, F, 5, 1), sol(F, T, 1, 5)]; // Root (в списке) → F → цель
  wallets('svc', 105).forEach((w, i) => transfers.push(sol(F, w, 0.05, 20 + i)));
  const { engine } = setup(transfers, [[R, 'Root']]);

  const r = await engine.analyze(T, { depth: 3 }, newCtx());
  assert.ok(!r.connections.some((c) => c.paths.some((p) => p.type === 'funding-chain')), 'за сервисом цепочка не идёт');
  assert.ok(!r.connections.some((c) => c.wallet.address === R));
  assert.equal(r.nodes.find((n) => n.id === F)?.kind, 'hub');
  assert.ok(!r.nodes.some((n) => n.id === R));
});

// ---------- 3. Общий депозитный адрес ----------

test('общий депозитный адрес биржи: shared-deposit, оценка не ниже 0.75, на узле depositOf', async () => {
  const transfers = [sol(T, P, 2, 10), sol(SS, P, 3, 11), sol(P, COINBASE, 5, 12)];
  const { engine } = setup(transfers, [[SS, 'Sigma']]);

  const r = await engine.analyze(T, { depth: 2 }, newCtx());
  const c = r.connections.find((x) => x.wallet.address === SS);
  assert.ok(c, 'связь с Sigma найдена');
  assert.equal(c!.paths[0].type, 'shared-deposit');
  assert.deepEqual(c!.paths[0].nodes, [T, P, SS]);
  assert.ok(c!.score >= 0.75);
  assert.ok(r.nodes.find((n) => n.id === P)?.depositOf, 'у узла депозитного адреса есть depositOf');
});

// ---------- 4. Свои кошельки ----------

test('кошелёк, первым пополненный целью, — вероятный свой кошелёк (funded-by-target)', async () => {
  const W1 = addr('Fresh1');
  const { engine } = setup([sol(R, T, 3, 1), sol(T, W1, 1, 100)], []);
  const r = await engine.analyze(T, { depth: 2 }, newCtx());
  const s = r.siblings.find((x) => x.address === W1);
  assert.ok(s);
  assert.ok(s!.signals.includes('funded-by-target'));
});

test('переводы в обе стороны и токены дают two-way и token-moves', async () => {
  const W2 = addr('Twin2');
  const other = addr('OtherSrc');
  const all = [sol(R, T, 3, 1), sol(other, W2, 1, 5), sol(T, W2, 1, 100), sol(W2, T, 0.5, 101), token(T, W2, 102)];
  const { engine } = setup(all, []);
  const r = await engine.analyze(T, { depth: 2 }, newCtx());
  const s = r.siblings.find((x) => x.address === W2);
  assert.ok(s);
  assert.ok(s!.signals.includes('two-way'));
  assert.ok(s!.signals.includes('token-moves'));
});

test('единственный платёж 2 SOL кошельку с собственным ранним пополнением — не свой кошелёк', async () => {
  const W3 = addr('Payee3');
  const all = [sol(R, T, 3, 1), sol(addr('OtherSrc'), W3, 1, 5), sol(T, W3, 2, 100)];
  const { engine } = setup(all, []);
  const r = await engine.analyze(T, { depth: 2 }, newCtx());
  assert.ok(!r.siblings.some((x) => x.address === W3));
});

test('отслеживаемые кошельки никогда не попадают в siblings', async () => {
  // Alpha — свежий кошелёк, первым пополненный целью: для не из списка это был бы funded-by-target.
  const { engine } = setup([sol(R, T, 3, 1), sol(T, A, 2, 100)], [[A, 'Alpha']]);
  const r = await engine.analyze(T, { depth: 2 }, newCtx());
  assert.ok(r.connections.some((c) => c.wallet.address === A));
  assert.ok(!r.siblings.some((x) => x.address === A));
});

test('глубина 1: siblings пуст', async () => {
  const W1 = addr('Fresh1');
  const { engine } = setup([sol(R, T, 3, 1), sol(T, W1, 1, 100)], []);
  const r = await engine.analyze(T, { depth: 1 }, newCtx());
  assert.deepEqual(r.siblings, []);
});

// ---------- 5. Режим «Два кошелька» ----------

test('link: прямой перевод A → B даёт путь direct', async () => {
  const LA = addr('LinkA');
  const LB = addr('LinkB');
  const linker = setupLink([sol(LA, LB, 1, 10)]);
  const r = await linker.link(LA, LB, { maxHops: 3 }, newCtx());
  assert.ok(r.paths.some((p) => p.type === 'direct' && p.nodes.length === 2));
  assert.ok(r.score > 0);
});

test('link: общий источник даёт путь common-funder [A, X, B]; у A тип target, у B — pair', async () => {
  const LA = addr('LinkA');
  const LB = addr('LinkB');
  const LX = addr('LinkX');
  const linker = setupLink([sol(LX, LA, 1, 10), sol(LX, LB, 1, 11)]);
  const r = await linker.link(LA, LB, { maxHops: 3 }, newCtx());
  assert.ok(r.paths.some((p) => p.type === 'common-funder' && p.nodes.join() === [LA, LX, LB].join()));
  assert.equal(r.nodes.find((n) => n.id === LA)?.kind, 'target');
  assert.equal(r.nodes.find((n) => n.id === LB)?.kind, 'pair');
});

test('link: путь A–X–Y–B из трёх шагов находится при maxHops 3, но не при 2', async () => {
  const LA = addr('LinkA');
  const LB = addr('LinkB');
  const LX = addr('LinkX');
  const LY = addr('LinkY');
  const LZ = addr('LinkZ');
  // Z пополнил X раньше A: цепочки финансирования не сходятся и не подменяют поиск путей.
  const all = [sol(LZ, LX, 1, 1), sol(LA, LX, 1, 10), sol(LX, LY, 1, 11), sol(LY, LB, 1, 12)];
  const full = [LA, LX, LY, LB].join();

  const r3 = await setupLink(all).link(LA, LB, { maxHops: 3 }, newCtx());
  assert.ok(r3.paths.some((p) => p.nodes.join() === full));
  const r2 = await setupLink(all).link(LA, LB, { maxHops: 2 }, newCtx());
  assert.ok(!r2.paths.some((p) => p.nodes.join() === full));
  assert.deepEqual(r2.paths, []);
});

test('link: путь через сервисоподобный кошелёк (100+ получателей) не возвращается', async () => {
  const LA = addr('LinkA');
  const LB = addr('LinkB');
  const LX = addr('LinkX');
  const all: Transfer[] = [sol(LA, LX, 1, 10), sol(LX, LB, 1, 11)];
  wallets('lsvc', 105).forEach((w, i) => all.push(sol(LX, w, 0.05, 20 + i)));
  const r = await setupLink(all).link(LA, LB, { maxHops: 3 }, newCtx());
  assert.deepEqual(r.paths, []);
});

test('link: цепочки финансирования сходятся выше — funding-chain с общим R', async () => {
  const LA = addr('LinkA');
  const LB = addr('LinkB');
  const F1 = addr('LinkF1');
  const F2 = addr('LinkF2');
  const LR = addr('LinkRoot');
  const all = [sol(LR, F1, 3, 1), sol(LR, F2, 3, 2), sol(F1, LA, 1, 5), sol(F2, LB, 1, 6)];
  const r = await setupLink(all).link(LA, LB, { maxHops: 3 }, newCtx());
  const p = r.paths.find((x) => x.type === 'funding-chain');
  assert.ok(p, 'путь по цепочкам найден');
  assert.ok(p!.nodes.includes(LR));
  assert.deepEqual(p!.nodes, [LA, F1, LR, F2, LB]);
});

test('link: несвязанные кошельки — путей нет, оценка 0, есть предупреждение', async () => {
  const LA = addr('LinkA');
  const LB = addr('LinkB');
  const all = [sol(LA, addr('Unrel1'), 1, 10), sol(LB, addr('Unrel2'), 1, 11)];
  const r = await setupLink(all).link(LA, LB, { maxHops: 3 }, newCtx());
  assert.deepEqual(r.paths, []);
  assert.equal(r.score, 0);
  assert.ok(r.warnings.length > 0);
});
