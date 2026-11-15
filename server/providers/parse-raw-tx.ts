import { SOL_MINT, WSOL_MINT } from '../config.ts';
import type { Transfer } from './types.ts';

interface TokenAccountInfo {
  owner: string;
  mint: string;
  decimals: number;
}

/**
 * Достаёт переводы из ответа getTransaction (encoding: jsonParsed).
 * Берутся явные инструкции перевода (внешние и внутренние): system transfer/createAccount и spl-token transfer*.
 * Токен-аккаунты заменяются владельцами, WSOL считается SOL — так же, как у Helius getTransfersByAddress (solMode: merged).
 */
export function parseRawTransaction(tx: any): Transfer[] {
  if (!tx || !tx.meta || tx.meta.err) return [];
  const message = tx.transaction?.message;
  const signature: string | undefined = tx.transaction?.signatures?.[0];
  if (!message || !signature) return [];

  const keys: string[] = (message.accountKeys ?? []).map((k: any) => (typeof k === 'string' ? k : k.pubkey));
  if (typeof message.accountKeys?.[0] === 'string' && tx.meta.loadedAddresses) {
    keys.push(...(tx.meta.loadedAddresses.writable ?? []), ...(tx.meta.loadedAddresses.readonly ?? []));
  }

  const tokenAccounts = new Map<string, TokenAccountInfo>();
  for (const b of [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])]) {
    const account = keys[b.accountIndex];
    if (account && b.owner && b.mint) {
      tokenAccounts.set(account, { owner: b.owner, mint: b.mint, decimals: Number(b.uiTokenAmount?.decimals ?? 0) });
    }
  }

  const instructions: any[] = [...(message.instructions ?? [])];
  for (const inner of tx.meta.innerInstructions ?? []) instructions.push(...(inner.instructions ?? []));

  const out: Transfer[] = [];
  const push = (from: string | undefined, to: string | undefined, mint: string, raw: string, decimals: number) => {
    if (!from || !to || from === to) return;
    let amount: bigint;
    try {
      amount = BigInt(raw);
    } catch {
      return;
    }
    if (amount <= 0n) return;
    if (mint === WSOL_MINT) {
      mint = SOL_MINT;
      decimals = 9;
    }
    out.push({
      signature,
      slot: Number(tx.slot ?? 0),
      blockTime: tx.blockTime ?? null,
      from,
      to,
      mint,
      amountRaw: amount.toString(),
      decimals,
      uiAmount: Number(amount) / 10 ** decimals,
    });
  };
  /** Лампорты, отправленные на токен-аккаунт (обёртка в WSOL, рента ATA), относим к его владельцу. */
  const ownerOf = (account: string | undefined) => (account ? (tokenAccounts.get(account)?.owner ?? account) : undefined);

  for (const ins of instructions) {
    const parsed = ins?.parsed;
    if (!parsed || typeof parsed !== 'object' || !parsed.info) continue;
    const { type, info } = parsed;

    if (ins.program === 'system') {
      if (type === 'transfer' || type === 'transferWithSeed') {
        push(ownerOf(info.source), ownerOf(info.destination), SOL_MINT, String(info.lamports ?? 0), 9);
      } else if (type === 'createAccount' || type === 'createAccountWithSeed') {
        push(ownerOf(info.source), ownerOf(info.newAccount), SOL_MINT, String(info.lamports ?? 0), 9);
      }
    } else if (ins.program === 'spl-token') {
      if (type !== 'transfer' && type !== 'transferChecked' && type !== 'transferCheckedWithFee') continue;
      const src = tokenAccounts.get(info.source);
      const dst = tokenAccounts.get(info.destination);
      const mint: string | undefined = info.mint ?? src?.mint ?? dst?.mint;
      if (!mint) continue;
      const raw = String(info.tokenAmount?.amount ?? info.amount ?? 0);
      const decimals = Number(info.tokenAmount?.decimals ?? src?.decimals ?? dst?.decimals ?? 0);
      push(src?.owner ?? info.authority, dst?.owner, mint, raw, decimals);
    }
  }
  return out;
}
