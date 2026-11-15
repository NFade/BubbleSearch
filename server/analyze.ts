// Ядро: поиск связей между кошельком и списком отслеживания.
// Описание алгоритма и обоснование порогов — в PLAN.md, раздел «Алгоритм»; оценки — в scoring.ts.

import type {
  AnalyzeOptions,
  AnalyzeResult,
  Connection,
  ConnectionPath,
  ConnectionType,
  EntityConnection,
  NodeKind,
  SiblingCandidate,
  SiblingSignal,
} from '../shared/types.ts';
import type { Classifier } from './accounts.ts';
import { shortAddr } from './config.ts';
import type { Db } from './db.ts';
import type { Ctx } from './http.ts';
import { mapLimit } from './http.ts';
import { labelOf } from './labels.ts';
import type { Transfer, TransferProvider } from './providers/types.ts';
import { COBUY_MAX_ENTITIES, COBUY_MIN_MINTS, COMMON_FEE_PAYER_SCORE, FEE_PAYER_MIN_TX, FEE_PAYER_SCORE, HOP_DECAY, txText, HUB_DEGREE, HUB_ENTITIES, clamp, coBuyScore, combineScores, degreePenalty, edgeIdOf, fmtSol, slotsText, tokensText } from './scoring.ts';
import type { CoBuy } from './db.ts';
import type { TrackedIndex } from './tracked.ts';
import type { History } from './workspace.ts';
import { createWorkspace } from './workspace.ts';

// Для тестов и старых импортов.
export { COLLECTOR_SENDERS, HOP_DECAY, HUB_DEGREE, HUB_ENTITIES, combineScores, degreePenalty, edgeMetrics, edgeStrength, fmtSol } from './scoring.ts';
export type { EdgeMetrics } from './scoring.ts';
export type { History } from './workspace.ts';

/** Сколько последних переводов посредника загружать. */
const INTERMEDIARY_RECENT = 600;
/**
 * Глубина 3 — третий шаг: цель → посредник → посредник → список. Полностью раскрываются DEPTH3_EXPAND самых значимых
 * контрагентов посредников (по DEPTH3_RECENT переводов), остальные проверяются по сохранённым историям списка,
 * найденные — короткой выборкой на «сервис» (до DEPTH3_CACHE_PROFILE). Около 400 кредитов сверх глубины 2.
 */
const DEPTH3_EXPAND = 8;
const DEPTH3_RECENT = 300;
const DEPTH3_CACHE_PROFILE = 15;
const OLDEST_ROWS = 100;
const MAX_OTHER_NODES = 12;
const MAX_HUB_NODES = 6;
/** Сколько посредников из обратного поиска по кэшу проверять на «сервис» (10 кредитов каждый). */
const REVERSE_PROFILE_LIMIT = 20;
/** Кандидаты в кошельки того же владельца: сколько проверять по первому пополнению (10 кредитов каждый). */
const SIBLING_CHECK = 15;
const SIBLING_MIN_SCORE = 0.35;
const SIBLING_MAX = 15;
/** Сильные «свои кошельки» (оценка от SIBLING_EXPAND_MIN) раскрываются как продолжение цели: их связи со списком — связи владельца. */
const SIBLING_EXPAND = 3;
const SIBLING_EXPAND_MIN = 0.75;
/** Общий первый источник считается признаком, только если у источника немного контрагентов (личный раздатчик). */
const SIBLING_FUNDER_MAX_DEGREE = 40;
/** Плательщиков комиссий проверяем по 100 последним транзакциям, раз в неделю. */
const PAYERS_TX = 100;
const PAYERS_TTL_SEC = 7 * 86400;
const SIGNAL_WEIGHT: Record<SiblingSignal, number> = {
  'funded-by-target': 0.75,
  'funded-target': 0.7,
  'shared-deposit': 0.8,
  'common-funder': 0.55,
  'token-moves': 0.45,
  'two-way': 0.35,
  'co-buy': 0, // вес зависит от числа токенов: coBuyScore
  'fee-payer': 0.85,
};

export interface EngineDeps {
  db: Db;
  provider: TransferProvider;
  classify: Classifier;
  tracked: () => TrackedIndex;
  recentTtlSec: number;
}

export function createEngine(deps: EngineDeps) {
  const { db, provider, classify } = deps;
  const nowSec = () => Math.floor(Date.now() / 1000);

  /** Загружает плательщиков комиссий кошелька (Parsed Events, 10 кредитов), если источник это умеет и данные устарели. */
  async function loadPayers(address: string, ctx: Ctx, refresh = false): Promise<boolean> {
    if (!provider.fetchFeePayers) return false;
    const now = nowSec();
    const st = db.getFetch(address, 'payers');
    if (st && !refresh && now - st.fetchedAt < PAYERS_TTL_SEC) return true;
    const r = await provider.fetchFeePayers(address, PAYERS_TX, ctx);
    if (!r) return false;
    db.setFeePayers(address, r.payers);
    db.setFetch(address, 'payers', { fetchedAt: now, rowLimit: PAYERS_TX, rows: r.txCount, complete: r.txCount < PAYERS_TX });
    return true;
  }

  async function loadHistory(address: string, want: { recent: number; oldest: number; refresh?: boolean }, ctx: Ctx): Promise<History> {
    const now = nowSec();
    let recent = db.getFetch(address, 'recent');
    if (want.recent > 0) {
      const tooSmall = !!recent && !recent.complete && recent.rowLimit < want.recent;
      const expired = !!recent && now - recent.fetchedAt > deps.recentTtlSec;
      const topOf = (list: Transfer[], prev?: number | null) => list.reduce((m, t) => Math.max(m, t.slot), prev ?? 0) || null;
      if (!recent || want.refresh || tooSmall || (expired && recent.topSlot == null)) {
        const r = await provider.fetchRecent(address, want.recent, ctx);
        db.insertTransfers(r.transfers);
        recent = { fetchedAt: now, rowLimit: want.recent, rows: r.transfers.length, complete: r.complete, topSlot: topOf(r.transfers) };
        db.setFetch(address, 'recent', recent);
      } else if (expired) {
        // Догрузка: только переводы новее уже известных. Если новых больше лимита (дыра в истории),
        // считаем свежей частью только загруженное сейчас.
        const r = await provider.fetchRecent(address, want.recent, ctx, { untilSlot: recent.topSlot! });
        db.insertTransfers(r.transfers);
        recent =
          r.reachedKnown || r.complete
            ? { fetchedAt: now, rowLimit: recent.rowLimit, rows: recent.rows + r.transfers.length, complete: recent.complete || r.complete, topSlot: topOf(r.transfers, recent.topSlot) }
            : { fetchedAt: now, rowLimit: want.recent, rows: r.transfers.length, complete: false, topSlot: topOf(r.transfers, recent.topSlot) };
        db.setFetch(address, 'recent', recent);
      }
    }
    let hasOldest = !!recent?.complete;
    if (!hasOldest && want.oldest > 0) {
      let oldest = db.getFetch(address, 'oldest');
      // Самые ранние переводы не меняются: повторяем запрос, только если прошлый не удался.
      if (!oldest || (!oldest.complete && (want.refresh || now - oldest.fetchedAt > deps.recentTtlSec))) {
        const rows = await provider.fetchOldest(address, want.oldest, ctx);
        if (rows) db.insertTransfers(rows);
        oldest = { fetchedAt: now, rowLimit: want.oldest, rows: rows?.length ?? 0, complete: rows !== null };
        db.setFetch(address, 'oldest', oldest);
      }
      hasOldest = oldest.complete;
    }
    return { transfers: db.transfersOf(address), truncated: !recent?.complete, hasOldest };
  }

  async function analyze(target: string, optsIn: AnalyzeOptions, ctx: Ctx): Promise<AnalyzeResult> {
    const startedAt = Date.now();
    const opts: Required<AnalyzeOptions> = {
      depth: optsIn.depth === 1 || optsIn.depth === 3 ? optsIn.depth : 2,
      maxTransfers: clamp(Math.round(optsIn.maxTransfers ?? 2000), 100, 20000),
      minSol: clamp(optsIn.minSol ?? 0.01, 0, 100),
      maxIntermediaries: clamp(Math.round(optsIn.maxIntermediaries ?? provider.hints?.maxIntermediaries ?? 12), 0, 40),
      refresh: !!optsIn.refresh,
    };
    const tracked = deps.tracked();
    const warnings: string[] = [];
    const ws = createWorkspace({ db, classify, tracked, loadHistory, minSol: opts.minSol, refresh: opts.refresh, ctx, self: new Set([target]) });
    const { S, edges, fundingOf, kinds, degrees, hubs, flows, amountText, strength, neighbors, ensureKinds, isPlainWallet, isHub, usableTracked, nameOf, hist, findFunder } = ws;
    const intermediaryRecent = provider.hints?.intermediaryRecent ?? INTERMEDIARY_RECENT;
    const fetchedBefore = ctx.meter.calls;

    // ---------- 1. История цели ----------
    ctx.log(`Загружаю переводы кошелька ${shortAddr(target)}…`);
    const hT = await hist(target, opts.maxTransfers, OLDEST_ROWS);
    ctx.log(`Переводов у цели: ${hT.transfers.length}${hT.truncated ? ' (история длиннее, взята свежая часть)' : ''}.`);
    if (hT.truncated) {
      warnings.push(
        `История кошелька длинная: проанализированы последние переводы (лимит ${opts.maxTransfers}) и самые ранние. Старые связи из середины истории могли не попасть.`,
      );
    }
    if (provider.name === 'rpc') {
      warnings.push('Ключ Helius не задан: данные берутся из публичного RPC, это медленно и неглубоко. Добавьте HELIUS_API_KEY в файл .env.');
    }

    const cpT = neighbors(target);
    await ensureKinds([target, ...cpT]);
    if (kinds.get(target) === 'program') warnings.push('Этот адрес принадлежит программе, а не обычному кошельку: результат может быть бессмысленным.');

    // ---------- 2. Источник средств цели ----------
    const funderT = findFunder(target, hT);
    if (funderT) fundingOf.set(edgeIdOf(target, funderT.from), target);

    // ---------- пути ----------
    const paths = new Map<string, ConnectionPath[]>(); // адрес отслеживаемого → пути
    /** upgrade — тот же путь с более точным пониманием (посредник оказался своим кошельком): берём большую оценку и новое пояснение. */
    const addPath = (s: string, p: ConnectionPath, upgrade = false) => {
      const list = paths.get(s) ?? paths.set(s, []).get(s)!;
      // Совместные покупки — отдельный путь даже при тех же узлах, что у прямых переводов: это другое доказательство.
      const tag = (q: ConnectionPath) => q.nodes.join('>') + (q.type === 'co-buy' || q.type === 'fee-payer' ? `#${q.type}` : '');
      const sig = tag(p);
      const same = list.find((q) => tag(q) === sig);
      if (!same) list.push(p);
      else if (p.type === 'funding-chain' || p.type === 'shared-deposit') {
        // Тот же путь, найденный повторно с более точным описанием.
        same.type = p.type;
        same.reason = p.reason;
        same.score = Math.max(same.score, p.score);
      } else if (upgrade && p.score > same.score) {
        same.reason = p.reason;
        same.score = p.score;
      }
    };
    /** Сервисы, через которые были бы связи со списком: адрес → пояснение. Выводятся одним предупреждением. */
    const hiddenServices = new Map<string, string>();
    const pathEdges = (nodes: string[]) => nodes.slice(1).map((n, i) => edgeIdOf(nodes[i], n));
    const depositName = (dep: string) => (dep === 'биржа' ? 'биржи' : dep);

    // ---------- 3. Прямые связи ----------
    for (const s of cpT) {
      if (!usableTracked(s)) continue;
      const f = flows(target, s);
      const id = edgeIdOf(target, s);
      let reason: string;
      if (fundingOf.get(id) === target) {
        reason = `${nameOf(s)} — источник первого пополнения этого кошелька (${fmtSol(funderT!.uiAmount)} SOL).`;
      } else {
        const parts: string[] = [];
        if (f.solOut > 0) parts.push(`отправлено ${fmtSol(f.solOut)} SOL`);
        if (f.solIn > 0) parts.push(`получено ${fmtSol(f.solIn)} SOL`);
        const tok = f.tokOut + f.tokIn;
        if (tok > 0) parts.push(`переводов токенов: ${tok}`);
        reason = `Прямые переводы с ${nameOf(s)}: ${parts.join(', ') || 'только пыль'} (всего ${f.m.count}).`;
      }
      addPath(s, { type: 'direct', nodes: [target, s], edgeIds: [id], score: strength(target, s), reason });
    }
    ctx.log(`Прямых связей со списком: ${paths.size}.`);

    // ---------- 3б. Совместные покупки (по кэшу, без запросов к сети) ----------
    const ownEntity = new Set(S.get(target) ? [S.get(target)!.entity] : []);
    const coBuyOf = new Map<string, CoBuy>();
    {
      const found = db.coBuysOf(target).filter((c) => c.mints.size >= COBUY_MIN_MINTS);
      await ensureKinds(found.map((c) => c.wallet));
      const usable = found.filter((c) => isPlainWallet(c.wallet) && !isHub(c.wallet));
      const coEntities = new Set(usable.filter((c) => S.has(c.wallet)).map((c) => S.get(c.wallet)!.entity).filter((e) => !ownEntity.has(e)));
      if (coEntities.size > COBUY_MAX_ENTITIES) {
        warnings.push(
          `Кошелёк покупает токены в одном слоте с трейдерами ${coEntities.size} разных имён из списка — похоже на снайпинг запусков, а не на бандл. Совместные покупки не учитываются.`,
        );
        usable.length = 0;
      }
      for (const c of usable) {
        coBuyOf.set(c.wallet, c);
        if (!usableTracked(c.wallet)) continue;
        const id = ws.addCoBuy(target, c.wallet, c);
        addPath(c.wallet, {
          type: 'co-buy',
          nodes: [target, c.wallet],
          edgeIds: [id],
          score: coBuyScore(c.mints.size),
          reason: `Покупали одни и те же токены в одном слоте разными транзакциями: ${tokensText(c.mints.size)}, ${slotsText(c.slots.size)}. Так обычно работают бандлы одного владельца.`,
        });
      }
      if (coBuyOf.size > 0) ctx.log(`Совместных покупок с другими кошельками: ${coBuyOf.size}.`);
    }

    // ---------- 3в. Плательщики комиссий ----------
    // Если транзакции кошелька оплачивает другой адрес (fee payer), им управляет один человек.
    const feeSib = new Map<string, { reason: string; ids: string[] }>();
    {
      let ok = false;
      try {
        ok = await loadPayers(target, ctx, opts.refresh);
      } catch (e) {
        warnings.push(`Не удалось проверить, кто оплачивает комиссии кошелька: ${e instanceof Error ? e.message.slice(0, 120) : e}.`);
      }
      if (ok) {
        const payers = db.payersOf(target).filter((r) => r.n >= FEE_PAYER_MIN_TX);
        const payees = db.paidBy(target).filter((r) => r.n >= FEE_PAYER_MIN_TX);
        await ensureKinds([...payers.map((r) => r.payer), ...payees.map((r) => r.wallet)]);
        for (const { payer, n } of payers) {
          if (await ws.isFeeRelayer(payer, ownEntity)) continue;
          const id = ws.addFeesPaid(payer, target, n);
          if (usableTracked(payer)) {
            addPath(payer, { type: 'fee-payer', nodes: [target, payer], edgeIds: [id], score: FEE_PAYER_SCORE, reason: `${nameOf(payer)} оплачивал комиссии за ${txText(n)} этого кошелька (из последних ${PAYERS_TX}).` });
          } else if (!S.has(payer)) {
            feeSib.set(payer, { reason: `Оплачивал комиссии за ${txText(n)} цели.`, ids: [id] });
          }
          for (const { wallet: w, n: n2 } of db.paidBy(payer)) {
            if (w === target || n2 < FEE_PAYER_MIN_TX) continue;
            const id2 = ws.addFeesPaid(payer, w, n2);
            if (usableTracked(w)) {
              addPath(w, {
                type: 'fee-payer',
                nodes: [target, payer, w],
                edgeIds: [id, id2],
                score: COMMON_FEE_PAYER_SCORE,
                reason: `Общий плательщик комиссий ${shortAddr(payer)}: платил за этот кошелёк (${txText(n)}) и за ${nameOf(w)} (${txText(n2)}).`,
              });
            } else if (!S.has(w) && !feeSib.has(w)) {
              feeSib.set(w, { reason: `Общий плательщик комиссий с целью — ${shortAddr(payer)}.`, ids: [id, id2] });
            }
          }
        }
        for (const { wallet: w, n } of payees) {
          if (isHub(w)) continue;
          const id = ws.addFeesPaid(target, w, n);
          if (usableTracked(w)) {
            addPath(w, { type: 'fee-payer', nodes: [target, w], edgeIds: [id], score: FEE_PAYER_SCORE, reason: `Этот кошелёк оплачивал комиссии за ${txText(n)} ${nameOf(w)}.` });
          } else if (!S.has(w)) {
            feeSib.set(w, { reason: `Цель оплачивала комиссии за ${txText(n)} этого кошелька.`, ids: [id] });
          }
        }
        const nFee = payers.length + payees.length;
        if (nFee > 0) ctx.log(`Плательщиков комиссий и оплаченных кошельков: ${nFee}.`);
      }
    }

    // ---------- 4. Раскрытие посредников ----------
    /** Загружает историю посредника x и ищет у него связи со списком. prefix — путь от цели до x включительно. */
    /** hop — путь из переводов в несколько шагов (глубина 3), а не цепочка первых пополнений; recent — сколько переводов загружать. */
    const expand = async (x: string, prefix: string[], prefixScore: number, wantOldest: boolean, o: { hop?: boolean; recent?: number } = {}): Promise<void> => {
      const recentRows = o.recent ?? intermediaryRecent;
      const h = await hist(x, recentRows, wantOldest ? OLDEST_ROWS : 0);
      const nb = neighbors(x).filter((n) => !prefix.includes(n));
      const sig = nb.filter((n) => {
        const f = flows(x, n);
        return f.out + f.in > 0 || S.has(n);
      });
      await ensureKinds(sig);
      const hits = sig.filter(usableTracked);
      const pr = await ws.profile(x, recentRows);
      const degree = sig.filter((n) => S.has(n) || isPlainWallet(n)).length + (prefix.length - 1);
      degrees.set(x, Math.max(degrees.get(x) ?? 0, degree));
      if (!pr.service && (degree >= HUB_DEGREE || (h.truncated && degree >= HUB_DEGREE * 0.6))) {
        ws.markHub(x, { label: `Сервис (${degree}+ контрагентов)`, category: 'service' });
      }
      const hub = hubs.get(x);
      if (hub) {
        if (hits.length > 0) hiddenServices.set(x, hub.label.toLowerCase());
        return;
      }
      const entityCount = new Set(hits.map((s) => S.get(s)!.entity)).size;
      if (entityCount >= HUB_ENTITIES) {
        ws.markHub(x, { label: `Связан с ${entityCount} именами из списка`, category: 'service' });
        warnings.push(`Кошелёк ${shortAddr(x)} связан с ${entityCount} разными именами из списка — похоже на общий сервис. Связи через него скрыты.`);
        return;
      }
      const deposit = prefix.length === 2 ? await ws.depositOf(x) : null;
      const decay = HOP_DECAY ** (prefix.length - 1);
      const penalty = degreePenalty(degree);
      for (const s of hits) {
        const nodes = [...prefix, s];
        let type: ConnectionType = 'via-intermediary';
        let reason = `Связь через посредника ${shortAddr(x)}: он переводил средства и этому кошельку, и ${nameOf(s)}.`;
        if (prefix.length === 2) {
          const toT = flows(x, target);
          const toS = flows(x, s);
          if (deposit && toT.in > 0 && toS.in > 0 && ws.depositPersonal(x, 1, ownEntity)) {
            type = 'shared-deposit';
            reason = `Общий депозитный адрес ${depositName(deposit)} ${shortAddr(x)}: на него отправляли средства и этот кошелёк (${amountText(toT.solIn, toT.in)}), и ${nameOf(s)} (${amountText(toS.solIn, toS.in)}). Такой адрес обычно принадлежит одному пользователю биржи.`;
          } else if (toT.out > 0 && toS.out > 0) {
            type = 'common-funder';
            reason = `Общий источник средств ${shortAddr(x)}: отправлял средства и этому кошельку (${amountText(toT.solOut, toT.out)}), и ${nameOf(s)} (${amountText(toS.solOut, toS.out)}).`;
          } else if (toT.in > 0 && toS.in > 0) {
            type = 'common-recipient';
            reason = `Общий получатель ${shortAddr(x)}: на него отправляли средства и этот кошелёк (${amountText(toT.solIn, toT.in)}), и ${nameOf(s)} (${amountText(toS.solIn, toS.in)}).`;
          }
        } else if (o.hop) {
          reason = `Связь в ${prefix.length} шага: ${prefix.slice(1).map(shortAddr).join(' → ')} → ${nameOf(s)}.`;
        } else {
          reason = `Общий источник выше по цепочке финансирования: ${prefix.slice(1).map(shortAddr).join(' → ')} связан с ${nameOf(s)}.`;
        }
        let score: number;
        if (type === 'shared-deposit') score = Math.max(0.75, prefixScore * strength(x, s));
        else {
          score = prefixScore * strength(x, s) * penalty * decay;
          if (degree > 20) reason += ` У посредника много контрагентов (${degree}), связь ослаблена.`;
        }
        addPath(s, { type, nodes, edgeIds: pathEdges(nodes), score, reason });
      }
    };

    const expanded = new Set<string>();
    if (opts.depth >= 2) {
      const candidates = cpT
        .filter((x) => !S.has(x) && isPlainWallet(x))
        .filter((x) => {
          const f = flows(target, x);
          return f.out + f.in > 0 || f.tokOut > 0;
        })
        .map((x) => ({ x, s: strength(target, x) }))
        .sort((p, q) => q.s - p.s);
      const top = candidates.slice(0, opts.maxIntermediaries).map((c) => c.x);
      if (funderT && !S.has(funderT.from) && isPlainWallet(funderT.from) && !top.includes(funderT.from)) top.unshift(funderT.from);
      if (candidates.length > top.length) {
        ctx.log(`Посредников-кандидатов: ${candidates.length}, раскрываю ${top.length} самых значимых.`);
      } else if (top.length > 0) {
        ctx.log(`Раскрываю посредников: ${top.length}.`);
      }
      let done = 0;
      await mapLimit(top, 3, async (x) => {
        expanded.add(x);
        await expand(x, [target, x], strength(target, x), x === funderT?.from);
        done++;
        if (done % 4 === 0 || done === top.length) ctx.log(`Посредников проверено: ${done} из ${top.length}.`);
      });

      // ---------- 4б. Третий шаг (глубина 3) ----------
      if (opts.depth >= 3) {
        const cpSet = new Set(cpT);
        const second = new Map<string, { via: string; score: number }>();
        for (const x of top) {
          if (isHub(x)) continue;
          const base = strength(target, x) * degreePenalty(degrees.get(x) ?? 3);
          for (const y of neighbors(x)) {
            if (y === target || expanded.has(y) || S.has(y) || cpSet.has(y)) continue;
            const f = flows(x, y);
            if (f.out + f.in === 0) continue;
            const sc = base * strength(x, y);
            if ((second.get(y)?.score ?? -1) < sc) second.set(y, { via: x, score: sc });
          }
        }
        await ensureKinds([...second.keys()]);
        const ranked = [...second].filter(([y]) => isPlainWallet(y) && !isHub(y)).sort((p, q) => q[1].score - p[1].score);
        const topY = ranked.slice(0, DEPTH3_EXPAND);
        if (topY.length > 0) ctx.log(`Третий шаг: раскрываю ${topY.length} из ${ranked.length} кошельков второго уровня.`);
        await mapLimit(topY, 3, async ([y, { via, score }]) => {
          expanded.add(y);
          await expand(y, [target, via, y], score, false, { hop: true, recent: DEPTH3_RECENT });
        });
        // Остальные — по сохранённым историям списка, без загрузки их истории.
        const restY = ranked.slice(DEPTH3_EXPAND).map(([y]) => y);
        if (restY.length > 0) {
          ws.addTransfers(db.linksToTracked(restY));
          const withHits = restY.filter((y) => neighbors(y).some((n) => S.has(n) && n !== target)).slice(0, DEPTH3_CACHE_PROFILE);
          await mapLimit(withHits, 3, async (y) => {
            const pr = await ws.profile(y);
            if (pr.service) return;
            const { via, score } = second.get(y)!;
            await ensureKinds(neighbors(y));
            const hits = neighbors(y).filter((n) => usableTracked(n) && ws.significant(y, n));
            if (hits.length === 0 || new Set(hits.map((n) => S.get(n)!.entity)).size >= HUB_ENTITIES) return;
            const deg = Math.max(pr.senders + pr.recipients, hits.length + 1, 3);
            for (const s of hits) {
              const nodes = [target, via, y, s];
              addPath(s, {
                type: 'via-intermediary',
                nodes,
                edgeIds: pathEdges(nodes),
                score: score * strength(y, s) * degreePenalty(deg) * HOP_DECAY ** 2,
                reason: `Связь в 3 шага (по сохранённой истории ${nameOf(s)}): ${[via, y].map(shortAddr).join(' → ')} → ${nameOf(s)}.`,
              });
            }
          });
        }
      }

      // ---------- 5. Обратный поиск по кэшу ----------
      // Истории отслеживаемых кошельков, загруженные раньше (npm run index-tracked), работают как индекс:
      // связь посредник ↔ список находится без загрузки истории посредника. Посредника с находками
      // проверяем короткой выборкой (10 кредитов): не биржа ли это.
      const rest = cpT.filter((x) => !S.has(x) && isPlainWallet(x) && !expanded.has(x) && !isHub(x));
      if (rest.length > 0) {
        ws.addTransfers(db.linksToTracked(rest));
        const withHits = rest
          .filter((x) => {
            const f = flows(target, x);
            return (f.out + f.in > 0 || f.tokOut > 0) && neighbors(x).some((n) => S.has(n) && n !== target);
          })
          .sort((p, q) => strength(target, q) - strength(target, p))
          .slice(0, REVERSE_PROFILE_LIMIT);
        if (withHits.length > 0) ctx.log(`Найдено по сохранённым историям списка: ${withHits.length}, проверяю их.`);
        await mapLimit(withHits, 3, async (x) => {
          const pr = await ws.profile(x);
          if (pr.service) return;
          await ensureKinds(neighbors(x));
          const hits = neighbors(x).filter(usableTracked);
          if (hits.length === 0) return;
          const entityCount = new Set(hits.map((s) => S.get(s)!.entity)).size;
          if (entityCount >= HUB_ENTITIES) {
            ws.markHub(x, { label: `Связан с ${entityCount} именами из списка`, category: 'service' });
            return;
          }
          const degree = Math.max(pr.senders + pr.recipients, hits.length + 1);
          degrees.set(x, Math.max(degrees.get(x) ?? 0, degree));
          const deposit = await ws.depositOf(x);
          for (const s of hits) {
            const nodes = [target, x, s];
            const toT = flows(x, target);
            const toS = flows(x, s);
            if (deposit && toT.in > 0 && toS.in > 0 && ws.depositPersonal(x, 1, ownEntity)) {
              addPath(s, {
                type: 'shared-deposit',
                nodes,
                edgeIds: pathEdges(nodes),
                score: Math.max(0.75, strength(target, x) * strength(x, s)),
                reason: `Общий депозитный адрес ${depositName(deposit)} ${shortAddr(x)}: на него отправляли средства и этот кошелёк, и ${nameOf(s)}. Такой адрес обычно принадлежит одному пользователю биржи.`,
              });
              continue;
            }
            addPath(s, {
              type: 'via-intermediary',
              nodes,
              edgeIds: pathEdges(nodes),
              score: strength(target, x) * strength(x, s) * degreePenalty(degree) * HOP_DECAY,
              reason: `Связь через посредника ${shortAddr(x)} (найдена по сохранённой истории ${nameOf(s)}).`,
            });
          }
        });
      }
    }

    // ---------- 6. Цепочка финансирования ----------
    const chain: string[] = [target];
    let chainEnd: 'tracked' | 'hub' | 'unknown' | 'limit' = 'unknown';
    {
      const maxLevels = opts.depth === 1 ? 1 : opts.depth === 2 ? 2 : 4;
      let cur = target;
      let curHist: History = hT;
      let score = 1;
      for (let level = 1; level <= maxLevels; level++) {
        const f = findFunder(cur, curHist);
        if (!f) break;
        const funder = f.from;
        if (chain.includes(funder)) break;
        fundingOf.set(edgeIdOf(cur, funder), cur);
        chain.push(funder);
        await ensureKinds([funder]);
        score *= strength(cur, funder) * (level > 1 ? degreePenalty(degrees.get(cur) ?? 3) * HOP_DECAY : 1);
        if (S.has(funder) && usableTracked(funder)) {
          if (level > 1) {
            addPath(funder, {
              type: 'funding-chain',
              nodes: [...chain],
              edgeIds: pathEdges(chain),
              score,
              reason: `${nameOf(funder)} стоит в цепочке финансирования: ${[...chain].reverse().map(nameOf).join(' → ')}.`,
            });
          }
          chainEnd = 'tracked';
          break;
        }
        // Биржа или сервис: дальше цепочка ничего не говорит о владельце.
        if (opts.depth >= 2 && !isHub(funder)) await ws.profile(funder);
        if (isHub(funder)) {
          chainEnd = 'hub';
          break;
        }
        if (level === maxLevels) {
          chainEnd = 'limit';
          break;
        }
        ctx.log(`Цепочка финансирования: уровень ${level}, ${shortAddr(funder)}.`);
        if (opts.depth >= 3 && level >= 2 && !expanded.has(funder)) {
          expanded.add(funder);
          await expand(funder, [...chain], score, true);
        }
        curHist = await hist(funder, 0, OLDEST_ROWS);
        cur = funder;
      }
    }
    if (chain.length > 1 && chainEnd === 'hub') {
      const last = chain[chain.length - 1];
      const hub = hubs.get(last);
      if (hub?.category === 'cex') warnings.push(`Средства пришли с биржи ${hub.label}: дальше цепочку финансирования проследить нельзя.`);
      else if (hub?.category === 'service') {
        warnings.push(`Средства пришли с адреса ${shortAddr(last)}, похожего на биржу или сервис: дальше цепочку финансирования проследить нельзя.`);
      }
    }
    if (hiddenServices.size > 0) {
      warnings.push(
        `Связи через биржи и сервисы скрыты (${hiddenServices.size}): ${[...hiddenServices].map(([x, why]) => `${shortAddr(x)} — ${why}`).join('; ')}. Через такие адреса проходят деньги тысяч людей, родства это не означает.`,
      );
    }
    if (!hT.hasOldest) warnings.push('Не удалось добраться до самых ранних переводов кошелька: источник первого пополнения не определён.');

    // ---------- 7. Вероятные кошельки того же владельца ----------
    const siblings: SiblingCandidate[] = [];
    if (opts.depth >= 2) {
      const funder = funderT && !S.has(funderT.from) && !isHub(funderT.from) ? funderT.from : null;
      const funderPersonal = funder != null && (degrees.get(funder) ?? Number.POSITIVE_INFINITY) <= SIBLING_FUNDER_MAX_DEGREE;
      const cands = new Set<string>();
      for (const x of cpT) {
        if (S.has(x)) continue;
        const f = flows(target, x);
        if (f.out + f.in + f.tokOut + f.tokIn > 0) cands.add(x);
      }
      if (funder && funderPersonal) for (const y of neighbors(funder)) if (y !== target && !S.has(y) && flows(funder, y).out > 0) cands.add(y);
      for (const w of coBuyOf.keys()) if (!S.has(w)) cands.add(w);
      for (const w of feeSib.keys()) cands.add(w);
      await ensureKinds([...cands]);
      const targetDeposits = [...ws.deposits.keys()].filter((dep) => flows(target, dep).out > 0 && ws.depositPersonal(dep, 0, ownEntity));
      const ranked = [...cands]
        .filter((x) => isPlainWallet(x) && !isHub(x) && !ws.deposits.has(x))
        .map((x) => ({
          x,
          s: Math.max(strength(target, x), funder && funderPersonal && flows(funder, x).out > 0 ? 0.3 : 0, coBuyScore(coBuyOf.get(x)?.mints.size ?? 0), feeSib.has(x) ? FEE_PAYER_SCORE : 0),
        }))
        .sort((p, q) => q.s - p.s)
        .slice(0, SIBLING_CHECK);
      if (ranked.length > 0) ctx.log(`Ищу другие кошельки владельца: проверяю ${ranked.length}.`);
      const funderOf = new Map<string, string>();
      await mapLimit(ranked, 3, async ({ x }) => {
        const h = await hist(x, 0, OLDEST_ROWS);
        const f = findFunder(x, h);
        if (f) funderOf.set(x, f.from);
      });
      for (const { x } of ranked) {
        const signals: SiblingSignal[] = [];
        const reasons: string[] = [];
        const ids = new Set<string>();
        const direct = edgeIdOf(target, x);
        const f = flows(target, x);
        if (funderOf.get(x) === target) {
          signals.push('funded-by-target');
          reasons.push('Цель — первый источник SOL этого кошелька.');
          fundingOf.set(direct, x);
          ids.add(direct);
        }
        if (funderT?.from === x) {
          signals.push('funded-target');
          reasons.push(`Этот кошелёк — первый источник SOL цели (${fmtSol(funderT.uiAmount)} SOL).`);
          ids.add(direct);
        }
        if (funder && funderPersonal && funderOf.get(x) === funder) {
          signals.push('common-funder');
          reasons.push(`У обоих один первый источник SOL — ${shortAddr(funder)} (у него ${degrees.get(funder) ?? '?'} контрагентов).`);
          fundingOf.set(edgeIdOf(funder, x), x);
          ids.add(edgeIdOf(target, funder));
          ids.add(edgeIdOf(funder, x));
        }
        if (f.out > 0 && f.in > 0) {
          signals.push('two-way');
          reasons.push(`Переводы SOL в обе стороны: отправлено ${amountText(f.solOut, f.out)}, получено ${amountText(f.solIn, f.in)}.`);
          ids.add(direct);
        }
        if (f.tokOut > 0 || (f.tokIn > 0 && signals.length > 0)) {
          signals.push('token-moves');
          reasons.push(`Между кошельками перемещались токены (переводов: ${f.tokOut + f.tokIn}) — так обычно делают со своими кошельками.`);
          ids.add(direct);
        }
        const fee = feeSib.get(x);
        if (fee) {
          signals.push('fee-payer');
          reasons.push(fee.reason);
          fee.ids.forEach((id) => ids.add(id));
        }
        const cb = coBuyOf.get(x);
        if (cb) {
          signals.push('co-buy');
          reasons.push(`Покупали одни и те же токены в одном слоте: ${tokensText(cb.mints.size)}, ${slotsText(cb.slots.size)}.`);
          ids.add(ws.addCoBuy(target, x, cb));
        }
        for (const dep of targetDeposits) {
          if (dep === x || flows(x, dep).out === 0) continue;
          signals.push('shared-deposit');
          reasons.push(`Оба пополняли один депозитный адрес ${depositName(ws.deposits.get(dep)!)} ${shortAddr(dep)}.`);
          ids.add(edgeIdOf(target, dep));
          ids.add(edgeIdOf(x, dep));
          break;
        }
        if (signals.length === 0) continue;
        const base = edges.has(direct) ? strength(target, x) * 0.5 : 0;
        const score = combineScores([base, ...signals.map((s) => (s === 'co-buy' ? coBuyScore(cb!.mints.size) : SIGNAL_WEIGHT[s]))]);
        if (score < SIBLING_MIN_SCORE) continue;
        siblings.push({
          address: x,
          score,
          signals,
          reasons,
          edgeIds: [...ids].filter((id) => ws.hasEdge(id)),
          totalSol: f.solOut + f.solIn,
          transferCount: f.m.count,
        });
      }
      siblings.sort((p, q) => q.score - p.score);
      siblings.splice(SIBLING_MAX);

      // ---------- 7б. Связи вероятных своих кошельков ----------
      // Путь цель → свой кошелёк x → кошелёк из списка. Штрафа за широту x нет: x — тот же владелец, а не посредник.
      // Уже раскрытые как посредники тоже берём (история в памяти): их пути пересчитываются без штрафа за широту.
      const strong = siblings.filter((sb) => sb.score >= SIBLING_EXPAND_MIN).slice(0, SIBLING_EXPAND);
      if (strong.length > 0) ctx.log(`Проверяю связи вероятных своих кошельков: ${strong.length}.`);
      await mapLimit(strong, 3, async (sb) => {
        const x = sb.address;
        expanded.add(x);
        await hist(x, intermediaryRecent, 0);
        const pr = await ws.profile(x, intermediaryRecent);
        if (pr.service) return;
        // Узлы от цели до x: напрямую или через общий узел двух рёбер признака (например, общий источник).
        let head: string[] | null = null;
        if (ws.hasEdge(edgeIdOf(target, x))) head = [target, x];
        else if (sb.edgeIds.length === 2) {
          const [e1, e2] = sb.edgeIds.map((id) => id.split('|'));
          const mid = e1.find((n) => e2.includes(n) && n !== target && n !== x);
          if (mid && e1.includes(target) && e2.includes(x)) head = [target, mid, x];
        }
        if (!head) return;
        const nb = neighbors(x).filter((n) => !head!.includes(n));
        await ensureKinds(nb);
        const hits = nb.filter((n) => usableTracked(n) && ws.significant(x, n));
        if (new Set(hits.map((n) => S.get(n)!.entity)).size >= HUB_ENTITIES) return;
        const pct = Math.round(sb.score * 100);
        for (const s of hits) {
          const f = flows(x, s);
          const parts: string[] = [];
          if (f.solOut > 0) parts.push(`отправил ${fmtSol(f.solOut)} SOL`);
          if (f.solIn > 0) parts.push(`получил ${fmtSol(f.solIn)} SOL`);
          if (f.tokOut + f.tokIn > 0) parts.push(`переводов токенов: ${f.tokOut + f.tokIn}`);
          const nodes = [...head, s];
          addPath(s, {
            type: 'via-intermediary',
            nodes,
            edgeIds: pathEdges(nodes),
            score: sb.score * strength(x, s) * HOP_DECAY,
            reason: `Через вероятный свой кошелёк ${shortAddr(x)} (${pct}%): он ${parts.join(', ')} с ${nameOf(s)}.`,
          }, true);
        }
      });
    }

    // ---------- 8. Сборка результата ----------
    const connections: Connection[] = [];
    for (const [s, list] of paths) {
      list.sort((p, q) => q.score - p.score);
      const top = list.slice(0, 5);
      const lastEdges = new Set(top.map((p) => p.edgeIds[p.edgeIds.length - 1]));
      let totalSol = 0;
      let transferCount = 0;
      let first: number | null = null;
      let last: number | null = null;
      for (const id of lastEdges) {
        const e = edges.get(id);
        if (!e) continue;
        const m = ws.metricsOf(e);
        totalSol += m.solAB + m.solBA;
        transferCount += m.count;
        if (m.first != null && (first == null || m.first < first)) first = m.first;
        if (m.last != null && (last == null || m.last > last)) last = m.last;
      }
      connections.push({
        wallet: S.get(s)!,
        score: combineScores(top.map((p) => p.score)),
        hops: Math.min(...top.map((p) => p.nodes.length - 1)),
        paths: top,
        totalSol,
        transferCount,
        firstTime: first,
        lastTime: last,
      });
    }
    connections.sort((p, q) => q.score - p.score);

    const byEntity = new Map<string, Connection[]>();
    for (const c of connections) (byEntity.get(c.wallet.entity) ?? byEntity.set(c.wallet.entity, []).get(c.wallet.entity)!).push(c);
    const entities: EntityConnection[] = [...byEntity.entries()]
      .map(([entity, list]) => ({
        entity,
        entityName: list[0].wallet.entityName,
        emoji: list.find((c) => c.wallet.emoji)?.wallet.emoji ?? '',
        score: combineScores(list.map((c) => c.score)),
        wallets: list.map((c) => c.wallet.address),
      }))
      .sort((p, q) => q.score - p.score);

    // Узлы и рёбра, попадающие на карту.
    const nodeKinds = new Map<string, NodeKind>([[target, 'target']]);
    const edgeIds = new Set<string>();
    const setKind = (a: string, kind: NodeKind) => ws.setKind(nodeKinds, a, kind);
    for (const c of connections) {
      for (const p of c.paths) {
        p.nodes.forEach((n, i) => {
          if (i === 0) return;
          setKind(n, i === p.nodes.length - 1 ? 'tracked' : S.has(n) && usableTracked(n) ? 'tracked' : 'intermediary');
        });
        for (const id of p.edgeIds) edgeIds.add(id);
      }
    }
    chain.slice(1).forEach((n, i) => {
      setKind(n, isHub(n) ? 'hub' : 'funder');
      edgeIds.add(edgeIdOf(chain[i], n));
    });
    for (const sb of siblings) {
      setKind(sb.address, 'sibling');
      for (const id of sb.edgeIds) {
        edgeIds.add(id);
        for (const n of id.split('|')) if (!nodeKinds.has(n)) setKind(n, isHub(n) ? 'hub' : 'intermediary');
      }
    }
    const others = cpT
      .filter((x) => !nodeKinds.has(x) && !S.has(x) && isPlainWallet(x) && !isHub(x))
      .map((x) => ({ x, m: ws.metrics(target, x) }))
      .filter(({ m }) => m.sigAB + m.sigBA > 0)
      .sort((p, q) => q.m.solAB + q.m.solBA - (p.m.solAB + p.m.solBA))
      .slice(0, MAX_OTHER_NODES);
    for (const { x } of others) {
      setKind(x, 'other');
      edgeIds.add(edgeIdOf(target, x));
    }
    // Распознанные биржи и сервисы среди контрагентов цели — на карте, чтобы было видно, что они узнаны и отброшены.
    const exchangeHubs = cpT
      .filter((x) => !nodeKinds.has(x) && isHub(x))
      .filter((x) => {
        const cat = hubs.get(x)?.category ?? labelOf(x)?.category;
        return cat === 'cex' || cat === 'service' || cat === 'collector';
      })
      .map((x) => ({ x, m: ws.metrics(target, x) }))
      .filter(({ m }) => m.sigAB + m.sigBA > 0)
      .sort((p, q) => q.m.solAB + q.m.solBA - (p.m.solAB + p.m.solBA))
      .slice(0, MAX_HUB_NODES);
    for (const { x } of exchangeHubs) {
      setKind(x, 'hub');
      edgeIds.add(edgeIdOf(target, x));
    }

    const scoreOf = new Map<string, number>([...siblings.map((s) => [s.address, s.score] as const), ...connections.map((c) => [c.wallet.address, c.score] as const)]);
    const { nodes, edges: outEdges } = ws.buildGraph(nodeKinds, edgeIds, scoreOf, target);

    if (ws.infraTracked.size > 0) {
      warnings.push(
        `В списке есть служебные адреса (${[...ws.infraTracked].map(nameOf).join(', ')}): переводы на них есть почти у всех, поэтому связью они не считаются.`,
      );
    }
    if (connections.length === 0 && db.indexedCount() === 0 && opts.depth >= 2) {
      warnings.push('Список отслеживания ещё не проиндексирован. Команда «npm run index-tracked» загрузит источники средств всех кошельков списка и заметно улучшит поиск общих источников.');
    }

    ctx.log(`Готово: связей ${connections.length}, имён ${entities.length}, вероятных своих кошельков ${siblings.length}.`);
    return {
      target,
      targetTracked: S.get(target) ?? null,
      generatedAt: Date.now(),
      options: opts,
      nodes,
      edges: outEdges,
      connections,
      entities,
      siblings,
      warnings,
      stats: {
        provider: provider.name,
        transfersLoaded: ws.transfersLoaded(),
        walletsFetched: ws.fetched.size,
        apiCalls: ctx.meter.calls - fetchedBefore,
        creditsEstimate: ctx.meter.credits,
        durationMs: Date.now() - startedAt,
        truncated: hT.truncated,
      },
    };
  }

  return { analyze, loadHistory, loadPayers };
}

export type Engine = ReturnType<typeof createEngine>;
