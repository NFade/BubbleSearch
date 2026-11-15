import type {
  AnalyzeRequest,
  AnalyzeResult,
  AnalyzeStartResponse,
  GroupRequest,
  GroupResult,
  ImportResponse,
  JobResponse,
  LinkRequest,
  LinkResult,
  StatusResponse,
  TrackedResponse,
  TrackedWallet,
  WalletRow,
  WalletsResponse,
} from '../../shared/types.ts';
import { buildMockGroup, mockRefresh, mockWallets, MOCK_GROUP_DEEP_PROGRESS, MOCK_GROUP_PROGRESS } from './mockWallets.ts';
import { buildMockLink, buildMockResult, mockTracked, MOCK_LINK_PROGRESS, MOCK_PROGRESS, MOCK_STATUS } from './mock.ts';

export const isMock: boolean = (() => {
  try {
    return new URLSearchParams(window.location.search).get('mock') === '1';
  } catch {
    return false;
  }
})();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error('Сервер недоступен. Проверьте, что бэкенд запущен на порту 8787.');
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not json */
  }
  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

export async function getStatus(): Promise<StatusResponse> {
  if (isMock) {
    await sleep(150);
    return MOCK_STATUS;
  }
  return http<StatusResponse>('/api/status');
}

let trackedCache: Promise<TrackedWallet[]> | null = null;
/** Список отслеживаемых кошельков для подсказок: загружается один раз и кэшируется; после импорта сбрасывается. */
export function getTracked(): Promise<TrackedWallet[]> {
  if (!trackedCache) {
    const p: Promise<TrackedWallet[]> = isMock
      ? Promise.resolve(mockTracked())
      : http<TrackedResponse>('/api/tracked').then((r) => r.wallets ?? []);
    trackedCache = p.catch((e) => {
      trackedCache = null;
      throw e;
    });
  }
  return trackedCache;
}

export async function importTracked(json: string): Promise<ImportResponse> {
  if (isMock) {
    await sleep(300);
    const parsed: unknown = JSON.parse(json);
    const n = Array.isArray(parsed) ? parsed.length : 0;
    return { imported: n, entityCount: Math.max(1, Math.round(n * 0.4)) };
  }
  trackedCache = null;
  return http<ImportResponse>('/api/tracked/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: json,
  });
}

export interface JobHandle<T> {
  promise: Promise<T>;
  cancel: () => void;
}
export type AnalyzeHandle = JobHandle<AnalyzeResult>;
export type LinkHandle = JobHandle<LinkResult>;

/** Общий цикл: запуск задачи, опрос /api/jobs/:id, отмена. */
function runJob<T>(
  startPath: string,
  body: unknown,
  pick: (job: JobResponse) => T | undefined,
  mock: () => Promise<T>,
  onProgress: (lines: string[]) => void,
): JobHandle<T> {
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
  };
  const run = async (): Promise<T> => {
    if (isMock) {
      const r = await mock();
      if (cancelled) throw new Error('cancelled');
      return r;
    }
    const start = await http<AnalyzeStartResponse>(startPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let failures = 0;
    for (;;) {
      if (cancelled) throw new Error('cancelled');
      await sleep(800);
      if (cancelled) throw new Error('cancelled');
      let job: JobResponse;
      try {
        job = await http<JobResponse>(`/api/jobs/${encodeURIComponent(start.jobId)}`);
        failures = 0;
      } catch (e) {
        if (++failures >= 4) throw e;
        continue;
      }
      onProgress(job.progress);
      if (job.status === 'error') throw new Error(job.error || 'Неизвестная ошибка анализа');
      if (job.status === 'done') {
        const r = pick(job);
        if (!r) throw new Error('Сервер вернул пустой результат');
        return r;
      }
    }
  };
  return { promise: run(), cancel };
}

/** Имитация хода работы в демо-режиме. */
function mockProgress(lines: string[], onProgress: (l: string[]) => void, isCancelled: () => boolean) {
  return async () => {
    const out: string[] = [];
    for (const l of lines) {
      await sleep(380);
      if (isCancelled()) throw new Error('cancelled');
      out.push(l);
      onProgress([...out]);
    }
    await sleep(350);
  };
}

export function analyze(req: AnalyzeRequest, onProgress: (lines: string[]) => void): AnalyzeHandle {
  const flag = { c: false };
  const h = runJob<AnalyzeResult>(
    '/api/analyze',
    req,
    (job) => (job.result ? { ...job.result, siblings: job.result.siblings ?? [] } : undefined),
    async () => {
      await mockProgress(MOCK_PROGRESS, onProgress, () => flag.c)();
      return buildMockResult(req.address, req.depth ?? 2);
    },
    onProgress,
  );
  return { promise: h.promise, cancel: () => ((flag.c = true), h.cancel()) };
}

export function link(req: LinkRequest, onProgress: (lines: string[]) => void): LinkHandle {
  const flag = { c: false };
  const h = runJob<LinkResult>(
    '/api/link',
    req,
    (job) => job.link,
    async () => {
      await mockProgress(MOCK_LINK_PROGRESS, onProgress, () => flag.c)();
      return buildMockLink(req.a, req.b, req.maxHops ?? 3);
    },
    onProgress,
  );
  return { promise: h.promise, cancel: () => ((flag.c = true), h.cancel()) };
}

export type GroupHandle = JobHandle<GroupResult>;

export function group(req: GroupRequest, onProgress: (lines: string[]) => void): GroupHandle {
  const flag = { c: false };
  const h = runJob<GroupResult>(
    '/api/group',
    req,
    (job) => job.group,
    async () => {
      await mockProgress(req.deep ? MOCK_GROUP_DEEP_PROGRESS : MOCK_GROUP_PROGRESS, onProgress, () => flag.c)();
      return buildMockGroup(req.addresses, !!req.deep);
    },
    onProgress,
  );
  return { promise: h.promise, cancel: () => ((flag.c = true), h.cancel()) };
}

/** Все кошельки списка с балансами и активностью. Пока сервер догружает балансы, balancesAt = null. */
export async function getWallets(): Promise<WalletsResponse> {
  if (isMock) {
    await sleep(250);
    return mockWallets();
  }
  return http<WalletsResponse>('/api/wallets');
}

/** Точная последняя активность и баланс одного кошелька. */
export async function refreshWallet(address: string): Promise<WalletRow> {
  if (isMock) {
    await sleep(500);
    return mockRefresh(address);
  }
  return http<WalletRow>('/api/wallets/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address }),
  });
}
