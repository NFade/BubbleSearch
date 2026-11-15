import { SYSTEM_PROGRAM } from './config.ts';
import type { AccountKind, Db } from './db.ts';
import type { Ctx } from './http.ts';
import { RateLimiter, RpcError, rpcCall } from './http.ts';

/** Метка некорректного адреса в ответе классификатора. */
const INVALID = Symbol('invalid');

export type Classifier = (addresses: string[], ctx: Ctx) => Promise<Map<string, AccountKind>>;

/**
 * Отличает обычные кошельки от аккаунтов программ (пулы, бондинг-кривые, хранилища).
 * Кошелёк — аккаунт, которым владеет System Program, аккаунт без данных у любой программы либо пустой (несуществующий) адрес:
 * одноразовые кошельки после вывода средств выглядят именно так.
 */
export function createClassifier(db: Db, rpcUrl: string, rps: number): Classifier {
  const limiter = new RateLimiter(rps);
  return async (addresses, ctx) => {
    const unique = [...new Set(addresses)];
    const known = db.getAccounts(unique);
    const missing = unique.filter((a) => !known.has(a));
    const fresh: Array<[string, AccountKind]> = [];
    // Пачка с некорректным адресом (строка вида base58, но не 32 байта) отклоняется целиком: делим её пополам,
    // пока не найдём виновника, и помечаем его как не-кошелёк, чтобы один адрес не ронял анализ.
    const fetchPart = async (part: string[]): Promise<Array<any | undefined> | null> => {
      try {
        const result = await rpcCall(rpcUrl, 'getMultipleAccounts', [part, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }], { limiter, ctx, credits: 1 });
        return result?.value ?? [];
      } catch (e) {
        if (!(e instanceof RpcError) || e.code !== -32602) throw e;
        if (part.length === 1) return null;
        const mid = Math.ceil(part.length / 2);
        const [x, y] = await Promise.all([fetchPart(part.slice(0, mid)), fetchPart(part.slice(mid))]);
        return [...(x ?? part.slice(0, mid).map(() => INVALID)), ...(y ?? part.slice(mid).map(() => INVALID))];
      }
    };
    for (let i = 0; i < missing.length; i += 100) {
      const part = missing.slice(i, i + 100);
      const values = (await fetchPart(part)) ?? part.map(() => INVALID);
      part.forEach((address, j) => {
        const acc = values[j];
        if (acc === INVALID) {
          fresh.push([address, 'program']);
          known.set(address, 'program');
          return;
        }
        // Аккаунт без данных у чужой программы — тоже кошелёк: владельца сменили через assign (так бывает
        // после взлома или у «кошельков-ловушек»), но средства и связи остаются человеческими.
        const noData = acc && typeof acc.space === 'number' && acc.space === 0;
        const kind: AccountKind = !acc || (!acc.executable && (acc.owner === SYSTEM_PROGRAM || noData)) ? 'wallet' : 'program';
        fresh.push([address, kind]);
        known.set(address, kind);
      });
    }
    db.setAccounts(fresh);
    return known;
  };
}
