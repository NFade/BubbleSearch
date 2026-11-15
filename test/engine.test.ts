import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combineScores, createEngine, degreePenalty, edgeMetrics, edgeStrength } from '../server/analyze.ts';
import { SOL_MINT } from '../server/config.ts';
import { createDb } from '../server/db.ts';
import { newCtx } from '../server/http.ts';
import type { Transfer, TransferProvider } from '../server/providers/types.ts';
import { buildTrackedIndex } from '../server/tracked.ts';
import { PROFILE_RECENT } from '../server/workspace.ts';

// Адреса в тестах — произвольные строки: движку важны только совпадения.
let sigN = 0;
function sol(from: string, to: string, amount: number, slot: number): Transfer {
  return { signature: `sig${++sigN}`, slot, blockTime: 1_700_000_000 + slot, from, to, mint: SOL_MINT, amountRaw: String(Math.round(amount * 1e9)), decimals: 9, uiAmount: amount };
}
function token(from: string, to: string, slot: number): Transfer {
  return { signature: `sig${++sigN}`, slot, blockTime: 1_700_000_000 + slot, from, to, mint: 'MemeMint1111111111111111111111111111111111', amountRaw: '1000000', decimals: 6, uiAmount: 1 };
}

function fakeProvider(all: Transfer[]): TransferProvider & { calls: string[]; recentLimits: Map<string, number> } {
  const calls: string[] = [];
  const recentLimits = new Map<string, number>();
  const of = (a: string) => all.filter((t) => t.from === a || t.to === a);
  return {
    name: 'fake',
    note: '',
    calls,
    recentLimits,
    async fetchRecent(address, limit) {
      calls.push(`recent:${address}`);
      recentLimits.set(address, Math.max(recentLimits.get(address) ?? 0, limit));
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
  const tracked = buildTrackedIndex(trackedList.map(([trackedWalletAddress, name]) => ({ trackedWalletAddress, name, emoji: '', groups: ['Main'] })));
  db.syncTracked(tracked.wallets.map((w) => w.address));
  const provider = fakeProvider(all);
  const engine = createEngine({
    db,
    provider,
    classify: async (addresses) => new Map(addresses.map((a) => [a, programs.includes(a) ? 'program' : 'wallet'] as const)),
    tracked: () => tracked,
    recentTtlSec: 3600,
  });
  return { db, engine, provider, tracked };
}

// 32–44 символа base58: buildTrackedIndex проверяет формат.
const addr = (name: string) => (name + 'x'.repeat(40)).slice(0, 40).replace(/[0OIl]/g, 'z');
const T = addr('Target');
const A = addr('Alpha');
const B = addr('Beta');
const C = addr('Carol');
const D = addr('Dust');
const G = addr('Gamma');
const F = addr('Funder');
const F2 = addr('Funder2');
const H = addr('Hub');
const P = addr('Pool');
const V = addr('Service');

test('прямая связь, общий источник, цепочка финансирования; хабы, программы и сервисы не дают связей', async () => {
  const transfers: Transfer[] = [
    sol(F2, F, 5, 5), // F2 (в списке как Gamma) пополнил F
    sol(F, T, 1, 10), // F — первый источник цели
    sol(F, B, 1, 11), // F пополнял и Beta → общий источник
    sol(T, A, 2, 100), // прямой перевод Alpha
    sol(D, T, 0.000001, 101), // пыль от отслеживаемого
    sol(T, H, 0.5, 102), // хаб: сотни контрагентов
    sol(H, C, 3, 103),
    sol(T, P, 3, 104), // пул (аккаунт программы)
    sol(P, C, 3, 105),
    sol(T, V, 0.05, 106), // сервис: получает от многих имён из списка
  ];
  for (let i = 0; i < 200; i++) transfers.push(sol(H, addr(`hubcp${i}q`), 0.1, 200 + i));
  const serviceUsers: Array<[string, string]> = [];
  for (let i = 0; i < 9; i++) {
    const u = addr(`svcuser${i}q`);
    serviceUsers.push([u, `Person${String.fromCharCode(65 + i)}`]);
    transfers.push(sol(u, V, 0.05, 500 + i));
  }
  const { engine } = setup(transfers, [[A, 'Alpha'], [B, 'Beta'], [C, 'Carol'], [D, 'Dusty'], [G, 'Gamma'], [F2, 'Gamma Side'], ...serviceUsers], [P]);

  const r = await engine.analyze(T, { depth: 2 }, newCtx());
  const by = new Map(r.connections.map((c) => [c.wallet.address, c]));

  assert.equal(by.get(A)?.paths[0].type, 'direct');
  assert.ok(by.get(A)!.score > 0.5, 'перевод 2 SOL — заметная связь');

  assert.equal(by.get(B)?.paths[0].type, 'common-funder');
  assert.deepEqual(by.get(B)!.paths[0].nodes, [T, F, B]);
  assert.equal(by.get(B)!.hops, 2);

  assert.equal(by.get(F2)?.paths[0].type, 'funding-chain');
  assert.deepEqual(by.get(F2)!.paths[0].nodes, [T, F, F2]);

  assert.ok(by.get(D)!.score < 0.1, 'одна пыль — почти нулевая связь');
  assert.ok(!by.has(C), 'связь через хаб или пул не должна появляться');
  for (const [u] of serviceUsers) assert.ok(!by.has(u), 'связи через общий сервис скрыты');
  assert.ok(r.warnings.some((w) => w.includes('общий сервис')));

  // Сущности: Gamma Side относится к имени Gamma.
  assert.ok(r.entities.some((e) => e.entity === 'gamma' && e.wallets.includes(F2)));

  // Карта: цель, отслеживаемые, посредник; ребро первого пополнения помечено.
  const kinds = new Map(r.nodes.map((n) => [n.id, n.kind]));
  assert.equal(kinds.get(T), 'target');
  assert.equal(kinds.get(F), 'intermediary');
  assert.equal(kinds.get(B), 'tracked');
  // Распознанный сервис показывается как хаб (видно, что он узнан и отброшен); пул программы не показывается.
  assert.equal(kinds.get(H), 'hub');
  assert.equal(r.nodes.find((n) => n.id === H)?.hubCategory, 'service');
  assert.ok(!kinds.has(P));
  const fundingEdge = r.edges.find((e) => e.fundingOf === T);
  assert.ok(fundingEdge && [fundingEdge.source, fundingEdge.target].includes(F));
  for (const c of r.connections) for (const p of c.paths) for (const id of p.edgeIds) assert.ok(r.edges.some((e) => e.id === id), 'каждое ребро пути есть на карте');
});

test('глубина 1 не раскрывает посредников', async () => {
  const { engine, provider } = setup([sol(F, T, 1, 10), sol(F, B, 1, 11), sol(T, A, 2, 100)], [[A, 'Alpha'], [B, 'Beta']]);
  const r = await engine.analyze(T, { depth: 1 }, newCtx());
  assert.deepEqual(r.connections.map((c) => c.wallet.address), [A]);
  assert.deepEqual(provider.calls, [`recent:${T}`]);
});

test('обратный поиск по кэшу находит связь без загрузки посредника', async () => {
  // Посредников 3, раскрываем только 1 самого значимого; связь через слабого находится по сохранённой истории Beta.
  const X1 = addr('Strong');
  const X2 = addr('Weak');
  const all = [sol(T, X1, 10, 20), sol(T, X2, 0.02, 21), sol(X2, B, 0.5, 22), sol(addr('Root'), T, 1, 1)];
  const { engine, provider } = setup(all, [[B, 'Beta']]);
  await engine.loadHistory(B, { recent: 0, oldest: 100 }, newCtx()); // как делает index-tracked
  const r = await engine.analyze(T, { depth: 2, maxIntermediaries: 1 }, newCtx());
  const c = r.connections.find((x) => x.wallet.address === B);
  assert.ok(c, 'связь найдена');
  assert.deepEqual(c!.paths[0].nodes, [T, X2, B]);
  assert.ok((provider.recentLimits.get(X2) ?? 0) <= PROFILE_RECENT, 'полную историю слабого посредника не загружали, только короткую проверку');
});

test('переводы токенов между кошельками считаются связью', async () => {
  const { engine } = setup([token(A, T, 50), token(A, T, 51), sol(addr('Root'), T, 1, 1)], [[A, 'Alpha']]);
  const r = await engine.analyze(T, { depth: 1 }, newCtx());
  assert.ok(r.connections[0].score >= 0.35 && r.connections[0].score < 0.7);
});

test('повторный анализ берёт данные из кэша', async () => {
  const { engine, provider } = setup([sol(T, A, 2, 100)], [[A, 'Alpha']]);
  await engine.analyze(T, { depth: 2 }, newCtx());
  const before = provider.calls.length;
  await engine.analyze(T, { depth: 2 }, newCtx());
  assert.equal(provider.calls.length, before);
});

test('оценка: монотонность и границы', () => {
  const m = (amount: number, n = 1) => edgeMetrics({ a: 'a', transfers: Array.from({ length: n }, (_, i) => sol('a', 'b', amount, i)) }, 0.01);
  assert.ok(edgeStrength(m(0.000001), false) < 0.1);
  assert.ok(edgeStrength(m(0.05), false) < edgeStrength(m(1), false));
  assert.ok(edgeStrength(m(1), false) < edgeStrength(m(10), false));
  assert.ok(edgeStrength(m(1), false) < edgeStrength(m(1, 5), false));
  assert.ok(edgeStrength(m(0.05), true) >= 0.85);
  assert.ok(edgeStrength(m(1000, 50), true) <= 1);
  assert.equal(degreePenalty(2), 1);
  assert.ok(degreePenalty(13) > degreePenalty(53) && degreePenalty(53) > degreePenalty(140));
  assert.ok(Math.abs(combineScores([0.5, 0.5]) - 0.75) < 1e-9);
});

test('кошелёк-сборщик комиссий (только принимает от многих) не даёт связей', async () => {
  const K = addr('Collector');
  const transfers: Transfer[] = [sol(addr('Root'), T, 1, 1), sol(T, K, 0.02, 10), sol(T, K, 0.02, 11), sol(K, addr('Sweep'), 5, 900)];
  const payers: Array<[string, string]> = [];
  for (let i = 0; i < 30; i++) {
    const u = addr(`payer${i}q`);
    if (i < 4) payers.push([u, `Trader${String.fromCharCode(65 + i)}`]);
    transfers.push(sol(u, K, 0.02, 100 + i));
  }
  const { engine } = setup(transfers, payers);
  const r = await engine.analyze(T, { depth: 2 }, newCtx());
  assert.equal(r.connections.length, 0, 'связей через сборщика нет');
  assert.ok(r.warnings.some((w) => w.includes('сбор комиссий')));

  // Обычный посредник с встречными переводами по-прежнему даёт связь.
  const M = addr('Middle');
  const ok = setup([sol(addr('Root'), T, 1, 1), sol(T, M, 1, 10), sol(M, T, 0.5, 11), sol(M, A, 1, 12)], [[A, 'Alpha']]);
  const r2 = await ok.engine.analyze(T, { depth: 2 }, newCtx());
  assert.deepEqual(r2.connections[0]?.paths[0].nodes, [T, M, A]);
});

test('глубина 3: связь в три шага (цель → X → Y → список) находится, на глубине 2 — нет', async () => {
  const X = addr('HopOne');
  const Y = addr('HopTwo');
  const Sx = addr('ThreeHopTracked');
  const all = [sol(addr('Root3'), T, 1, 1), sol(T, X, 2, 10), sol(X, Y, 2, 11), sol(Y, Sx, 2, 12)];
  const d2 = setup(all, [[Sx, 'Far']]);
  const r2 = await d2.engine.analyze(T, { depth: 2 }, newCtx());
  assert.ok(!r2.connections.some((c) => c.wallet.address === Sx), 'на глубине 2 трёхшаговой связи нет');
  const d3 = setup(all, [[Sx, 'Far']]);
  const r3 = await d3.engine.analyze(T, { depth: 3 }, newCtx());
  const c = r3.connections.find((x) => x.wallet.address === Sx);
  assert.ok(c, 'на глубине 3 связь найдена');
  assert.deepEqual(c!.paths[0].nodes, [T, X, Y, Sx]);
  assert.equal(c!.hops, 3);
  assert.ok(c!.paths[0].reason.includes('3 шага'));
  for (const id of c!.paths[0].edgeIds) assert.ok(r3.edges.some((e) => e.id === id), 'рёбра пути есть на карте');
});
