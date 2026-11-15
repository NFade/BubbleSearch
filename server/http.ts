// Сетевой слой: ограничение частоты, повторы, учёт вызовов.

export interface Meter {
  calls: number;
  credits: number;
}

export interface Ctx {
  meter: Meter;
  log: (msg: string) => void;
}

export function newCtx(log: (msg: string) => void = () => {}): Ctx {
  return { meter: { calls: 0, credits: 0 }, log };
}

/** Равномерно распределяет запросы: не более rps в секунду. */
export class RateLimiter {
  private next = 0;
  private readonly interval: number;
  constructor(rps: number) {
    this.interval = 1000 / Math.max(0.1, rps);
  }
  async wait(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.interval;
    if (at > now) await sleep(at - now);
  }
  /** После 429: отодвинуть все следующие запросы. */
  penalize(ms: number): void {
    this.next = Math.max(this.next, Date.now() + ms);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class HttpError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

export class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(`RPC ${code}: ${message}`);
    this.code = code;
  }
}

interface FetchOpts {
  limiter: RateLimiter;
  ctx: Ctx;
  credits?: number;
  retries?: number;
}

/** POST/GET JSON с повторами на 429 и 5xx. Ошибки 4xx (кроме 429) не повторяются. */
export async function fetchJson(url: string, init: RequestInit, opts: FetchOpts): Promise<any> {
  const retries = opts.retries ?? 6;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await opts.limiter.wait();
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(45_000) });
      opts.ctx.meter.calls++;
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        const backoff = Math.max(retryAfter * 1000, 600 * 2 ** attempt);
        opts.limiter.penalize(backoff);
        lastErr = new HttpError(res.status, await res.text().catch(() => ''));
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new HttpError(res.status, text);
      opts.ctx.meter.credits += opts.credits ?? 0;
      return text ? JSON.parse(text) : null;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      lastErr = e; // сеть / таймаут — повторяем
      await sleep(400 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

let rpcId = 0;

export async function rpcCall(url: string, method: string, params: unknown, opts: FetchOpts): Promise<any> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params });
  const json = await fetchJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }, opts);
  if (json?.error) throw new RpcError(Number(json.error.code ?? 0), String(json.error.message ?? 'unknown'));
  return json?.result;
}

/** Параллельная обработка с ограничением числа одновременных задач; порядок результатов сохраняется. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}
