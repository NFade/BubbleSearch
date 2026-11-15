import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');

/** Условный mint нативного SOL (так его обозначает Helius). */
export const SOL_MINT = 'So11111111111111111111111111111111111111111';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';

const heliusKey = (process.env.HELIUS_API_KEY ?? '').trim();

export const config = {
  port: Number(process.env.PORT ?? 8787),
  heliusKey,
  /** RPC для стандартных методов (getMultipleAccounts и запасной провайдер). */
  rpcUrl: heliusKey
    ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`
    : (process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com').trim(),
  heliusRps: Number(process.env.HELIUS_RPS ?? 8),
  /** Публичный RPC: 40 запросов / 10 с на метод. */
  publicRps: Number(process.env.PUBLIC_RPS ?? 3),
  trackedFile: path.join(ROOT, 'data', 'axiom-wallets.json'),
  dbFile: path.join(ROOT, '.cache', 'bubblesearch.sqlite'),
  webDist: path.join(ROOT, 'web', 'dist'),
  /** Через сколько секунд свежая история считается устаревшей. */
  recentTtlSec: 30 * 60,
};

export function isBase58Address(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

export function shortAddr(a: string): string {
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}
