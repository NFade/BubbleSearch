import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEngine } from '../server/analyze.ts';
import { SOL_MINT } from '../server/config.ts';
import { createDb } from '../server/db.ts';
import { createGroupFinder, GROUP_MAX } from '../server/group.ts';
import { newCtx } from '../server/http.ts';
import type { Transfer, TransferProvider } from '../server/providers/types.ts';
import { FEE_PAYER_SCORE } from '../server/scoring.ts';
import { buildTrackedIndex } from '../server/tracked.ts';

// Адреса в тестах — произвольные строки: движку важны только совпадения.
let sigN = 0;
function sol(from: string, to: string, amount: number, slot: number): Transfer {
  return { signature: `gsig${++sigN}`, slot, blockTime: 1_700_000_000 + slot, from, to, mint: SOL_MINT, amountRaw: String(Math.round(amount * 1e9)), decimals: 9, uiAmount: amount };
}
/** Покупка токена: SOURCE → кошелёк, уникальная подпись. */
function buy(to: string, mint: string, slot: number): Transfer {
  return { signature: `gbuy${++sigN}`, slot, blockTime: 1_700_000_000 + slot, from: addr('Pool'), to, mint, amountRaw: '1000000', decimals: 6, uiAmount: 1 };
}

interface FakeOpts {
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

function setup(all: Transfer[], trackedList: Array<[string, string]> = [], o: FakeOpts = {}) {
  const db = createDb(':memory:');
  if (trackedList.length === 0) trackedList = [[addr('Bystander'), 'Bystander']];
  const tracked = buildTrackedIndex(trackedList.map(([trackedWalletAddress, name]) => ({ trackedWalletAddress, name, emoji: '', groups: ['Main'] })));
  db.syncTracked(tracked.wallets.map((w) => w.address));
  const provider = fakeProvider(all, o);
  const classify = async (addresses: string[]) => new Map(addresses.map((a) => [a, 'wallet'] as const));
  const engine = createEngine({ db, provider, classify, tracked: () => tracked, recentTtlSec: 3600 });
  const g = createGroupFinder({ db, provider, classify, tracked: () => tracked, loadHistory: engine.loadHistory, loadPayers: engine.loadPayers });
  return { db, engine, provider, tracked, classify, g };
}

// 32–44 символа base58: buildTrackedIndex проверяет формат.
const addr = (name: string) => (name + 'x'.repeat(40)).slice(0, 40).replace(/[0OIl]/g, 'z');
const A = addr('Alpha');
const B = addr('Beta');
const C = addr('Gamma');
const X = addr('Xfunder');
const Z = addr('ZetaTracked');

/** Как это делает индекс: кладёт историю кошельков в кэш. */
async function seedCache(s: ReturnType<typeof setup>, wallets: string[]) {
  for (const w of wallets) await s.engine.loadHistory(w, { recent: 100, oldest: 100 }, newCtx());
}

// ---------- 1. Быстрый режим: прямой перевод ----------

test('быстрый режим: прямой перевод A→B 2 SOL — связь direct, кластер [A,B] и одиночка C, узлы target с cluster', async () => {
  const s = setup([sol(A, B, 2, 10), sol(addr('Other1'), C, 1, 11)]);
  await seedCache(s, [A, B, C]);
  const callsAfterSeed = s.provider.calls.length;
  const r = await s.g.group([A, B, C], { deep: false }, newCtx());

  assert.equal(s.provider.calls.length, callsAfterSeed, 'после наполнения кэша запросов к провайдеру нет');
  assert.equal(r.stats.walletsFetched, 0);
  const direct = r.links.find((l) => l.type === 'direct' && new Set([l.a, l.b]).size === 2 && [l.a, l.b].includes(A) && [l.a, l.b].includes(B));
  assert.ok(direct, 'есть связь direct A–B');
  assert.deepEqual(direct!.nodes, [A, B]);

  const together = r.clusters.find((c) => c.includes(A));
  assert.ok(together);
  assert.deepEqual([...together!].sort(), [A, B].sort());
  assert.deepEqual(r.clusters.find((c) => c.includes(C)), [C]);

  const node = (id: string) => r.nodes.find((n) => n.id === id);
  for (const w of [A, B, C]) {
    assert.equal(node(w)?.kind, 'target', 'узел выбранного кошелька — target');
    assert.notEqual(node(w)?.cluster, undefined, 'cluster задан');
  }
  assert.equal(node(A)!.cluster, node(B)!.cluster);
  assert.notEqual(node(A)!.cluster, node(C)!.cluster);
});

// ---------- 2. Общий источник ----------

test('общий источник X (X→A 1 SOL, X→B 1 SOL) — связь common-funder с узлами [A, X, B]', async () => {
  const s = setup([sol(X, A, 1, 10), sol(X, B, 1, 11)]);
  await seedCache(s, [A, B]);
  const r = await s.g.group([A, B], { deep: false }, newCtx());
  const l = r.links.find((x) => x.type === 'common-funder');
  assert.ok(l, 'common-funder найден: ' + JSON.stringify(r.links.map((x) => x.type)));
  assert.deepEqual(l!.nodes, [A, X, B]);
});

// ---------- 3. Совместные покупки ----------

test('co-buy: A и B купили 3 токена в одних слотах разными транзакциями — связь co-buy', async () => {
  const mints = ['MintAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'MintBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'MintCcccccccccccccccccccccccccccccccccccc'];
  const s = setup([]);
  s.db.insertTransfers(mints.flatMap((m, i) => [buy(A, m, 100 + i), buy(B, m, 100 + i)]));
  // Кэш для A и B помечен как загруженный, чтобы не было предупреждения «нет истории».
  const r = await s.g.group([A, B], { deep: false }, newCtx());
  const l = r.links.find((x) => x.type === 'co-buy');
  assert.ok(l, 'co-buy найден: ' + JSON.stringify(r.links.map((x) => x.type)));
  assert.deepEqual([l!.a, l!.b].sort(), [A, B].sort());
  assert.deepEqual(l!.nodes, [A, B]);
});

// ---------- 4. Плательщик комиссий ----------

test('fee-payer: B оплачивал комиссии A (по индексу) — связь fee-payer [A, B] со score FEE_PAYER_SCORE', async () => {
  const s = setup([sol(addr('Root'), A, 5, 1), sol(addr('Root'), B, 5, 2)]);
  await seedCache(s, [A, B]);
  s.db.setFeePayers(B, new Map([[A, 3]]));
  const r = await s.g.group([A, B], { deep: false }, newCtx());
  const l = r.links.find((x) => x.type === 'fee-payer');
  assert.ok(l, 'fee-payer найден');
  assert.deepEqual(l!.nodes, [A, B]);
  assert.equal(l!.score, FEE_PAYER_SCORE);
});

// ---------- 5. Хаб-посредник ----------

test('глубокий режим: X — биржеподобный хаб (120 получателей) и платит A и B — связи через X нет', async () => {
  const recipients = Array.from({ length: 120 }, (_, i) => sol(X, addr(`Rcpt${i}q`), 0.5, 10 + i));
  // A и B — самые свежие получатели, чтобы попасть в выборку профиля (100 последних).
  const all = [...recipients, sol(X, A, 1, 1000), sol(X, B, 1, 1001)];
  const s = setup(all);
  const r = await s.g.group([A, B], { deep: true }, newCtx());
  assert.ok(!r.links.some((l) => l.nodes.includes(X)), 'пути через хаб X отброшены: ' + JSON.stringify(r.links.map((l) => [l.type, l.nodes])));
  assert.ok(!r.clusters.some((c) => c.length > 1), 'A и B не склеены');
});

// ---------- 6. Внешние связи ----------

test('external: у A есть перевод 1 SOL с отслеживаемым Z (не выбран) — external содержит { from: A, wallet: Z, type direct }', async () => {
  const s = setup([sol(A, Z, 1, 10), sol(addr('Root'), B, 5, 11)], [[Z, 'Zeta']]);
  await seedCache(s, [A, B]);
  const r = await s.g.group([A, B], { deep: false }, newCtx());
  const e = r.external.find((x) => x.from === A && x.wallet.address === Z);
  assert.ok(e, 'внешняя связь найдена: ' + JSON.stringify(r.external));
  assert.equal(e!.type, 'direct');
  assert.ok(r.nodes.some((n) => n.id === Z && n.kind === 'tracked'), 'Z на карте как tracked');
});

// ---------- 7. Предупреждение ----------

test('быстрый режим: у выбранного кошелька нет истории в кэше — предупреждение «Глубже»', async () => {
  const s = setup([sol(A, B, 2, 10)]);
  await seedCache(s, [A]);
  const r = await s.g.group([A, C], { deep: false }, newCtx());
  const w = r.warnings.find((x) => x.includes('истории в кэше'));
  assert.ok(w, 'предупреждение есть: ' + JSON.stringify(r.warnings));
  assert.ok(w!.includes('Глубже'));
  assert.ok(w!.startsWith('Нет истории в кэше у 1 кошелька'), w);
});

// ---------- 8. Нормализация входа ----------

test('дубликаты адресов удаляются', async () => {
  const s = setup([sol(A, B, 2, 10)]);
  await seedCache(s, [A, B]);
  const r = await s.g.group([A, B, A, B, A], { deep: false }, newCtx());
  assert.deepEqual(r.addresses, [A, B]);
});

test('больше GROUP_MAX адресов обрезаются до 15', async () => {
  assert.equal(GROUP_MAX, 15);
  const many = Array.from({ length: 20 }, (_, i) => addr(`Many${i}w`));
  const s = setup([]);
  const r = await s.g.group(many, { deep: false }, newCtx());
  assert.equal(r.addresses.length, 15);
  assert.deepEqual(r.addresses, many.slice(0, 15));
});
