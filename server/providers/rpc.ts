import type { Ctx } from '../http.ts';
import { RateLimiter, mapLimit, rpcCall } from '../http.ts';
import { parseRawTransaction } from './parse-raw-tx.ts';
import type { Transfer, TransferProvider } from './types.ts';

interface SigInfo {
  signature: string;
  err: unknown;
}

interface SigList {
  at: number;
  sigs: SigInfo[];
  /** Дошли до самой первой транзакции кошелька. */
  complete: boolean;
}

export interface RpcProviderOptions {
  /** Сколько последних транзакций разбирать (каждая — отдельный запрос). */
  maxRecentTx?: number;
  /** Сколько самых ранних транзакций разбирать при поиске источника средств. */
  oldestTx?: number;
  /** Сколько страниц подписей (по 1000) листать в поисках начала истории. */
  maxSigPages?: number;
}

/**
 * Запасной провайдер на стандартном RPC: getSignaturesForAddress + getTransaction на каждую транзакцию.
 * Работает с любым RPC без ключа, но медленно. Входящие переводы токенов, которые затрагивают только
 * токен-аккаунт получателя, этим способом не видны.
 */
export function createRpcProvider(rpcUrl: string, rps: number, options: RpcProviderOptions = {}): TransferProvider {
  const maxRecentTx = options.maxRecentTx ?? 150;
  const oldestTx = options.oldestTx ?? 25;
  const maxSigPages = options.maxSigPages ?? 20;
  const limiter = new RateLimiter(rps);
  const sigCache = new Map<string, SigList>();

  async function listSignatures(address: string, want: number, ctx: Ctx): Promise<SigList> {
    const cached = sigCache.get(address);
    if (cached && Date.now() - cached.at < 10 * 60_000 && (cached.complete || cached.sigs.length >= want)) return cached;
    const sigs: SigInfo[] = [];
    let before: string | undefined;
    let complete = false;
    for (let page = 0; page < maxSigPages; page++) {
      const batch: any[] = await rpcCall(rpcUrl, 'getSignaturesForAddress', [address, { limit: 1000, before }], { limiter, ctx });
      for (const s of batch) sigs.push({ signature: s.signature, err: s.err });
      if (batch.length < 1000) {
        complete = true;
        break;
      }
      before = batch[batch.length - 1].signature;
      if (sigs.length >= want) break;
    }
    const list = { at: Date.now(), sigs, complete };
    sigCache.set(address, list);
    return list;
  }

  async function loadTransfers(address: string, signatures: string[], ctx: Ctx): Promise<Transfer[]> {
    const parsed = await mapLimit(signatures, 3, async (signature) => {
      const tx = await rpcCall(
        rpcUrl,
        'getTransaction',
        [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'finalized' }],
        { limiter, ctx },
      );
      return parseRawTransaction(tx);
    });
    return parsed.flat().filter((t) => t.from === address || t.to === address);
  }

  return {
    name: 'rpc',
    hints: { intermediaryRecent: 40, maxIntermediaries: 5 },
    note:
      'Стандартный RPC без ключа Helius: разбираются только последние ' +
      `${maxRecentTx} транзакций кошелька, входящие переводы токенов могут быть не видны. Для полноценной работы нужен ключ Helius.`,

    async fetchRecent(address, limit, ctx) {
      const cap = Math.min(maxRecentTx, limit);
      const list = await listSignatures(address, cap, ctx);
      const ok = list.sigs.filter((s) => !s.err);
      const transfers = await loadTransfers(address, ok.slice(0, cap).map((s) => s.signature), ctx);
      return { transfers, complete: list.complete && ok.length <= cap };
    },

    async fetchOldest(address, _limit, ctx) {
      const list = await listSignatures(address, Number.POSITIVE_INFINITY, ctx);
      if (!list.complete) return null;
      const ok = list.sigs.filter((s) => !s.err);
      const transfers = await loadTransfers(address, ok.slice(-oldestTx).map((s) => s.signature), ctx);
      return transfers.sort((a, b) => a.slot - b.slot);
    },
  };
}
