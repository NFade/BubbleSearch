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

  async function pages(address: string, sortOrder: 'asc' | 'desc', limit: number, ctx: Ctx, extra: { untilSlot?: number; with?: string } = {}) {
    const transfers: Transfer[] = [];
    let paginationToken: string | undefined;
    let complete = false;
    let reachedKnown = false;
    while (transfers.length < limit) {
      let result: any;
      try {
        result = await rpcCall(
          url,
          'getTransfersByAddress',
          [address, { limit: PAGE, sortOrder, solMode: 'merged', ...(extra.with ? { with: extra.with } : {}), ...(paginationToken ? { paginationToken } : {}) }],
          { limiter, ctx, credits: 10 },
        );
      } catch (e) {
        if (isPlanProblem(e)) throw new PlanError(String((e as Error).message));
        throw e;
      }
      const rows: any[] = result?.data ?? [];
      for (const r of rows) {
        if (extra.untilSlot != null && Number(r.slot ?? 0) < extra.untilSlot) reachedKnown = true;
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
      paginationToken = result?.paginationToken ?? undefined;
      if (!paginationToken || rows.length === 0) {
        complete = true;
        break;
      }
      if (reachedKnown) break;
    }
    return { transfers, complete, reachedKnown };
  }

  return {
    name: 'helius-transfers',
    note: 'Helius getTransfersByAddress: полная история переводов SOL и токенов.',
    fetchRecent: (address, limit, ctx, opts) => pages(address, 'desc', limit, ctx, { untilSlot: opts?.untilSlot }),
    fetchOldest: async (address, limit, ctx) => (await pages(address, 'asc', limit, ctx)).transfers,
    // Фильтр with: только переводы между двумя адресами, за всю историю.
    fetchBetween: async (a, b, limit, ctx) => (await pages(a, 'desc', limit, ctx, { with: b })).transfers.filter((t) => (t.from === a && t.to === b) || (t.from === b && t.to === a)),
  };
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
