import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type {
  AnalyzeRequest,
  AnalyzeStartResponse,
  ImportResponse,
  JobResponse,
  GroupRequest,
  LinkRequest,
  WalletRefreshRequest,
  StatusResponse,
  TrackedResponse,
} from '../shared/types.ts';
import { createClassifier } from './accounts.ts';
import { createEngine } from './analyze.ts';
import { config, isBase58Address } from './config.ts';
import { createDb } from './db.ts';
import type { Ctx } from './http.ts';
import { newCtx } from './http.ts';
import { GROUP_MAX, createGroupFinder } from './group.ts';
import { createLinkFinder } from './link.ts';
import { createWalletsService } from './wallets.ts';
import { createDefaultProvider } from './providers/index.ts';
import { buildTrackedIndex, loadTracked } from './tracked.ts';

const db = createDb(config.dbFile);
const provider = createDefaultProvider();
let tracked = loadTracked(config.trackedFile);
db.syncTracked(tracked.wallets.map((w) => w.address));
const classify = createClassifier(db, config.rpcUrl, config.heliusKey ? config.heliusRps : config.publicRps);
const engine = createEngine({ db, provider, classify, tracked: () => tracked, recentTtlSec: config.recentTtlSec });
const grouper = createGroupFinder({ db, provider, classify, tracked: () => tracked, loadHistory: engine.loadHistory, loadPayers: engine.loadPayers });
const walletsService = createWalletsService({ db, tracked: () => tracked, rpcUrl: config.rpcUrl, rps: config.heliusKey ? config.heliusRps : config.publicRps });
const linker = createLinkFinder({ db, provider, classify, tracked: () => tracked, loadHistory: engine.loadHistory, loadPayers: engine.loadPayers });

const jobs = new Map<string, JobResponse & { createdAt: number }>();
const JOB_TTL_MS = 30 * 60_000;
const MAX_BODY = 8 * 1024 * 1024;

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ApiError(413, 'Слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new ApiError(400, 'Некорректный JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function startJob(kind: JobResponse['kind'], run: (ctx: Ctx) => Promise<Pick<JobResponse, 'result' | 'link' | 'group'>>): string {
  const now = Date.now();
  for (const [id, j] of jobs) if (now - j.createdAt > JOB_TTL_MS) jobs.delete(id);
  const id = crypto.randomUUID();
  const job: JobResponse & { createdAt: number } = { id, kind, status: 'running', progress: [], createdAt: now };
  jobs.set(id, job);
  const ctx = newCtx((msg) => job.progress.push(msg));
  run(ctx)
    .then((out) => {
      Object.assign(job, out);
      job.status = 'done';
    })
    .catch((e: unknown) => {
      console.error(`[${kind}]`, e);
      job.error = e instanceof Error ? e.message : String(e);
      job.status = 'error';
    });
  return id;
}

async function api(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
  const method = req.method ?? 'GET';

  if (method === 'GET' && pathname === '/api/status') {
    const body: StatusResponse = {
      provider: provider.name,
      providerNote: provider.note,
      hasHeliusKey: !!config.heliusKey,
      trackedCount: tracked.wallets.length,
      entityCount: tracked.entityCount,
      indexedCount: db.indexedCount(),
    };
    return send(res, 200, body);
  }

  if (method === 'GET' && pathname === '/api/tracked') {
    const body: TrackedResponse = { wallets: tracked.wallets };
    return send(res, 200, body);
  }

  if (method === 'POST' && pathname === '/api/tracked/import') {
    const raw = await readBody(req);
    let next;
    try {
      next = buildTrackedIndex(raw);
    } catch (e) {
      throw new ApiError(400, e instanceof Error ? e.message : String(e));
    }
    fs.mkdirSync(path.dirname(config.trackedFile), { recursive: true });
    fs.writeFileSync(config.trackedFile, JSON.stringify(raw, null, 1));
    tracked = next;
    db.syncTracked(tracked.wallets.map((w) => w.address));
    const body: ImportResponse = { imported: tracked.wallets.length, entityCount: tracked.entityCount };
    return send(res, 200, body);
  }

  if (method === 'POST' && pathname === '/api/analyze') {
    const body = (await readBody(req)) as AnalyzeRequest;
    const address = String(body?.address ?? '').trim();
    if (!isBase58Address(address)) throw new ApiError(400, 'Некорректный адрес кошелька Solana');
    const request: AnalyzeRequest = { ...body, address };
    const out: AnalyzeStartResponse = { jobId: startJob('analyze', async (ctx) => ({ result: await engine.analyze(address, request, ctx) })) };
    return send(res, 200, out);
  }

  if (method === 'GET' && pathname === '/api/wallets') {
    return send(res, 200, await walletsService.list(newCtx()));
  }

  if (method === 'POST' && pathname === '/api/wallets/refresh') {
    const body = (await readBody(req)) as WalletRefreshRequest;
    const address = String(body?.address ?? '').trim();
    if (!isBase58Address(address)) throw new ApiError(400, 'Некорректный адрес кошелька Solana');
    return send(res, 200, await walletsService.refresh(address, newCtx()));
  }

  if (method === 'POST' && pathname === '/api/group') {
    const body = (await readBody(req)) as GroupRequest;
    const addresses = [...new Set((Array.isArray(body?.addresses) ? body.addresses : []).map((a) => String(a).trim()))];
    if (addresses.length < 2) throw new ApiError(400, 'Выберите хотя бы два кошелька');
    if (addresses.length > GROUP_MAX) throw new ApiError(400, `Можно выбрать не больше ${GROUP_MAX} кошельков`);
    if (!addresses.every(isBase58Address)) throw new ApiError(400, 'Некорректный адрес кошелька Solana');
    const out: AnalyzeStartResponse = { jobId: startJob('group', async (ctx) => ({ group: await grouper.group(addresses, body, ctx) })) };
    return send(res, 200, out);
  }

  if (method === 'POST' && pathname === '/api/link') {
    const body = (await readBody(req)) as LinkRequest;
    const a = String(body?.a ?? '').trim();
    const b = String(body?.b ?? '').trim();
    if (!isBase58Address(a) || !isBase58Address(b)) throw new ApiError(400, 'Некорректный адрес кошелька Solana');
    if (a === b) throw new ApiError(400, 'Укажите два разных кошелька');
    const out: AnalyzeStartResponse = { jobId: startJob('link', async (ctx) => ({ link: await linker.link(a, b, body, ctx) })) };
    return send(res, 200, out);
  }

  const jobMatch = method === 'GET' ? /^\/api\/jobs\/([0-9a-f-]{36})$/.exec(pathname) : null;
  if (jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) throw new ApiError(404, 'Задача не найдена (возможно, сервер был перезапущен)');
    const { createdAt: _createdAt, ...body } = job;
    return send(res, 200, body);
  }

  throw new ApiError(404, 'Неизвестный адрес API');
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Отдаёт собранный интерфейс (web/dist), если он есть. В режиме разработки интерфейс обслуживает Vite. */
function serveStatic(res: http.ServerResponse, pathname: string): void {
  const rel = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\]|\.\.[/\\])+/, '');
  let file = path.join(config.webDist, rel);
  if (!file.startsWith(config.webDist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(config.webDist, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Интерфейс не собран. Запустите «npm run dev» или «npm run build».');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (!pathname.startsWith('/api/')) return serveStatic(res, pathname);
  api(req, res, pathname).catch((e: unknown) => {
    if (e instanceof ApiError) return send(res, e.status, { error: e.message });
    console.error('[api]', e);
    send(res, 500, { error: e instanceof Error ? e.message : 'Внутренняя ошибка' });
  });
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`BubbleSearch API: http://localhost:${config.port}`);
  console.log(`Источник данных: ${provider.name}. Кошельков в списке: ${tracked.wallets.length} (имён: ${tracked.entityCount}).`);
  if (!config.heliusKey) console.log('Ключ Helius не задан (HELIUS_API_KEY в .env) — используется публичный RPC.');
});
