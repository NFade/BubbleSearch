import fs from 'node:fs';
import type { TrackedWallet } from '../shared/types.ts';
import { isBase58Address } from './config.ts';

export interface TrackedIndex {
  wallets: TrackedWallet[];
  byAddress: Map<string, TrackedWallet>;
  entityCount: number;
}

/** Слова-уточнения в конце имени, не меняющие владельца: «Gake Side», «Yugi Bundle», «Kev DEV», «cap farm». */
const SUFFIX = /\s+(side|dev|bundle|diddy|smurf|multi|farm|b)\s*\d*$/u;

/**
 * Ключ сущности: все кошельки одного человека должны получить один ключ.
 * «Cupsey», «Cupsey2», «cupsey», «Gake Side2», «MrBeast +» → cupsey, cupsey, cupsey, gake, mrbeast.
 */
export function entityKey(name: string): string {
  let s = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s+]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (;;) {
    const prev = s;
    s = s.replace(/\s*\+$/u, '').trim();
    s = s.replace(SUFFIX, '').trim();
    s = s.replace(/(?<=\p{L}{3})\s*\d{1,2}$/u, '').trim();
    if (s === prev) break;
  }
  return s;
}

export function buildTrackedIndex(raw: unknown): TrackedIndex {
  if (!Array.isArray(raw)) throw new Error('Ожидается JSON-массив из экспорта Axiom');
  const byAddress = new Map<string, TrackedWallet>();
  for (const item of raw) {
    const address = String(item?.trackedWalletAddress ?? item?.address ?? '').trim();
    if (!isBase58Address(address) || byAddress.has(address)) continue;
    const name = String(item?.name ?? '').trim() || address.slice(0, 6);
    const entity = entityKey(name) || `addr:${address}`;
    byAddress.set(address, {
      address,
      name,
      emoji: String(item?.emoji ?? '').trim(),
      entity,
      entityName: name,
      groups: Array.isArray(item?.groups) ? item.groups.map(String) : [],
    });
  }
  if (byAddress.size === 0) throw new Error('В файле не найдено ни одного адреса (поле trackedWalletAddress)');

  // Имя сущности — самое короткое из имён её кошельков («Gake», а не «Gake Side2»).
  const best = new Map<string, string>();
  for (const w of byAddress.values()) {
    const cur = best.get(w.entity);
    if (!cur || w.name.length < cur.length) best.set(w.entity, w.name);
  }
  for (const w of byAddress.values()) w.entityName = best.get(w.entity) ?? w.name;

  return { wallets: [...byAddress.values()], byAddress, entityCount: best.size };
}

export function loadTracked(file: string): TrackedIndex {
  if (!fs.existsSync(file)) return { wallets: [], byAddress: new Map(), entityCount: 0 };
  return buildTrackedIndex(JSON.parse(fs.readFileSync(file, 'utf8')));
}
