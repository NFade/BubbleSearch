import type { WalletRow, WalletsResponse } from '../shared/types.ts';
import type { Db } from './db.ts';
import type { Ctx } from './http.ts';
import { RateLimiter, rpcCall } from './http.ts';
import type { TrackedIndex } from './tracked.ts';

const BALANCE_TTL_MS = 5 * 60_000;
const ACTIVITY_TTL_MS = 2 * 60_000;
const LAMPORTS = 1e9;

export type RpcFn = (method: string, params: unknown, ctx: Ctx) => Promise<any>;

interface Deps {
  db: Db;
  tracked: () => TrackedIndex;
  rpcUrl: string;
  rps: number;
  /** Подмена RPC для тестов. */
  rpc?: RpcFn;
}

/** Сервис вкладки «Кошельки»: список с балансами и активностью из кэша, точное обновление строки. */
export function createWalletsService(deps: Deps) {
  const { db } = deps;
  const limiter = new RateLimiter(deps.rps);
  const rpc: RpcFn = deps.rpc ?? ((method, params, ctx) => rpcCall(deps.rpcUrl, method, params, { limiter, ctx, credits: 1 }));

  const balances = new Map<string, number>();
  let balancesAt: number | null = null;
  /** Точная последняя активность, полученная через refresh: перекрывает данные кэша. */
  const exactLast = new Map<string, number>();

  async function loadBalances(addresses: string[], ctx: Ctx): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (let i = 0; i < addresses.length; i += 100) {
      const part = addresses.slice(i, i + 100);
      try {
        const res = await rpc('getMultipleAccounts', [part, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }], ctx);
        const values: any[] = res?.value ?? [];
        part.forEach((a, j) => {
          const acc = values[j];
          // Несуществующий аккаунт — баланс 0.
          out.set(a, acc ? Number(acc.lamports ?? 0) / LAMPORTS : 0);
        });
      } catch (e) {
        ctx.log(`Баланс: пачка ${i / 100 + 1} не загружена (${e instanceof Error ? e.message : e})`);
      }
    }
    return out;
  }

  // Агрегат по переводам на большом кэше (1,4 млн строк) стоит секунды, а node:sqlite синхронный: считаем его
  // небольшими порциями в фоне, уступая циклу событий между ними, и держим результат в памяти ACTIVITY_TTL_MS.
  type Activity = ReturnType<Db['activityOf']>;
  let activity: Activity | null = null;
  let activityAt = 0;
  let activityJob: Promise<void> | null = null;
  const SLICE = 10;
  function ensureActivity(): Promise<void> {
    if (activityJob) return activityJob;
    if (activity && Date.now() - activityAt < ACTIVITY_TTL_MS) return Promise.resolve();
    const addrs = deps.tracked().wallets.map((w) => w.address);
    activityJob = (async () => {
      const data: Activity = new Map();
      for (let i = 0; i < addrs.length; i += SLICE) {
        for (const [k, v] of db.activityOf(addrs.slice(i, i + SLICE))) data.set(k, v);
        await new Promise((r) => setImmediate(r));
      }
      activity = data;
      activityAt = Date.now();
    })()
      .catch(() => {})
      .finally(() => {
        activityJob = null;
      });
    return activityJob;
  }
  // Прогрев при создании сервиса: первый запрос списка не должен ждать агрегат.
  setTimeout(() => void ensureActivity(), 0).unref?.();

  let balanceJob: Promise<void> | null = null;
  function ensureBalances(ctx: Ctx): Promise<void> {
    if (balanceJob) return balanceJob;
    if (balancesAt !== null && Date.now() - balancesAt < BALANCE_TTL_MS) return Promise.resolve();
    const addrs = deps.tracked().wallets.map((w) => w.address);
    if (addrs.length === 0) return Promise.resolve();
    balanceJob = loadBalances(addrs, ctx)
      .then((fresh) => {
        for (const [a, v] of fresh) balances.set(a, v);
        // Если ни одна пачка не загрузилась — время не отмечаем, чтобы повторить при следующем запросе.
        if (fresh.size > 0) balancesAt = Date.now();
      })
      .catch(() => {})
      .finally(() => {
        balanceJob = null;
      });
    return balanceJob;
  }

  function buildRows(wallets: TrackedIndex['wallets'], single = false): WalletRow[] {
    const addrs = wallets.map((w) => w.address);
    const act0 = activity;
    const states = db.fetchStatesOf(addrs);
    return wallets.map((w) => {
      const act = act0?.get(w.address) ?? (single ? db.activityOf([w.address]).get(w.address) : undefined);
      const st = states.get(w.address) ?? {};
      const recent = st.recent;
      const history = !!(recent || st.oldest);
      const earlyKnown = !!(st.oldest?.complete || recent?.complete);
      const last = Math.max(act?.last ?? 0, exactLast.get(w.address) ?? 0) || null;
      return {
        ...w,
        balanceSol: balances.get(w.address) ?? null,
        lastActive: last,
        firstSeen: earlyKnown ? (act?.first ?? null) : null,
        indexed: { history, payers: !!st.payers, fetchedAt: recent?.fetchedAt ?? null },
      };
    });
  }

  return {
    /**
     * Список отдаётся сразу, из того, что уже посчитано. Балансы и активность догружаются в фоне;
     * пока что-то из этого не готово, balancesAt = null (клиент повторяет запрос через несколько секунд).
     * wait: true — дождаться фоновой загрузки (для тестов и скриптов).
     */
    async list(ctx: Ctx, opts: { wait?: boolean } = {}): Promise<WalletsResponse> {
      const jobs = [ensureBalances(ctx), ensureActivity()];
      if (opts.wait) await Promise.all(jobs);
      const wallets = deps.tracked().wallets;
      return { wallets: buildRows(wallets), balancesAt: activity ? balancesAt : null };
    },

    async refresh(address: string, ctx: Ctx): Promise<WalletRow> {
      const w = deps.tracked().byAddress.get(address);
      if (!w) throw new Error('Кошелёк не из списка отслеживания');
      const sigs = await rpc('getSignaturesForAddress', [address, { limit: 1 }], ctx);
      const bt = sigs?.[0]?.blockTime;
      if (typeof bt === 'number') exactLast.set(address, bt);
      const bal = await loadBalances([address], ctx);
      if (bal.has(address)) balances.set(address, bal.get(address)!);
      return buildRows([w], true)[0];
    },
  };
}
