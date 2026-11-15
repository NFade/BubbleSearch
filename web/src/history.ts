import type { AnalyzeResult, LinkResult } from '../../shared/types.ts';
import { isMock } from './api.ts';
import { shortAddr, specKey, type SearchSpec } from './util.ts';

/** Запись истории поисков (одиночных и парных). */
export interface HistoryEntry {
  key: string;
  spec: SearchSpec;
  /** Имя из списка, если цель есть в списке, иначе сокращённый адрес. */
  label: string;
  /** Unix-миллисекунды. */
  time: number;
  /** Главный результат: «Yugi · 100%», «связь 89%», «связей нет». */
  top: string;
}

export const HISTORY_LIMIT = 30;
// В демо-режиме история хранится отдельно, чтобы не смешиваться с настоящей.
const KEY = isMock ? 'bubblesearch.history.v1.mock' : 'bubblesearch.history.v1';

function valid(e: unknown): e is HistoryEntry {
  if (!e || typeof e !== 'object') return false;
  const x = e as HistoryEntry;
  return typeof x.key === 'string' && typeof x.label === 'string' && typeof x.time === 'number' && !!x.spec && (x.spec.mode === 'single' || x.spec.mode === 'pair');
}

export function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter(valid).slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

function save(list: HistoryEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* хранилище недоступно или переполнено — история просто не сохраняется */
  }
}

/** Добавляет запись наверх (повтор того же поиска переносится вверх); возвращает новый список. */
export function addHistory(entry: HistoryEntry): HistoryEntry[] {
  const list = [entry, ...loadHistory().filter((e) => e.key !== entry.key)].slice(0, HISTORY_LIMIT);
  save(list);
  return list;
}

export function clearHistory(): HistoryEntry[] {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  return [];
}

export function entryForSingle(spec: Extract<SearchSpec, { mode: 'single' }>, result: AnalyzeResult, hint?: string): HistoryEntry {
  const ent = result.entities[0];
  return {
    key: specKey(spec),
    spec,
    label: result.targetTracked?.name ?? hint ?? shortAddr(result.target),
    time: Date.now(),
    top: ent ? `${ent.entityName} · ${Math.round(ent.score * 100)}%` : 'связей нет',
  };
}

export function entryForPair(spec: Extract<SearchSpec, { mode: 'pair' }>, link: LinkResult): HistoryEntry {
  return {
    key: specKey(spec),
    spec,
    label: `${link.aTracked?.name ?? shortAddr(link.a)} ⇄ ${link.bTracked?.name ?? shortAddr(link.b)}`,
    time: Date.now(),
    top: link.paths.length > 0 ? `связь ${Math.round(link.score * 100)}%` : 'связи нет',
  };
}

export function modeText(spec: SearchSpec): string {
  return spec.mode === 'single' ? `Один кошелёк · глубина ${spec.depth}` : `Два кошелька · до ${spec.hops} шагов`;
}

export function fmtHistoryTime(t: number): string {
  return new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
