import { SOL_MINT, WSOL_MINT } from '../config.ts';
import type { Ctx } from '../http.ts';
import { HttpError, RateLimiter, RpcError, fetchJson, rpcCall } from '../http.ts';
import type { Transfer, TransferProvider } from './types.ts';
import { PlanError } from './types.ts';

// Оба провайдера сверены с живыми ответами Helius 15.11.2026 (поля, пагинация, нативный SOL):
// https://www.helius.dev/docs/rpc/gettransfersbyaddress
// https://www.helius.dev/docs/parsed-events/quickstart

const PAGE = 100;

function isPlanProblem(e: unknown): boolean {
  if (e instanceof HttpError) return e.status === 401 || e.status === 403 || e.status === 404;
  if (e instanceof RpcError) return e.code === -32601 || /plan|upgrade|not (available|supported|allowed)|method not found|forbidden/i.test(e.message);
  return false;
}

/**
 * getTransfersByAddress — тариф Developer и выше, 10 кредитов за 100 переводов.
 * Возвращает уже готовые переводы между владельцами, WSOL слит с SOL (solMode: merged).
 */
export function createHeliusTransfersProvider(apiKey: string, rps: number): TransferProvider {
  const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  const limiter = new RateLimiter(rps);

  /** Одна страница (100 строк, 10 кредитов): переводы между владельцами, время всех строк страницы и токен продолжения. */
  async function onePage(
    address: string,
    sortOrder: 'asc' | 'desc',
    ctx: Ctx,
    extra: { token?: string; with?: string; window?: [number, number] } = {},
  ): Promise<{ transfers: Transfer[]; slots: number[]; times: number[]; token: string | undefined }> {
    let result: any;
    try {
      result = await rpcCall(
        url,
        'getTransfersByAddress',
        [
          address,
          {
            limit: PAGE,
            sortOrder,
            solMode: 'merged',
            ...(extra.with ? { with: extra.with } : {}),
            ...(extra.window ? { filters: { blockTime: { gte: extra.window[0], lte: extra.window[1] } } } : {}),
            ...(extra.token ? { paginationToken: extra.token } : {}),
          },
        ],
        { limiter, ctx, credits: 10 },
      );
    } catch (e) {
      if (isPlanProblem(e) && !extra.window) throw new PlanError(String((e as Error).message));
      throw e;
    }
    const rows: any[] = result?.data ?? [];
    const transfers: Transfer[] = [];
    const slots: number[] = [];
    const times: number[] = [];
    for (const r of rows) {
      slots.push(Number(r.slot ?? 0));
      if (r.blockTime != null) times.push(Number(r.blockTime));
      if (r.type !== 'transfer' || !r.fromUserAccount || !r.toUserAccount || r.fromUserAccount === r.toUserAccount) continue;
      const decimals = Number(r.decimals ?? 0);
      transfers.push({
        signature: r.signature,
        slot: Number(r.slot ?? 0),
        blockTime: r.blockTime ?? null,
        from: r.fromUserAccount,
        to: r.toUserAccount,
        mint: r.mint === WSOL_MINT ? SOL_MINT : r.mint,
        amountRaw: String(r.amount ?? '0'),
        decimals,
        uiAmount: Number(r.uiAmount ?? Number(r.amount ?? 0) / 10 ** decimals),
      });
    }
    const token = rows.length > 0 ? (result?.paginationToken ?? undefined) : undefined;
    return { transfers, slots, times, token };
  }

  async function pages(address: string, sortOrder: 'asc' | 'desc', limit: number, ctx: Ctx, extra: { untilSlot?: number; with?: string } = {}) {
    const transfers: Transfer[] = [];
    let token: string | undefined;
    let complete = false;
    let reachedKnown = false;
    while (transfers.length < limit) {
      const p = await onePage(address, sortOrder, ctx, { token, with: extra.with });
      if (extra.untilSlot != null && p.slots.some((s) => s < extra.untilSlot!)) reachedKnown = true;
      transfers.push(...p.transfers);
      token = p.token;
      if (!token) {
        complete = true;
        break;
      }
      if (reachedKnown) break;
    }
    return { transfers, complete, reachedKnown };
  }

  /** Поддерживает ли метод фильтр по времени: null — ещё не проверяли. */
  let windowFilter: boolean | null = null;

  return {
    name: 'helius-transfers',
    note: 'Helius getTransfersByAddress: полная история переводов SOL и токенов.',
    fetchRecent: (address, limit, ctx, opts) => pages(address, 'desc', limit, ctx, { untilSlot: opts?.untilSlot }),
    fetchOldest: async (address, limit, ctx) => (await pages(address, 'asc', limit, ctx)).transfers,
    // Фильтр with: только переводы между двумя адресами, за всю историю.
    fetchBetween: async (a, b, limit, ctx) => (await pages(a, 'desc', limit, ctx, { with: b })).transfers.filter((t) => (t.from === a && t.to === b) || (t.from === b && t.to === a)),
    fetchWindow: (address, fromTime, toTime, maxPages, ctx) =>
      readWindow(
        (order, token, filtered) => onePage(address, order, ctx, { token, window: filtered ? [fromTime, toTime] : undefined }),
        fromTime,
        toTime,
        maxPages,
        { get: () => windowFilter, set: (v) => void (windowFilter = v) },
      ),
  };
}

type WindowPage = { transfers: Transfer[]; times: number[]; token: string | undefined };

/**
 * Читает переводы адреса за [from, to] постранично. Сначала пробует фильтр по времени (если Helius его понимает —
 * читаются только нужные страницы). Без фильтра: первая страница с конца истории и, если окно дальше, первая с начала;
 * дальше идёт с той стороны, откуда до окна меньше страниц (оценка по плотности переводов на пробных страницах).
 * Экспортируется для тестов.
 */
export async function readWindow(
  page: (order: 'asc' | 'desc', token: string | undefined, filtered: boolean) => Promise<WindowPage>,
  from: number,
  to: number,
  maxPages: number,
  filter: { get: () => boolean | null; set: (v: boolean) => void },
): Promise<{ transfers: Transfer[]; complete: boolean; pages: number }> {
  const out = new Map<string, Transfer>();
  let pages = 0;
  const keep = (list: Transfer[]) => {
    for (const t of list) {
      if (t.blockTime == null || t.blockTime < from || t.blockTime > to) continue;
      out.set(`${t.signature}:${t.from}:${t.to}:${t.mint}:${t.amountRaw}`, t);
    }
  };
  const done = (complete: boolean) => ({ transfers: [...out.values()].sort((a, b) => a.slot - b.slot), complete, pages });
  const min = (xs: number[]) => (xs.length ? Math.min(...xs) : null);
  const max = (xs: number[]) => (xs.length ? Math.max(...xs) : null);

  let ascFirst: WindowPage | null = null;
  if (filter.get() !== false) {
    let p: WindowPage | null = null;
    try {
      p = await page('asc', undefined, true);
      pages++;
    } catch (e) {
      if (!(e instanceof RpcError || e instanceof HttpError)) throw e;
      filter.set(false);
    }
    if (p) {
      const inside = p.times.every((t) => t >= from && t <= to);
      if (p.times.length > 0 && inside) {
        filter.set(true);
        keep(p.transfers);
        let token = p.token;
        while (token && pages < maxPages) {
          const q = await page('asc', token, true);
          pages++;
          keep(q.transfers);
          token = q.token;
        }
        return done(!token);
      }
      if (p.times.length === 0) {
        if (filter.get() === true) return done(true);
        // Пустой ответ ничего не доказывает: фильтр может быть не поддержан, а история — пустой. Проверяем без фильтра.
      } else {
        filter.set(false);
        ascFirst = p; // фильтр проигнорирован — это обычная первая страница с начала истории
      }
    }
  }

  const walk = async (order: 'asc' | 'desc', first: WindowPage): Promise<boolean> => {
    let token = first.token;
    let edge = order === 'asc' ? max(first.times) : min(first.times);
    const passed = () => edge != null && (order === 'asc' ? edge > to : edge < from);
    while (token && !passed() && pages < maxPages) {
      const q = await page(order, token, false);
      pages++;
      keep(q.transfers);
      token = q.token;
      const e = order === 'asc' ? max(q.times) : min(q.times);
      if (e != null) edge = e;
    }
    return passed() || !token;
  };

  const desc = await page('desc', undefined, false);
  pages++;
  keep(desc.transfers);
  const oldestD = min(desc.times);
  if (!desc.token) return done(true);
  if (oldestD == null || oldestD <= to) return done(await walk('desc', desc));

  const asc = ascFirst ?? (await page('asc', undefined, false));
  if (!ascFirst) pages++;
  keep(asc.transfers);
  const newestA = max(asc.times);
  const oldestA = min(asc.times);
  if (!asc.token) return done(true);
  if (newestA == null || newestA >= from) return done(await walk('asc', asc));

  // Окно в середине истории: идём с той стороны, откуда до него меньше страниц.
  const spanA = Math.max(1, newestA - (oldestA ?? newestA));
  const spanD = Math.max(1, (max(desc.times) ?? oldestD) - oldestD);
  const pagesFromStart = (to - newestA) / spanA;
  const pagesFromEnd = (oldestD - from) / spanD;
  return done(pagesFromStart <= pagesFromEnd ? await walk('asc', asc) : await walk('desc', desc));
}

/**
 * Токен-аккаунты транзакции Parsed Events: owners — с известным владельцем, unknown — владелец не указан
 * (initialize_account_3, sync_native), такие стороны перевода нельзя отнести к кошельку.
 */
export function tokenAccountsOf(p: any): { owners: Map<string, string>; unknown: Set<string> } {
  const owners = new Map<string, string>();
  const unknown = new Set<string>();
  for (const t of p.tokenTransfers ?? []) {
    if (t.fromTokenAccount && t.fromUserAccount) owners.set(t.fromTokenAccount, t.fromUserAccount);
    if (t.toTokenAccount && t.toUserAccount) owners.set(t.toTokenAccount, t.toUserAccount);
  }
  for (const ins of p.instructions ?? []) {
    if (!/token/.test(String(ins.programName ?? ''))) continue;
    const acc = new Map<string, string>((ins.decoded?.accounts ?? []).map((a: any) => [a.name, a.pubkey]));
    const name = String(ins.instructionName ?? '');
    if (name === 'close_account' && acc.get('account') && acc.get('owner')) owners.set(acc.get('account')!, acc.get('owner')!);
    else if (name.startsWith('create') && acc.get('associated_token_account') && acc.get('wallet_owner')) {
      owners.set(acc.get('associated_token_account')!, acc.get('wallet_owner')!);
    } else if ((name.startsWith('initialize_account') || name === 'sync_native') && acc.get('account')) unknown.add(acc.get('account')!);
  }
  for (const a of owners.keys()) unknown.delete(a);
  return { owners, unknown };
}

/**
 * Parsed Events transaction-history — доступен на всех тарифах, 10 кредитов за 100 транзакций.
 * Отдаёт разобранные транзакции; переводы берём из nativeTransfers и tokenTransfers.
 */
export function createHeliusParsedProvider(apiKey: string, rps: number): TransferProvider {
  const url = `https://mainnet.helius-rpc.com/v1/parsed-events/transaction-history?api-key=${apiKey}`;
  const limiter = new RateLimiter(rps);

  function rawAmount(v: any): string {
    if (v == null) return '0';
    if (typeof v === 'object') return String(v.tokenAmount ?? v.amount ?? '0');
    return String(v);
  }

  async function pages(address: string, sortOrder: 'asc' | 'desc', limit: number, ctx: Ctx) {
    const transfers: Transfer[] = [];
    let paginationToken: string | undefined;
    let complete = false;
    while (transfers.length < limit) {
      const body = { address, limit: PAGE, sortOrder, tokenAccounts: 'balanceChanged', ...(paginationToken ? { paginationToken } : {}) };
      let json: any;
      try {
        json = await fetchJson(
          url,
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
          { limiter, ctx, credits: 10 },
        );
      } catch (e) {
        if (isPlanProblem(e)) throw new PlanError(String((e as Error).message));
        throw e;
      }
      const items: any[] = json?.data ?? [];
      for (const item of items) {
        const p = item?.parsed;
        if (!p || p.transactionStatus === 'ERROR') continue;
        const base = { signature: item.signature ?? p.signature, slot: Number(p.slot ?? 0), blockTime: p.blockTime ?? null };
        // nativeTransfers содержат и движения лампортов через токен-аккаунты: рента при создании ATA, обёртка
        // в WSOL, возврат ренты при закрытии. Относим их к владельцу аккаунта, а переводы самому себе отбрасываем.
        const { owners, unknown } = tokenAccountsOf(p);
        const resolve = (a: string) => owners.get(a) ?? a;
        for (const n of p.nativeTransfers ?? []) {
          if (!n.fromUserAccount || !n.toUserAccount) continue;
          const from = resolve(n.fromUserAccount);
          const to = resolve(n.toUserAccount);
          if (from === to || unknown.has(from) || unknown.has(to)) continue;
          const raw = rawAmount(n.amount);
          transfers.push({ ...base, from, to, mint: SOL_MINT, amountRaw: raw, decimals: 9, uiAmount: Number(raw) / 1e9 });
        }
        for (const t of p.tokenTransfers ?? []) {
          if (!t.fromUserAccount || !t.toUserAccount || t.fromUserAccount === t.toUserAccount || !t.mint) continue;
          const raw = rawAmount(t.rawTokenAmount ?? t.tokenAmount);
          const wsol = t.mint === WSOL_MINT;
          const decimals = wsol ? 9 : Number(t.decimals ?? t.rawTokenAmount?.decimals ?? 0);
          transfers.push({ ...base, from: t.fromUserAccount, to: t.toUserAccount, mint: wsol ? SOL_MINT : t.mint, amountRaw: raw, decimals, uiAmount: Number(raw) / 10 ** decimals });
        }
      }
      paginationToken = json?.paginationToken ?? undefined;
      if (!paginationToken || items.length === 0) {
        complete = true;
        break;
      }
    }
    const own = transfers.filter((t) => t.from === address || t.to === address);
    return { transfers: own, complete };
  }

  return {
    name: 'helius-parsed',
    note: 'Helius Parsed Events (доступен на бесплатном тарифе): история транзакций с разобранными переводами.',
    fetchRecent: (address, limit, ctx) => pages(address, 'desc', limit, ctx),
    fetchOldest: async (address, limit, ctx) => (await pages(address, 'asc', limit, ctx)).transfers,
  };
}

/**
 * Плательщики комиссий по Parsed Events transaction-history (10 кредитов за 100 транзакций, есть на бесплатном тарифе).
 * Если транзакцию кошелька оплатил другой адрес (fee payer), этот адрес обычно управляет кошельком.
 */
export function createFeePayerFetcher(apiKey: string, rps: number) {
  const url = `https://mainnet.helius-rpc.com/v1/parsed-events/transaction-history?api-key=${apiKey}`;
  const limiter = new RateLimiter(rps);
  return async (address: string, limit: number, ctx: Ctx): Promise<{ payers: Map<string, number>; txCount: number }> => {
    const payers = new Map<string, number>();
    let txCount = 0;
    let paginationToken: string | undefined;
    while (txCount < limit) {
      const body = { address, limit: Math.min(PAGE, limit - txCount), sortOrder: 'desc', ...(paginationToken ? { paginationToken } : {}) };
      const json: any = await fetchJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, { limiter, ctx, credits: 10 });
      const items: any[] = json?.data ?? [];
      for (const it of items) {
        txCount++;
        const p = it?.parsed?.feePayer;
        if (typeof p === 'string' && p !== address) payers.set(p, (payers.get(p) ?? 0) + 1);
      }
      paginationToken = json?.paginationToken ?? undefined;
      if (!paginationToken || items.length === 0) break;
    }
    return { payers, txCount };
  };
}
