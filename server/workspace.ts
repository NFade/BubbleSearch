// Рабочий граф одного анализа: загруженные переводы, рёбра, типы аккаунтов, распознанные сервисы.
// Общий для поиска связей кошелька (analyze.ts) и режима «Два кошелька» (link.ts).

import type { GraphEdge, GraphNode, HubCategory, NodeKind, TransferRecord } from '../shared/types.ts';
import type { Classifier } from './accounts.ts';
import { SOL_MINT, shortAddr } from './config.ts';
import type { AccountKind, CoBuy, Db } from './db.ts';
import type { Ctx } from './http.ts';
import { labelOf } from './labels.ts';
import type { Transfer } from './providers/types.ts';
import {
  COLLECTOR_MAX_OUT_SHARE,
  COLLECTOR_SENDERS,
  HUB_DEGREE,
  SERVICE_RECIPIENTS,
  SERVICE_RECIPIENTS_WITH_SENDERS,
  SERVICE_SENDERS,
  VELOCITY_PARTIES,
  VELOCITY_PER_HOUR,
  VELOCITY_ROWS,
  FEE_PAYER_MAX_ENTITIES,
  REWARD_BATCH_MIN,
  REWARD_MIN_ENTITIES,
  FEE_PAYER_SCORE,
  coBuyScore,
  edgeIdOf,
  edgeMetrics,
  edgeStrength,
  fmtSol,
  symbolOf,
} from './scoring.ts';
import type { TrackedIndex } from './tracked.ts';

export interface History {
  transfers: Transfer[];
  /** Свежая история загружена не до конца (упёрлись в лимит или не загружалась). */
  truncated: boolean;
  /** Известны самые ранние переводы кошелька, можно определять источник средств. */
  hasOldest: boolean;
}

export type LoadHistory = (address: string, want: { recent: number; oldest: number; refresh?: boolean }, ctx: Ctx) => Promise<History>;

export interface Hub {
  label: string;
  category: HubCategory;
}

/** Поведение кошелька по выборке последних переводов. */
export interface Profile {
  address: string;
  rows: number;
  spanHours: number | null;
  /** Выборка — вся история кошелька. */
  complete: boolean;
  /** Разные обычные кошельки, присылавшие / получавшие значимый SOL. */
  senders: number;
  recipients: number;
  /** Куда ушла наибольшая доля исходящего SOL (включая биржи и программы) и какая это доля. */
  topRecipient: string | null;
  topRecipientShare: number;
  outSol: number;
  /** Не null — адрес признан биржей, сервисом или инфраструктурой. */
  service: Hub | null;
}

/** Выборка для распознавания сервиса: 100 переводов = 10 кредитов. При признаках сервиса — 600. */
export const PROFILE_RECENT = 100;
export const PROFILE_DEEP = 600;
/** Депозитный адрес: не больше стольких отправителей и не меньше такой доли SOL уходит одному адресу биржи. */
const DEPOSIT_MAX_SENDERS = 10;
const DEPOSIT_MIN_SHARE = 0.8;
const DEPOSIT_MIN_OUT_SOL = 0.1;
const MAX_EDGE_TRANSFERS = 200;
/** Распознанные биржи и сервисы запоминаются в базе на 30 дней. */
const SERVICE_CACHE_SEC = 30 * 86400;

interface EdgeAcc {
  id: string;
  a: string;
  b: string;
  transfers: Map<string, Transfer>;
}

export interface WorkspaceDeps {
  db: Db;
  classify: Classifier;
  tracked: TrackedIndex;
  loadHistory: LoadHistory;
  minSol: number;
  refresh: boolean;
  ctx: Ctx;
  /** Анализируемые кошельки: связь «с самим собой» не считается, сервисом они не помечаются. */
  self: ReadonlySet<string>;
}

// Посредник на пути к списку важнее пометки «свой кошелёк»: он остаётся посредником на карте, а в списке
// вероятных своих кошельков всё равно есть.
const NODE_ORDER: NodeKind[] = ['other', 'funder', 'hub', 'sibling', 'intermediary', 'tracked', 'pair', 'target'];

export function createWorkspace(d: WorkspaceDeps) {
  const { db, classify, ctx, minSol } = d;
  const S = d.tracked.byAddress;
  const edges = new Map<string, EdgeAcc>();
  const adjacency = new Map<string, Set<string>>();
  /** edgeId → профинансированный кошелёк (ребро — его первое пополнение). */
  const fundingOf = new Map<string, string>();
  const kinds = new Map<string, AccountKind>();
  const degrees = new Map<string, number>();
  const hubs = new Map<string, Hub>();
  /** Депозитные адреса бирж: адрес → имя биржи или «биржа». */
  const deposits = new Map<string, string>();
  const infraTracked = new Set<string>();
  const fetched = new Set<string>();
  /** Рёбра «совместные покупки»: переводов между кошельками может не быть. */
  const coBuys = new Map<string, { a: string; b: string; mints: number; slots: number; records: Transfer[] }>();
  function addCoBuy(x: string, y: string, c: CoBuy): string {
    const id = edgeIdOf(x, y);
    const [a, b] = x < y ? [x, y] : [y, x];
    coBuys.set(id, { a, b, mints: c.mints.size, slots: c.slots.size, records: c.records });
    return id;
  }
  /** Рёбра «оплачивал комиссии»: payer платил за транзакции другого конца. */
  const feeEdges = new Map<string, { a: string; b: string; payer: string; txCount: number }>();
  function addFeesPaid(payer: string, paid: string, txCount: number): string {
    const id = edgeIdOf(payer, paid);
    const [a, b] = payer < paid ? [payer, paid] : [paid, payer];
    const cur = feeEdges.get(id);
    if (!cur || cur.txCount < txCount) feeEdges.set(id, { a, b, payer, txCount });
    return id;
  }
  const hasEdge = (id: string) => edges.has(id) || coBuys.has(id) || feeEdges.has(id);

  function addTransfers(list: Transfer[]): void {
    for (const t of list) {
      const id = edgeIdOf(t.from, t.to);
      let e = edges.get(id);
      if (!e) {
        const [a, b] = t.from < t.to ? [t.from, t.to] : [t.to, t.from];
        e = { id, a, b, transfers: new Map() };
        edges.set(id, e);
        (adjacency.get(a) ?? adjacency.set(a, new Set()).get(a)!).add(b);
        (adjacency.get(b) ?? adjacency.set(b, new Set()).get(b)!).add(a);
      }
      e.transfers.set(t.key ?? `${t.signature}:${t.from}:${t.to}:${t.mint}:${t.amountRaw}`, t);
    }
  }

  const neighbors = (x: string) => [...(adjacency.get(x) ?? [])];
  const metricsOf = (e: EdgeAcc) => edgeMetrics({ a: e.a, transfers: e.transfers.values() }, minSol);
  const metrics = (x: string, y: string) => {
    const e = edges.get(edgeIdOf(x, y));
    return e ? metricsOf(e) : edgeMetrics({ a: x < y ? x : y, transfers: [] }, minSol);
  };
  const strength = (x: string, y: string) => edgeStrength(metrics(x, y), fundingOf.has(edgeIdOf(x, y)));
  /** Значимые потоки x → y (out) и y → x (in). */
  const flows = (x: string, y: string) => {
    const m = metrics(x, y);
    const xIsA = x < y;
    return {
      out: xIsA ? m.sigAB : m.sigBA,
      in: xIsA ? m.sigBA : m.sigAB,
      tokOut: xIsA ? m.tokAB : m.tokBA,
      tokIn: xIsA ? m.tokBA : m.tokAB,
      solOut: xIsA ? m.solAB : m.solBA,
      solIn: xIsA ? m.solBA : m.solAB,
      m,
    };
  };
  /** Сумма значимого потока для пояснений: SOL или, если SOL нет, стейблкоины. */
  const amountText = (sol: number, sig: number) => (sol >= minSol ? `${fmtSol(sol)} SOL` : sig > 0 ? 'стейблкоины' : 'пыль');
  /** Есть ли между x и y что-то кроме пыли. */
  const significant = (x: string, y: string) => {
    const f = flows(x, y);
    return f.out + f.in + f.tokOut + f.tokIn > 0;
  };

  async function ensureKinds(addresses: string[]): Promise<void> {
    const missing = addresses.filter((a) => !kinds.has(a));
    if (missing.length === 0) return;
    for (const [a, k] of await classify(missing, ctx)) kinds.set(a, k);
  }
  const isPlainWallet = (a: string) => kinds.get(a) === 'wallet' && !labelOf(a);
  // Сервисы, распознанные в прошлых анализах (таблица services), тоже хабы — без новых запросов.
  const cacheChecked = new Set<string>();
  const isHub = (a: string) => {
    if (d.self.has(a)) return false;
    if (!hubs.has(a) && !cacheChecked.has(a)) {
      cacheChecked.add(a);
      const cached = db.getService(a, SERVICE_CACHE_SEC);
      if (cached) hubs.set(a, { label: cached.label, category: cached.category as HubCategory });
    }
    return hubs.has(a) || !!labelOf(a) || kinds.get(a) === 'program';
  };
  const markHub = (a: string, hub: Hub) => {
    if (!d.self.has(a) && !hubs.has(a)) hubs.set(a, hub);
  };
  /** Отслеживаемый адрес, который на деле инфраструктура (программа, сжигатель): связь с ним не показываем. */
  const usableTracked = (a: string) => {
    if (!S.has(a) || d.self.has(a)) return false;
    if (labelOf(a) || kinds.get(a) === 'program') {
      infraTracked.add(a);
      return false;
    }
    return true;
  };
  const nameOf = (a: string) => {
    const w = S.get(a);
    if (w) return `«${w.name}»`;
    const label = labelOf(a);
    return label && (label.category === 'cex' || label.category === 'fee') ? `«${label.name}»` : shortAddr(a);
  };

  // История кошелька: один запрос на адрес; если позже нужно больше — догружаем.
  const histMemo = new Map<string, { recent: number; oldest: number; p: Promise<History> }>();
  function hist(address: string, recent: number, oldest: number): Promise<History> {
    const m = histMemo.get(address);
    if (m && m.recent >= recent && m.oldest >= oldest) return m.p;
    const want = { recent: Math.max(recent, m?.recent ?? 0), oldest: Math.max(oldest, m?.oldest ?? 0) };
    fetched.add(address);
    const before = m ? m.p.catch(() => null) : Promise.resolve(null);
    const p = before
      .then(() => d.loadHistory(address, { ...want, refresh: d.refresh && !m }, ctx))
      .then((h) => {
        addTransfers(h.transfers);
        return h;
      });
    histMemo.set(address, { ...want, p });
    return p;
  }

  /** Первое значимое входящее пополнение SOL. */
  function findFunder(wallet: string, h: History): Transfer | null {
    if (!h.hasOldest) return null;
    let best: Transfer | null = null;
    for (const t of h.transfers) {
      if (t.to !== wallet || t.mint !== SOL_MINT || t.uiAmount < minSol) continue;
      if (!best || t.slot < best.slot) best = t;
    }
    return best;
  }

  async function computeProfile(x: string, sample: number): Promise<Profile> {
    const base: Profile = { address: x, rows: 0, spanHours: null, complete: false, senders: 0, recipients: 0, topRecipient: null, topRecipientShare: 0, outSol: 0, service: null };
    const label = labelOf(x);
    if (label) {
      const hub: Hub = { label: label.name, category: label.category };
      markHub(x, hub);
      return { ...base, service: hub };
    }
    const cached = db.getService(x, SERVICE_CACHE_SEC);
    if (cached) {
      const hub: Hub = { label: cached.label, category: cached.category as HubCategory };
      markHub(x, hub);
      return { ...base, service: hub };
    }
    await ensureKinds([x]);
    if (kinds.get(x) === 'program') {
      const hub: Hub = { label: 'Аккаунт программы', category: 'program' };
      markHub(x, hub);
      return { ...base, service: hub };
    }
    const h = await hist(x, sample, 0);
    const rows = h.transfers.slice(0, sample);
    const complete = !h.truncated && rows.length === h.transfers.length;
    let tmin = Infinity;
    let tmax = -Infinity;
    const snd = new Set<string>();
    const outVol = new Map<string, number>();
    for (const t of rows) {
      if (t.blockTime != null) {
        tmin = Math.min(tmin, t.blockTime);
        tmax = Math.max(tmax, t.blockTime);
      }
      if (t.mint !== SOL_MINT || t.uiAmount < minSol) continue;
      if (t.to === x && !labelOf(t.from)) snd.add(t.from);
      if (t.from === x) outVol.set(t.to, (outVol.get(t.to) ?? 0) + t.uiAmount);
    }
    await ensureKinds([...snd, ...outVol.keys()]);
    const senders = [...snd].filter((a) => kinds.get(a) === 'wallet').length;
    const recipients = [...outVol.keys()].filter((a) => kinds.get(a) === 'wallet' && !labelOf(a)).length;
    let outSol = 0;
    let topRecipient: string | null = null;
    let topVol = 0;
    for (const [a, v] of outVol) {
      outSol += v;
      if (v > topVol) {
        topVol = v;
        topRecipient = a;
      }
    }
    const spanHours = tmax > tmin ? (tmax - tmin) / 3600 : null;
    // Все известные контрагенты со значимым SOL или стейблкоинами (в том числе из чужих историй) — для правила
    // HUB_DEGREE. Токены не считаем: у трейдера сотни переводов токенов адресам пулов, которые выглядят как кошельки.
    const known = neighbors(x).filter((n) => {
      const f = flows(x, n);
      return f.out + f.in > 0;
    });
    await ensureKinds(known);
    const knownDegree = known.filter((n) => kinds.get(n) === 'wallet').length;

    let service: Hub | null = null;
    if (senders >= COLLECTOR_SENDERS && recipients <= Math.max(2, senders * COLLECTOR_MAX_OUT_SHARE)) {
      service = { label: `Сбор комиссий (${senders} отпр.)`, category: 'collector' };
    } else if (
      recipients >= SERVICE_RECIPIENTS ||
      (recipients >= SERVICE_RECIPIENTS_WITH_SENDERS && senders >= SERVICE_SENDERS) ||
      senders + recipients >= HUB_DEGREE
    ) {
      service = { label: 'Биржа или сервис', category: 'service' };
    } else if (knownDegree >= HUB_DEGREE || (!complete && knownDegree >= HUB_DEGREE * 0.6)) {
      service = { label: `Сервис (${knownDegree}+ контрагентов)`, category: 'service' };
    } else if (
      rows.length >= VELOCITY_ROWS &&
      spanHours != null &&
      rows.length / Math.max(spanHours, 1 / 60) >= VELOCITY_PER_HOUR &&
      senders + recipients >= VELOCITY_PARTIES
    ) {
      service = { label: 'Сервис (частые переводы)', category: 'service' };
    }
    // Раздача наград точнее общей пометки «сервис» (у раздатчика с сотней держателей сработает и правило получателей).
    // От биржи отличает повторяемость: держатели получают выплату раунд за раундом, клиенты биржи — нет.
    if (!service || service.category === 'service') {
      // Раунды выплат: слот → получатели (SOL или токены, любые суммы).
      const bySlot = new Map<number, Set<string>>();
      for (const t of rows) if (t.from === x) (bySlot.get(t.slot) ?? bySlot.set(t.slot, new Set()).get(t.slot)!).add(t.to);
      const rounds = [...bySlot.values()].filter((r) => r.size >= REWARD_BATCH_MIN);
      if (rounds.length >= 2) {
        const seen = new Map<string, number>();
        for (const r of rounds) for (const a of r) seen.set(a, (seen.get(a) ?? 0) + 1);
        const repeatShare = [...seen.values()].filter((n) => n >= 2).length / seen.size;
        const entities = new Set([...seen.keys()].map((a) => S.get(a)?.entity).filter((e): e is string => !!e));
        if (repeatShare >= 0.3 && (entities.size >= REWARD_MIN_ENTITIES || (rounds.length >= 3 && repeatShare >= 0.5))) {
          service = { label: `Раздача наград держателям (${seen.size} получ.)`, category: 'rewards' };
        }
      }
    }
    if (service) {
      markHub(x, service);
      db.setService(x, service.label, service.category);
    }
    degrees.set(x, Math.max(degrees.get(x) ?? 0, senders + recipients));
    return { address: x, rows: rows.length, spanHours, complete, senders, recipients, topRecipient, topRecipientShare: outSol > 0 ? topVol / outSol : 0, outSol, service };
  }

  const profMemo = new Map<string, { sample: number; p: Promise<Profile> }>();
  /**
   * Распознаёт биржу, сервис или кошелёк комиссий по выборке последних переводов (по умолчанию 100 = 10 кредитов).
   * Если выборка неполная и есть признаки сервиса, берёт 600. Распознанный адрес попадает в hubs.
   */
  function profile(x: string, sample = PROFILE_RECENT): Promise<Profile> {
    const m = profMemo.get(x);
    if (m && m.sample >= sample) return m.p;
    const p = computeProfile(x, sample).then((pr) => {
      const fast = pr.spanHours != null && pr.rows / Math.max(pr.spanHours, 1 / 60) >= VELOCITY_PER_HOUR;
      const borderline = !pr.service && !pr.complete && pr.rows >= sample * 0.9 && (pr.senders >= 12 || pr.recipients >= 25 || fast);
      return borderline && sample < PROFILE_DEEP ? computeProfile(x, PROFILE_DEEP) : pr;
    });
    profMemo.set(x, { sample, p });
    return p;
  }

  /**
   * Личный ли депозитный адрес: кроме исключённых имён (цель, вторая сторона), через него проходит не больше
   * allowed имён из списка. Адрес, на который платят три разных человека, — не личный счёт на бирже.
   */
  function depositPersonal(x: string, allowed: number, excludeEntities: ReadonlySet<string>): boolean {
    const ents = new Set<string>();
    for (const n of neighbors(x)) {
      const w = S.get(n);
      if (w && !d.self.has(n) && !excludeEntities.has(w.entity)) ents.add(w.entity);
    }
    return ents.size <= allowed;
  }

  /**
   * Плательщик комиссий за многих — ретранслятор терминала или бота, а не владелец: биржа/сервис/сборщик по поведению,
   * либо по индексу он платит за кошельки больше чем FEE_PAYER_MAX_ENTITIES разных имён (кроме исключённых).
   */
  async function isFeeRelayer(p: string, excludeEntities: ReadonlySet<string>): Promise<boolean> {
    if (isHub(p)) return true;
    const ents = new Set<string>();
    for (const r of db.paidBy(p)) {
      const e = S.get(r.wallet)?.entity;
      if (e && !excludeEntities.has(e)) ents.add(e);
    }
    if (ents.size > FEE_PAYER_MAX_ENTITIES) {
      markHub(p, { label: `Плательщик комиссий за многих (${ents.size} имён)`, category: 'service' });
      return true;
    }
    const pr = await profile(p);
    return !!pr.service;
  }

  const depMemo = new Map<string, Promise<string | null>>();
  /**
   * Личный депозитный адрес на бирже: мало отправителей, почти весь SOL уходит одному адресу биржи
   * (метка, поведение биржи или сборный кошелёк). Возвращает имя биржи или «биржа».
   */
  function depositOf(x: string): Promise<string | null> {
    let p = depMemo.get(x);
    if (!p) {
      p = (async () => {
        if (d.self.has(x) || labelOf(x)) return null;
        const pr = await profile(x);
        if (pr.service || pr.senders > DEPOSIT_MAX_SENDERS || !pr.topRecipient) return null;
        if (pr.outSol < DEPOSIT_MIN_OUT_SOL || pr.topRecipientShare < DEPOSIT_MIN_SHARE) return null;
        const dest = await profile(pr.topRecipient);
        const cat = dest.service?.category;
        if (cat !== 'cex' && cat !== 'service' && cat !== 'collector') return null;
        const name = cat === 'cex' ? dest.service!.label : 'биржа';
        deposits.set(x, name);
        return name;
      })();
      depMemo.set(x, p);
    }
    return p;
  }

  /** Узлы и рёбра карты. hop — расстояние от root по выбранным рёбрам. */
  function buildGraph(nodeKinds: Map<string, NodeKind>, edgeIds: Set<string>, scoreOf: Map<string, number>, root: string) {
    const outEdges: GraphEdge[] = [];
    const volume = new Map<string, number>();
    const record = (t: Transfer, coBuy: boolean): TransferRecord => ({
      signature: t.signature,
      blockTime: t.blockTime,
      slot: t.slot,
      from: t.from,
      to: t.to,
      mint: t.mint,
      symbol: symbolOf(t.mint),
      amount: t.uiAmount,
      ...(coBuy ? { coBuy: true as const } : {}),
    });
    for (const id of edgeIds) {
      const e = edges.get(id);
      const cb = coBuys.get(id);
      const fp = feeEdges.get(id);
      if (!e && !cb && !fp) continue;
      const a = e?.a ?? cb?.a ?? fp!.a;
      const b = e?.b ?? cb?.b ?? fp!.b;
      const m = e ? metricsOf(e) : edgeMetrics({ a, transfers: [] }, minSol);
      const transfers: TransferRecord[] = [...(e ? [...e.transfers.values()].map((t) => record(t, false)) : []), ...(cb ? cb.records.map((t) => record(t, true)) : [])]
        .sort((p, q) => q.slot - p.slot)
        .slice(0, MAX_EDGE_TRANSFERS);
      const funded = fundingOf.get(id);
      outEdges.push({
        id,
        source: a,
        target: b,
        solForward: m.solAB,
        solBackward: m.solBA,
        tokenTransferCount: m.tokAB + m.tokBA,
        transferCount: m.count,
        firstTime: m.first,
        lastTime: m.last,
        ...(funded ? { fundingOf: funded } : {}),
        strength: Math.max(e ? edgeStrength(m, !!funded) : 0, cb ? coBuyScore(cb.mints) : 0, fp ? FEE_PAYER_SCORE : 0),
        ...(cb ? { coBuy: { mints: cb.mints, slots: cb.slots } } : {}),
        ...(fp ? { feesPaid: { payer: fp.payer, txCount: fp.txCount } } : {}),
        transfers,
      });
      const v = m.solAB + m.solBA;
      volume.set(a, (volume.get(a) ?? 0) + v);
      volume.set(b, (volume.get(b) ?? 0) + v);
    }

    const hop = new Map<string, number>([[root, 0]]);
    const queue = [root];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const e of outEdges) {
        const next = e.source === cur ? e.target : e.target === cur ? e.source : null;
        if (next && !hop.has(next)) {
          hop.set(next, hop.get(cur)! + 1);
          queue.push(next);
        }
      }
    }

    const nodes: GraphNode[] = [...nodeKinds.entries()].map(([id, kind]) => {
      const w = S.get(id);
      const label = labelOf(id);
      const hub = hubs.get(id) ?? (label ? { label: label.name, category: label.category } : undefined);
      return {
        id,
        kind,
        label: w?.name ?? label?.name ?? shortAddr(id),
        ...(w ? { emoji: w.emoji, entity: w.entity, entityName: w.entityName, groups: w.groups } : {}),
        ...(kind === 'hub' && hub ? { hubLabel: hub.label, hubCategory: hub.category } : {}),
        ...(deposits.has(id) ? { depositOf: deposits.get(id) } : {}),
        hop: hop.get(id) ?? 1,
        ...(scoreOf.has(id) ? { score: scoreOf.get(id) } : {}),
        volumeSol: volume.get(id) ?? 0,
        ...(degrees.has(id) ? { degree: degrees.get(id) } : {}),
      };
    });
    return { nodes, edges: outEdges };
  }

  /** Добавляет узел с типом не ниже уже назначенного (цель > список > …). */
  function setKind(nodeKinds: Map<string, NodeKind>, a: string, kind: NodeKind): void {
    const cur = nodeKinds.get(a);
    if (!cur || NODE_ORDER.indexOf(kind) > NODE_ORDER.indexOf(cur)) nodeKinds.set(a, kind);
  }

  function transfersLoaded(): number {
    let n = 0;
    for (const e of edges.values()) n += e.transfers.size;
    return n;
  }

  return {
    S,
    edges,
    fundingOf,
    kinds,
    degrees,
    hubs,
    deposits,
    coBuys,
    addCoBuy,
    addFeesPaid,
    hasEdge,
    infraTracked,
    fetched,
    addTransfers,
    neighbors,
    metrics,
    metricsOf,
    strength,
    flows,
    amountText,
    significant,
    ensureKinds,
    isPlainWallet,
    isHub,
    markHub,
    usableTracked,
    nameOf,
    hist,
    findFunder,
    profile,
    depositOf,
    depositPersonal,
    isFeeRelayer,
    buildGraph,
    setKind,
    transfersLoaded,
  };
}

export type Workspace = ReturnType<typeof createWorkspace>;
