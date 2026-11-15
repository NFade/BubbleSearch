import type { AnalyzeResult, GraphNode, LinkResult } from '../../shared/types.ts';
import { asSingle, isGroup, isLink, SOL_MINT, TYPE_LABELS, type ViewData } from './util.ts';
import type { GroupResult } from '../../shared/types.ts';

type Cell = string | number | boolean | null | undefined;

/** Ячейка CSV: кавычки при необходимости; текст, начинающийся с = + - @, защищён от выполнения как формула. */
function cell(v: Cell): string {
  if (v == null) return '';
  if (typeof v === 'number') return String(v).replace('.', ',');
  if (typeof v === 'boolean') return v ? 'да' : 'нет';
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV с разделителем «;» и BOM в начале — так Excel верно открывает кириллицу. */
export function toCsv(rows: Cell[][]): string {
  return '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
export function stamp(d = new Date()): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function shortId(data: ViewData): string {
  const s = (a: string) => `${a.slice(0, 4)}-${a.slice(-4)}`;
  if (isGroup(data)) return `group-${data.addresses.length}`;
  return isLink(data) ? `${s(data.a)}_${s(data.b)}` : s(data.target);
}

export function exportFileName(data: ViewData, ext: string, suffix = ''): string {
  return `bubblesearch-${shortId(data)}-${stamp()}${suffix}.${ext}`;
}

/** Скачивание через Blob и временную ссылку. */
export function download(filename: string, mime: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const iso = (t: number | null) => (t == null ? '' : new Date(t * 1000).toISOString());

export function connectionsCsv(data: ViewData): string {
  if (isLink(data)) return linkPathsCsv(data);
  if (isGroup(data)) return groupLinksCsv(data);
  const r: AnalyzeResult = asSingle(data)!;
  const rows: Cell[][] = [['Сущность', 'Имя кошелька', 'Адрес', 'Сила, %', 'Шагов', 'Тип', 'Причина']];
  for (const c of r.connections) {
    for (const p of c.paths) {
      rows.push([c.wallet.entityName, c.wallet.name, c.wallet.address, Math.round(p.score * 100), p.edgeIds.length, TYPE_LABELS[p.type] ?? p.type, p.reason]);
    }
  }
  return toCsv(rows);
}

function groupLinksCsv(g: GroupResult): string {
  const name = (a: string) => g.nodes.find((n) => n.id === a)?.label ?? a;
  const cl = (a: string) => g.nodes.find((n) => n.id === a)?.cluster;
  const rows: Cell[][] = [['Кошелёк A', 'Адрес A', 'Кошелёк B', 'Адрес B', 'Кластер A', 'Кластер B', 'Тип', 'Сила, %', 'Причина']];
  for (const l of g.links) rows.push([name(l.a), l.a, name(l.b), l.b, cl(l.a) != null ? cl(l.a)! + 1 : '', cl(l.b) != null ? cl(l.b)! + 1 : '', TYPE_LABELS[l.type] ?? l.type, Math.round(l.score * 100), l.reason]);
  return toCsv(rows);
}

function linkPathsCsv(l: LinkResult): string {
  const label = (n?: GraphNode, addr = '') => (n && (n.kind === 'tracked' ? n.label : n.hubLabel)) || addr;
  const chain = (nodes: string[]) => nodes.map((a) => label(l.nodes.find((n) => n.id === a), a)).join(' > ');
  const rows: Cell[][] = [['№', 'Тип', 'Сила, %', 'Шагов', 'Цепочка (адреса)', 'Цепочка (имена)', 'Причина']];
  l.paths.forEach((p, i) => rows.push([i + 1, TYPE_LABELS[p.type] ?? p.type, Math.round(p.score * 100), p.edgeIds.length, p.nodes.join(' > '), chain(p.nodes), p.reason]));
  return toCsv(rows);
}

export function transfersCsv(data: ViewData): string {
  const rows: Cell[][] = [['Ребро', 'Время (ISO)', 'От', 'Кому', 'Токен', 'Сумма', 'Подпись транзакции', 'Совместная покупка']];
  for (const e of data.edges) {
    for (const t of e.transfers) {
      rows.push([e.id, iso(t.blockTime), t.from, t.to, t.symbol || (t.mint === SOL_MINT ? 'SOL' : t.mint), t.amount, t.signature, !!t.coBuy]);
    }
  }
  return toCsv(rows);
}

export function exportJson(data: ViewData): void {
  download(exportFileName(data, 'json'), 'application/json;charset=utf-8', JSON.stringify(data, null, 2));
}
export function exportConnections(data: ViewData): void {
  download(exportFileName(data, 'csv', '-links'), 'text/csv;charset=utf-8', connectionsCsv(data));
}
export function exportTransfers(data: ViewData): void {
  download(exportFileName(data, 'csv', '-transfers'), 'text/csv;charset=utf-8', transfersCsv(data));
}
