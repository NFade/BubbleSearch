import { config } from '../config.ts';
import { createFeePayerFetcher, createHeliusParsedProvider, createHeliusTransfersProvider } from './helius.ts';
import { createRpcProvider } from './rpc.ts';
import type { TransferProvider } from './types.ts';
import { PlanError } from './types.ts';

/**
 * Выбор источника данных:
 * 1) есть ключ Helius → getTransfersByAddress; если тариф его не даёт — Parsed Events (есть на бесплатном);
 * 2) нет ключа → стандартный RPC (медленно и неглубоко).
 */
export function createDefaultProvider(): TransferProvider {
  if (!config.heliusKey) return createRpcProvider(config.rpcUrl, config.publicRps);

  const enhancedRps = Number(process.env.HELIUS_ENHANCED_RPS ?? 2);
  let active: TransferProvider = createHeliusTransfersProvider(config.heliusKey, config.heliusRps);
  let fellBack = false;
  const feePayers = createFeePayerFetcher(config.heliusKey, enhancedRps);

  async function withFallback<T>(run: (p: TransferProvider) => Promise<T>, log: (m: string) => void): Promise<T> {
    try {
      return await run(active);
    } catch (e) {
      if (!(e instanceof PlanError) || fellBack) throw e;
      fellBack = true;
      active = createHeliusParsedProvider(config.heliusKey, enhancedRps);
      log('Метод getTransfersByAddress недоступен на этом тарифе Helius, переключаюсь на Parsed Events.');
      return run(active);
    }
  }

  return {
    get name() {
      return active.name;
    },
    get note() {
      return active.note;
    },
    get hints() {
      return active.hints;
    },
    fetchRecent: (address, limit, ctx, opts) => withFallback((p) => p.fetchRecent(address, limit, ctx, opts), ctx.log),
    fetchFeePayers: (address, limit, ctx) => feePayers(address, limit, ctx),
    fetchBetween: async (a, b, limit, ctx) => (active.fetchBetween ? active.fetchBetween(a, b, limit, ctx) : []),
    fetchOldest: (address, limit, ctx) => withFallback((p) => p.fetchOldest(address, limit, ctx), ctx.log),
  };
}
