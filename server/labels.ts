// Статические метки известных адресов. Такие адреса — «хабы»: связь через них ничего не говорит
// о родстве кошельков, поэтому они не раскрываются как посредники.
//
// Адреса бирж взяты из общедоступных меток обозревателей и не перепроверены в этом проекте.
// Замер 15.11.2026: Coinbase 1 и MEXC — живые горячие кошельки; Binance 2/3, OKX, Kraken почти неактивны
// (возможно, устарели). Основная защита от бирж — распознавание по поведению (workspace.profile), этот список
// лишь дополняет его. При платном тарифе Helius адреса стоит сверить через Wallet API /batch-identity.

export type LabelCategory = 'program' | 'system' | 'jito' | 'fee' | 'cex' | 'burn';

export interface Label {
  name: string;
  category: LabelCategory;
}

const entries: Array<[string, string, LabelCategory]> = [
  // Системные адреса и программы
  ['11111111111111111111111111111111', 'System Program', 'system'],
  ['So11111111111111111111111111111111111111111', 'SOL', 'system'],
  ['So11111111111111111111111111111111111111112', 'Wrapped SOL', 'system'],
  ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'Token Program', 'program'],
  ['TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'Token-2022', 'program'],
  ['ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'Associated Token Program', 'program'],
  ['ComputeBudget111111111111111111111111111111', 'Compute Budget', 'program'],
  ['1nc1nerator11111111111111111111111111111111', 'Incinerator', 'burn'],
  // DEX и лаунчпады
  ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'Pump.fun', 'program'],
  ['CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM', 'Pump.fun Fee', 'fee'],
  ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', 'PumpSwap AMM', 'program'],
  ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', 'Raydium AMM v4', 'program'],
  ['5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', 'Raydium Authority v4', 'program'],
  ['CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', 'Raydium CPMM', 'program'],
  ['CAMMCzo5YL8w4VFF8KVHrK4AzzDPPpWSSwpUcgu6TpuA', 'Raydium CLMM', 'program'],
  ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', 'Jupiter v6', 'program'],
  ['LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', 'Meteora DLMM', 'program'],
  // Чаевые Jito
  ['96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', 'Jito Tip 1', 'jito'],
  ['HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe', 'Jito Tip 2', 'jito'],
  ['Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY', 'Jito Tip 3', 'jito'],
  ['ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49', 'Jito Tip 4', 'jito'],
  ['DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh', 'Jito Tip 5', 'jito'],
  ['ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt', 'Jito Tip 6', 'jito'],
  ['DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL', 'Jito Tip 7', 'jito'],
  ['3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT', 'Jito Tip 8', 'jito'],
  // Горячие кошельки бирж
  ['5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', 'Binance 2', 'cex'],
  ['9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'Binance 3', 'cex'],
  ['H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', 'Coinbase 1', 'cex'],
  ['2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm', 'Coinbase 2', 'cex'],
  ['AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2', 'Bybit', 'cex'],
  ['5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD', 'OKX', 'cex'],
  ['FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5', 'Kraken', 'cex'],
  ['BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6', 'KuCoin', 'cex'],
  ['ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ', 'MEXC', 'cex'],
  ['u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w', 'Gate.io', 'cex'],
];

export const LABELS: ReadonlyMap<string, Label> = new Map(entries.map(([address, name, category]) => [address, { name, category }]));

export function labelOf(address: string): Label | undefined {
  return LABELS.get(address);
}
