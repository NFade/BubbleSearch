import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDb } from '../server/db.ts';
import { newCtx } from '../server/http.ts';
import { buildTrackedIndex } from '../server/tracked.ts';
import { createWalletsService } from '../server/wallets.ts';

const addr = (c: string) => c.repeat(44);
const [W1, W2, W3] = [addr('A'), addr('B'), addr('C')];

function setup(rpc: (m: string, p: any) => Promise<any>) {
  const db = createDb(':memory:');
  const tracked = buildTrackedIndex([
    { trackedWalletAddress: W1, name: 'Yugi', emoji: '🐸', groups: ['x'] },
    { trackedWalletAddress: W2, name: 'Yugi2' },
    { trackedWalletAddress: W3, name: 'Other' },
  ]);
  const svc = createWalletsService({ db, tracked: () => tracked, rpcUrl: 'x', rps: 100, rpc: (m, p) => rpc(m, p) });
  return { db, svc };
}

const tr = (from: string, to: string, t: number, sig: string) => ({ key: sig, signature: sig, slot: t, blockTime: t, from, to, mint: 'So1', amountRaw: '1', decimals: 9, uiAmount: 1 });

test('list: балансы, активность, возраст, индекс', async () => {
  const { db, svc } = setup(async (m, p) => {
    assert.equal(m, 'getMultipleAccounts');
    return { value: p[0].map((a: string) => (a === W3 ? null : { lamports: 2_500_000_000 })) };
  });
  db.insertTransfers([tr(W1, 'zzz', 100, 's1'), tr('zzz', W1, 300, 's2'), tr(W2, 'zzz', 200, 's3')]);
  db.setFetch(W1, 'recent', { fetchedAt: 1000, rowLimit: 200, rows: 2, complete: true });
  db.setFetch(W2, 'recent', { fetchedAt: 1000, rowLimit: 200, rows: 1, complete: false });
  db.setFetch(W1, 'payers', { fetchedAt: 1000, rowLimit: 1, rows: 1, complete: true });
  const r = await svc.list(newCtx(), { wait: true });
  assert.ok(r.balancesAt);
  const by = new Map(r.wallets.map((w) => [w.address, w]));
  assert.equal(by.get(W1)!.balanceSol, 2.5);
  assert.equal(by.get(W3)!.balanceSol, 0);
  assert.equal(by.get(W1)!.lastActive, 300);
  assert.equal(by.get(W1)!.firstSeen, 100);
  assert.deepEqual(by.get(W1)!.indexed, { history: true, payers: true, fetchedAt: 1000 });
  assert.equal(by.get(W2)!.lastActive, 200);
  assert.equal(by.get(W2)!.firstSeen, null); // загрузка неполная
  assert.equal(by.get(W3)!.lastActive, null);
  assert.deepEqual(by.get(W3)!.indexed, { history: false, payers: false, fetchedAt: null });
});

test('list: сбой пачки не роняет список; балансы кэшируются', async () => {
  const { svc } = setup(async () => {
    throw new Error('boom');
  });
  const r = await svc.list(newCtx(), { wait: true });
  assert.equal(r.wallets.length, 3);
  assert.equal(r.wallets[0].balanceSol, null);
  assert.equal(r.balancesAt, null);

  let ok = 0;
  const s2 = setup(async (_m, p) => (ok++, { value: p[0].map(() => ({ lamports: 1e9 })) }));
  await s2.svc.list(newCtx(), { wait: true });
  await s2.svc.list(newCtx(), { wait: true });
  assert.equal(ok, 1);
});

test('refresh: точная активность и баланс', async () => {
  const { svc } = setup(async (m, p) => {
    if (m === 'getSignaturesForAddress') {
      assert.deepEqual(p[1], { limit: 1 });
      return [{ blockTime: 999 }];
    }
    return { value: [{ lamports: 5e9 }] };
  });
  const row = await svc.refresh(W1, newCtx());
  assert.equal(row.lastActive, 999);
  assert.equal(row.balanceSol, 5);
  await assert.rejects(svc.refresh('nope', newCtx()));
});
