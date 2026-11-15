// Калибровочная оценка: по кошельку сущности (≥2 кошельков в списке) движок должен найти остальные кошельки той же сущности.
// Запуск: HELIUS_RPS=6 node --env-file=.env scripts/eval.ts --n=20 --seed=1
import fs from 'node:fs';
import path from 'node:path';
import type { AnalyzeResult } from '../shared/types.ts';
import { createClassifier } from '../server/accounts.ts';
import { createEngine } from '../server/analyze.ts';
import { config, ROOT } from '../server/config.ts';
import { createDb } from '../server/db.ts';
import { newCtx } from '../server/http.ts';
import { createDefaultProvider } from '../server/providers/index.ts';
import { loadTracked } from '../server/tracked.ts';

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(a);
  if (m) args.set(m[1], m[2]);
}
const N = Number(args.get('n') ?? 20);
const SEED = Number(args.get('seed') ?? 1);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(arr: T[], rnd: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const INFRA = /\b(raydium|incinerator|pump|jito|jupiter|binance|coinbase|okx|bybit|kraken|bitget|kucoin|gate|mexc|htx|exchange|fee|burn|bonk|meteora|orca|phantom|moonshot|axiom|photon|bullx|gmgn|trojan|bot|treasury|dex|vault|market ?maker|wintermute|system)\b/i;

interface Row {
  entity: string;
  entityName: string;
  walletsInEntity: number;
  target: string;
  targetName: string;
  error?: string;
  found?: boolean;
  rank?: number | null;
  score?: number | null;
  othersFound?: number;
  othersTotal?: number;
  pathTypes?: Record<string, number>;
  fp03?: { name: string; score: number; pathTypes: string[] }[];
  fp06?: { name: string; score: number; pathTypes: string[] }[];
  siblings?: { count: number; items: { address: string; score: number; signals: string[] }[] };
  warnings?: string[];
  top3?: { name: string; score: number }[];
  apiCalls?: number;
  credits?: number;
  durationMs?: number;
}

const db = createDb(config.dbFile);
const provider = createDefaultProvider();
const tracked = loadTracked(config.trackedFile);
db.syncTracked(tracked.wallets.map((w) => w.address));
const classify = createClassifier(db, config.rpcUrl, config.heliusKey ? config.heliusRps : config.publicRps);
const engine = createEngine({ db, provider, classify, tracked: () => tracked, recentTtlSec: config.recentTtlSec });

// Отбор сущностей.
const byEntity = new Map<string, typeof tracked.wallets>();
for (const w of tracked.wallets) {
  const l = byEntity.get(w.entity) ?? [];
  l.push(w);
  byEntity.set(w.entity, l);
}
const eligible = [...byEntity.entries()]
  .filter(([, ws]) => ws.length >= 2 && ws.length <= 30 && !INFRA.test(ws[0].entityName) && !ws.some((w) => INFRA.test(w.name)))
  .sort((a, b) => (a[0] < b[0] ? -1 : 1));
const rnd = mulberry32(SEED);
const picked = shuffle(eligible, rnd).slice(0, N);
const targets = picked.map(([entity, ws]) => ({ entity, ws, target: ws[Math.floor(rnd() * ws.length)] }));

console.log(`Provider: ${provider.name}; HELIUS_RPS=${config.heliusRps}; eligible entities: ${eligible.length}; N=${targets.length}; seed=${SEED}`);

const rows: Row[] = [];
const t0 = Date.now();
let i = 0;
for (const { entity, ws, target } of targets) {
  i++;
  const row: Row = { entity, entityName: ws[0].entityName, walletsInEntity: ws.length, target: target.address, targetName: target.name };
  try {
    const ctx = newCtx();
    const r: AnalyzeResult = await engine.analyze(target.address, { depth: 2 }, ctx);
    const idx = r.entities.findIndex((e) => e.entity === entity);
    const ent = idx >= 0 ? r.entities[idx] : null;
    const others = ws.filter((w) => w.address !== target.address).map((w) => w.address);
    row.found = !!ent;
    row.rank = ent ? idx + 1 : null;
    row.score = ent ? ent.score : null;
    row.othersTotal = others.length;
    row.othersFound = ent ? ent.wallets.filter((a) => others.includes(a)).length : 0;
    const types: Record<string, number> = {};
    for (const c of r.connections) {
      if (c.wallet.entity !== entity) continue;
      for (const p of c.paths) types[p.type] = (types[p.type] ?? 0) + 1;
    }
    row.pathTypes = types;
    const typesOf = (ent2: string) => {
      const s = new Set<string>();
      for (const c of r.connections) if (c.wallet.entity === ent2) for (const p of c.paths) s.add(p.type);
      return [...s];
    };
    const otherEnts = r.entities.filter((e) => e.entity !== entity);
    row.fp03 = otherEnts.filter((e) => e.score >= 0.3).map((e) => ({ name: e.entityName, score: e.score, pathTypes: typesOf(e.entity) }));
    row.fp06 = otherEnts.filter((e) => e.score >= 0.6).map((e) => ({ name: e.entityName, score: e.score, pathTypes: typesOf(e.entity) }));
    row.siblings = { count: r.siblings.length, items: r.siblings.map((s) => ({ address: s.address, score: s.score, signals: s.signals })) };
    row.warnings = r.warnings;
    row.top3 = r.entities.slice(0, 3).map((e) => ({ name: e.entityName, score: e.score }));
    row.apiCalls = r.stats.apiCalls;
    row.credits = r.stats.creditsEstimate;
    row.durationMs = r.stats.durationMs;
  } catch (e) {
    row.error = e instanceof Error ? e.message : String(e);
  }
  rows.push(row);
  console.log(
    `[${i}/${targets.length}] ${row.entityName} (${row.walletsInEntity}w) ${row.error ? 'ERROR ' + row.error : `found=${row.found} rank=${row.rank} score=${row.score?.toFixed(2)} fp03=${row.fp03?.length} fp06=${row.fp06?.length} credits=${row.credits} ${row.durationMs}ms`}`,
  );
}
const totalMs = Date.now() - t0;

// Итоги.
const ok = rows.filter((r) => !r.error);
const found = ok.filter((r) => r.found);
const top1 = ok.filter((r) => r.rank === 1);
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const summary = {
  n: rows.length,
  errors: rows.length - ok.length,
  recall: `${found.length}/${rows.length}`,
  recallAt1: `${top1.length}/${rows.length}`,
  medianTrueScore: median(found.map((r) => r.score ?? 0)),
  medianTrueScoreAllTargets: median(ok.map((r) => r.score ?? 0)),
  meanOtherGe03: mean(ok.map((r) => r.fp03?.length ?? 0)),
  meanOtherGe06: mean(ok.map((r) => r.fp06?.length ?? 0)),
  totalCredits: rows.reduce((s, r) => s + (r.credits ?? 0), 0),
  totalApiCalls: rows.reduce((s, r) => s + (r.apiCalls ?? 0), 0),
  totalTimeSec: Math.round(totalMs / 1000),
};

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
console.log('\n' + [pad('entity', 18), pad('w', 3), pad('found', 5), pad('rank', 4), pad('score', 5), pad('oth', 5), pad('>=.3', 4), pad('>=.6', 4), pad('sib', 3), pad('warn', 4), pad('calls', 5), pad('cred', 6), pad('ms', 6), 'paths'].join(' '));
for (const r of rows) {
  if (r.error) {
    console.log(`${pad(r.entityName, 18)} ${pad(String(r.walletsInEntity), 3)} ERROR ${r.error}`);
    continue;
  }
  console.log(
    [
      pad(r.entityName, 18),
      pad(String(r.walletsInEntity), 3),
      pad(r.found ? 'yes' : 'NO', 5),
      pad(String(r.rank ?? '-'), 4),
      pad(r.score != null ? r.score.toFixed(2) : '-', 5),
      pad(`${r.othersFound}/${r.othersTotal}`, 5),
      pad(String(r.fp03?.length), 4),
      pad(String(r.fp06?.length), 4),
      pad(String(r.siblings?.count), 3),
      pad(String(r.warnings?.length), 4),
      pad(String(r.apiCalls), 5),
      pad(String(r.credits), 6),
      pad(String(r.durationMs), 6),
      Object.entries(r.pathTypes ?? {}).map(([k, v]) => `${k}:${v}`).join(','),
    ].join(' '),
  );
}
console.log('\nSUMMARY ' + JSON.stringify(summary, null, 2));

const outDir = path.join(ROOT, '.cache');
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, JSON.stringify({ args: { n: N, seed: SEED }, summary, rows }, null, 1));
console.log(`Results: ${file}`);
process.exit(0);
