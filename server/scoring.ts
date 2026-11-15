// Оценка рёбер и путей. Пороги и формулы — здесь; обоснование — в PLAN.md, раздел «Алгоритм».

import type { Transfer } from './providers/types.ts';
import { SOL_MINT, USDC_MINT, USDT_MINT, shortAddr } from './config.ts';

/** Кошелёк с таким числом разных значимых контрагентов считается сервисом (биржа, раздатчик), а не посредником. */
export const HUB_DEGREE = 150;
/** Посредник, связанный с таким числом разных имён из списка, считается общим сервисом (комиссии терминала и т. п.). */
export const HUB_ENTITIES = 8;
/**
 * «Сборщик»: столько разных кошельков присылают ему SOL, а сам он почти никому не платит (не больше
 * COLLECTOR_MAX_OUT_SHARE от числа отправителей, минимум 2 — на вывод на биржу или основной кошелёк).
 * Так выглядят кошельки комиссий ботов и терминалов, а также сборные кошельки бирж.
 */
export const COLLECTOR_SENDERS = 20;
export const COLLECTOR_MAX_OUT_SHARE = 0.05;
/**
 * Биржа или сервис по поведению (замер 15.11.2026 на 600 последних переводах: Coinbase — 227 получателей SOL
 * за 1.4 ч, MEXC — 104 отправителя и 92 получателя за 1.1 ч; трейдеры — до 6 и 5). Личный раздатчик
 * (одна цель, 40+ своих кошельков, 1 источник) сервисом не считается: нужен и поток входящих.
 */
export const SERVICE_RECIPIENTS = 100;
export const SERVICE_RECIPIENTS_WITH_SENDERS = 40;
export const SERVICE_SENDERS = 10;
/** Очень частые переводы: от 300 строк в выборке и 1000+ в час при 20+ разных кошельках-контрагентах. */
export const VELOCITY_ROWS = 300;
export const VELOCITY_PER_HOUR = 1000;
export const VELOCITY_PARTIES = 20;
/**
 * Совместные покупки: одни и те же токены в одном слоте разными транзакциями. Замер 15.11.2026 на кэше индекса:
 * от 3 разных токенов совпадения дают только кошельки одного владельца (Yugi — 23 токена с «Yugi Bundle»),
 * 1–2 токена — случайность (снайперы одного запуска).
 */
export const COBUY_MIN_MINTS = 3;
/**
 * Снайпинг: если совместные покупки связывают кошелёк больше чем с таким числом разных имён из списка, это не бандл,
 * а охота за запусками вместе со всеми (калибровка 15.11.2026: у снайперов — 13–22 имени, у бандла Yugi — одно).
 */
export const COBUY_MAX_ENTITIES = 3;
/** 3 токена → 0.48, 5 → 0.6, 9+ → 0.85. */
export function coBuyScore(mints: number): number {
  return mints < COBUY_MIN_MINTS ? 0 : Math.min(0.85, 0.3 + 0.06 * mints);
}
/**
 * Плательщик комиссий: кошелёк оплатил комиссии хотя бы за FEE_PAYER_MIN_TX транзакций другого (замер 15.11.2026: у Yugi
 * 43 из 100 транзакций оплачены его же кошельками). Ретрансляторы терминалов (Axiom) платят за всех — их отсеивает
 * profile (сборщик) и правило FEE_PAYER_MAX_ENTITIES.
 */
export const FEE_PAYER_MIN_TX = 2;
export const FEE_PAYER_MAX_ENTITIES = 2;
export const FEE_PAYER_SCORE = 0.85;
/** Общий плательщик комиссий у двух кошельков. */
export const COMMON_FEE_PAYER_SCORE = 0.75;
/**
 * Раздача наград держателям токена: раунды выплат — в одном слоте REWARD_BATCH_MIN+ получателей; раундов от 2;
 * получатели — кошельки REWARD_MIN_ENTITIES+ разных имён из списка или повторяются из раунда в раунд (3+ раунда,
 * половина получателей — в нескольких). Личный раздатчик, пополняющий свои бандл-кошельки пачкой, обычно делает
 * это раз и кошелькам одного имени. Пример 15.11.2026: 8yXF…YUbk — lspfi, jacksn, Felix Diddy, PFORK+ в одну секунду.
 */
export const REWARD_BATCH_MIN = 5;
export const REWARD_MIN_ENTITIES = 3;
/** Ослабление связи за каждый дополнительный шаг. */
export const HOP_DECAY = 0.85;

export interface EdgeMetrics {
  /** SOL a → b и b → a. */
  solAB: number;
  solBA: number;
  /** Значимые переводы: SOL не меньше порога или стейблкоин от 1. */
  sigAB: number;
  sigBA: number;
  /** Переводы прочих токенов a → b и b → a. */
  tokAB: number;
  tokBA: number;
  count: number;
  first: number | null;
  last: number | null;
}

export const isStable = (mint: string) => mint === USDC_MINT || mint === USDT_MINT;
export const symbolOf = (mint: string) =>
  mint === SOL_MINT ? 'SOL' : mint === USDC_MINT ? 'USDC' : mint === USDT_MINT ? 'USDT' : shortAddr(mint);
export const edgeIdOf = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** «3 токена», «21 токен», «5 токенов». */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${w}`;
}
export const tokensText = (n: number) => plural(n, 'токен', 'токена', 'токенов');
export const slotsText = (n: number) => plural(n, 'слот', 'слота', 'слотов');
export const txText = (n: number) => plural(n, 'транзакцию', 'транзакции', 'транзакций');

export function fmtSol(v: number): string {
  if (v >= 100) return v.toFixed(0);
  if (v >= 1) return v.toFixed(2);
  if (v >= 0.01) return v.toFixed(3);
  return v.toPrecision(2);
}

export function edgeMetrics(e: { a: string; transfers: Iterable<Transfer> }, minSol: number): EdgeMetrics {
  const m: EdgeMetrics = { solAB: 0, solBA: 0, sigAB: 0, sigBA: 0, tokAB: 0, tokBA: 0, count: 0, first: null, last: null };
  for (const t of e.transfers) {
    const ab = t.from === e.a;
    m.count++;
    if (t.mint === SOL_MINT) {
      if (ab) m.solAB += t.uiAmount;
      else m.solBA += t.uiAmount;
      if (t.uiAmount >= minSol) ab ? m.sigAB++ : m.sigBA++;
    } else if (isStable(t.mint)) {
      if (t.uiAmount >= 1) ab ? m.sigAB++ : m.sigBA++;
      else ab ? m.tokAB++ : m.tokBA++;
    } else {
      ab ? m.tokAB++ : m.tokBA++;
    }
    if (t.blockTime != null) {
      if (m.first == null || t.blockTime < m.first) m.first = t.blockTime;
      if (m.last == null || t.blockTime > m.last) m.last = t.blockTime;
    }
  }
  return m;
}

/**
 * Сила ребра 0..1.
 * Объём насыщается около 5–10 SOL, число переводов — около 10; встречные переводы добавляют уверенности.
 * Только пыль → 0.05. Только переводы токенов → 0.35–0.6. Первое пополнение кошелька → не ниже 0.85.
 */
export function edgeStrength(m: EdgeMetrics, isFunding: boolean): number {
  const sig = m.sigAB + m.sigBA;
  const tok = m.tokAB + m.tokBA;
  let s: number;
  if (sig === 0 && tok === 0) s = 0.05;
  else {
    const cnt = 1 - Math.exp(-(sig + tok) / 4);
    if (sig === 0) s = 0.35 + 0.25 * cnt;
    else {
      const vol = 1 - Math.exp(-(m.solAB + m.solBA) / 2);
      s = 0.25 + 0.5 * vol + 0.15 * cnt + (m.sigAB > 0 && m.sigBA > 0 ? 0.1 : 0);
    }
  }
  if (isFunding && sig > 0) s = Math.max(s, 0.85);
  return Math.min(1, s);
}

/** Штраф посреднику за широту связей: до 3 контрагентов — без штрафа, 13 → 0.59, 53 → 0.36. */
export function degreePenalty(degree: number): number {
  return 1 / (1 + Math.log(1 + Math.max(0, degree - 3) / 10));
}

/** Несколько независимых путей усиливают друг друга: 1 − Π(1 − s). */
export function combineScores(scores: number[]): number {
  let miss = 1;
  for (const s of scores) miss *= 1 - clamp(s, 0, 1);
  return 1 - miss;
}
