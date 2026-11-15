import type { Ctx } from '../http.ts';

/** Один перевод между владельцами кошельков (не токен-аккаунтами). */
export interface Transfer {
  signature: string;
  slot: number;
  blockTime: number | null;
  from: string;
  to: string;
  /** SOL_MINT для нативного SOL и WSOL. */
  mint: string;
  amountRaw: string;
  decimals: number;
  uiAmount: number;
  /** Первичный ключ в кэше; есть у строк, прочитанных из базы. */
  key?: string;
}

export interface TransferProvider {
  name: string;
  /** Пояснение для интерфейса: что умеет и чем ограничен. */
  note: string;
  /** Пределы для медленных источников; без них движок берёт свои значения по умолчанию. */
  hints?: { intermediaryRecent?: number; maxIntermediaries?: number };
  /**
   * Последние переводы, новые сверху. complete — история исчерпана, старше ничего нет.
   * untilSlot — догрузка: остановиться, дойдя до переводов старше этого слота (они уже в кэше); reachedKnown — дошли.
   */
  fetchRecent(
    address: string,
    limit: number,
    ctx: Ctx,
    opts?: { untilSlot?: number },
  ): Promise<{ transfers: Transfer[]; complete: boolean; reachedKnown?: boolean }>;
  /**
   * Кто оплачивал комиссии за последние limit транзакций кошелька (fee payer ≠ сам кошелёк): плательщик → число транзакций.
   * null — источник этого не умеет.
   */
  fetchFeePayers?(address: string, limit: number, ctx: Ctx): Promise<{ payers: Map<string, number>; txCount: number } | null>;
  /** Все переводы между двумя кошельками за всю историю (если источник умеет фильтр по паре). */
  fetchBetween?(a: string, b: string, limit: number, ctx: Ctx): Promise<Transfer[]>;
  /** Самые ранние переводы кошелька. null — провайдер не смог добраться до начала истории. */
  fetchOldest(address: string, limit: number, ctx: Ctx): Promise<Transfer[] | null>;
}

/** Метод недоступен на текущем тарифе — нужен другой провайдер. */
export class PlanError extends Error {}
