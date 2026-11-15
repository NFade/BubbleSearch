// Индексация списка отслеживания: загружает в кэш самые ранние (и по желанию свежие) переводы каждого кошелька.
// После этого поиск видит общие источники средств без новых запросов к сети.
//
//   npm run index-tracked                       # источники средств всех кошельков (≈10 кредитов Helius на кошелёк)
//   npm run index-tracked -- --recent=300       # плюс последние 300 переводов каждого
//   npm run index-tracked -- --group=esse --limit=50
//   npm run index-tracked -- --recent=200 --ttl-days=7   # обновить: догрузить новые переводы у кошельков старше 7 дней
//   npm run index-tracked -- --payers                    # только плательщики комиссий (Parsed Events, ≈10 кредитов на кошелёк)
//
// Повторный запуск продолжает с места остановки: уже загруженные кошельки пропускаются (если моложе --ttl-days,
// по умолчанию 365). Обновление догружает только переводы новее уже известных — это дёшево.

import { createEngine } from '../server/analyze.ts';
import { config } from '../server/config.ts';
import { createDb } from '../server/db.ts';
import { mapLimit, newCtx } from '../server/http.ts';
import { createDefaultProvider } from '../server/providers/index.ts';
import { loadTracked } from '../server/tracked.ts';

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'] as const;
}));
const recent = Number(args.get('recent') ?? 0);
const oldest = Number(args.get('oldest') ?? 100);
const concurrency = Number(args.get('concurrency') ?? 4);
const limit = Number(args.get('limit') ?? Number.POSITIVE_INFINITY);
const group = args.get('group');
const ttlDays = Number(args.get('ttl-days') ?? 365);
const payersOnly = args.has('payers');

if (!config.heliusKey && !args.has('force')) {
  console.error('Нужен ключ Helius (HELIUS_API_KEY в .env): на публичном RPC индексация тысяч кошельков займёт часы. Запуск без ключа: --force.');
  process.exit(1);
}

const db = createDb(config.dbFile);
const tracked = loadTracked(config.trackedFile);
db.syncTracked(tracked.wallets.map((w) => w.address));
const provider = createDefaultProvider();
const engine = createEngine({ db, provider, classify: async () => new Map(), tracked: () => tracked, recentTtlSec: ttlDays * 24 * 3600 });

let wallets = tracked.wallets;
if (group) wallets = wallets.filter((w) => w.groups.includes(group));
wallets = wallets.slice(0, limit);

const ctx = newCtx((m) => console.log(m));
let done = 0;
let failed = 0;
const startedAt = Date.now();
console.log(`Кошельков к индексации: ${wallets.length}. Источник: ${provider.name}.`);

await mapLimit(wallets, concurrency, async (w) => {
  try {
    if (payersOnly) await engine.loadPayers(w.address, ctx);
    else await engine.loadHistory(w.address, { recent, oldest }, ctx);
  } catch (e) {
    failed++;
    console.error(`  ошибка ${w.address} (${w.name}): ${e instanceof Error ? e.message : e}`);
  }
  done++;
  if (done % 25 === 0 || done === wallets.length) {
    const sec = Math.round((Date.now() - startedAt) / 1000);
    console.log(`  ${done}/${wallets.length} · ${sec} с · запросов ${ctx.meter.calls} · кредитов ≈ ${ctx.meter.credits}`);
  }
});

console.log(`Готово. Ошибок: ${failed}. Проиндексировано кошельков в кэше: ${db.indexedCount()}.`);
db.close();
