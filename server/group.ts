// Карта выбранных кошельков: связи между ними, кластеры и связи с остальным списком.
// Быстрый режим — только по кэшу (истории индекса, совместные покупки, плательщики комиссий), без запросов к сети.
// Глубокий — догружает истории выбранных и проверяет все пары по всей истории (фильтр with).

import type { ConnectionType, GroupLink, GroupOptions, GroupResult, NodeKind, TrackedWallet } from '../shared/types.ts';
import type { Classifier } from './accounts.ts';
import { shortAddr } from './config.ts';
import type { Db } from './db.ts';
import type { Ctx } from './http.ts';
import { mapLimit } from './http.ts';
import { labelOf } from './labels.ts';
import type { TransferProvider } from './providers/types.ts';
import {
  COBUY_MAX_ENTITIES,
  COBUY_MIN_MINTS,
  COMMON_FEE_PAYER_SCORE,
  FEE_PAYER_MAX_ENTITIES,
  FEE_PAYER_MIN_TX,
  FEE_PAYER_SCORE,
  HOP_DECAY,
  HUB_ENTITIES,
  clamp,
  coBuyScore,
  degreePenalty,
  edgeIdOf,
  fmtSol,
  plural,
  slotsText,
  tokensText,
  txText,
} from './scoring.ts';
import type { TrackedIndex } from './tracked.ts';
import type { History, LoadHistory } from './workspace.ts';
import { createWorkspace } from './workspace.ts';

export const GROUP_MAX = 15;
const CLUSTER_MIN_SCORE = 0.5;
const PATHS_PER_PAIR = 3;
const MAX_EXTERNAL = 40;
const DEEP_RECENT = 600;
const OLDEST_ROWS = 100;
/** В глубоком режиме: сколько общих посредников проверять на «сервис» (10 кредитов каждый). */
const DEEP_MID_PROFILES = 20;

export interface GroupDeps {
  db: Db;
  provider: TransferProvider;
  classify: Classifier;
  tracked: () => TrackedIndex;
  loadHistory: LoadHistory;
  loadPayers?: (address: string, ctx: Ctx, refresh?: boolean) => Promise<boolean>;
}

export function createGroupFinder(deps: GroupDeps) {
  async function group(addressesIn: string[], optsIn: GroupOptions, ctx: Ctx): Promise<GroupResult> {
    const startedAt = Date.now();
    const callsBefore = ctx.meter.calls;
    const creditsBefore = ctx.meter.credits;
    const addresses = [...new Set(addressesIn)].slice(0, GROUP_MAX);
    const opts: Required<GroupOptions> = { deep: !!optsIn.deep, minSol: clamp(optsIn.minSol ?? 0.01, 0, 100) };
    const tracked = deps.tracked();
    const sel = new Set(addresses);
    const db = deps.db;
    // Быстрый режим: история — только то, что уже лежит в кэше.
    const cacheOnly: LoadHistory = async (address) => {
      const rec = db.getFetch(address, 'recent');
      return { transfers: db.transfersOf(address), truncated: !rec?.complete, hasOldest: !!(rec?.complete || db.getFetch(address, 'oldest')?.complete) };
    };
    const ws = createWorkspace({
      db,
      classify: deps.classify,
      tracked,
      loadHistory: opts.deep ? deps.loadHistory : cacheOnly,
      minSol: opts.minSol,
      refresh: false,
      ctx,
      self: sel,
    });
    const { S, neighbors, significant, flows, strength, isHub, isPlainWallet, ensureKinds, findFunder, fundingOf, nameOf } = ws;
    const warnings: string[] = [];
    const ownEntities = new Set(addresses.map((a) => S.get(a)?.entity).filter((e): e is string => !!e));
    // У кошельков одного человека одинаковые имена («Yugi» и «Yugi»): в карте группы добавляем короткий адрес.
    const label = (x: string) => (S.has(x) ? `${nameOf(x)} ${shortAddr(x)}` : nameOf(x));

    // ---------- 1. Истории ----------
    ctx.log(opts.deep ? `Загружаю истории ${addresses.length} кошельков…` : `Собираю данные ${addresses.length} кошельков из кэша…`);
    const hist = new Map<string, History>();
    await mapLimit(addresses, 3, async (x) => hist.set(x, await ws.hist(x, opts.deep ? DEEP_RECENT : 0, opts.deep ? OLDEST_ROWS : 0)));
    const empty = addresses.filter((x) => (hist.get(x)?.transfers.length ?? 0) === 0);
    if (!opts.deep && empty.length > 0) {
      warnings.push(`Нет истории в кэше у ${plural(empty.length, 'кошелька', 'кошельков', 'кошельков')} (${empty.map(label).join(', ')}): для них нажмите «Глубже».`);
    }
    if (opts.deep && deps.loadPayers) {
      await mapLimit(addresses, 2, async (x) => {
        try {
          await deps.loadPayers!(x, ctx);
        } catch {
          /* плательщики не обязательны */
        }
      });
    }
    if (opts.deep && deps.provider.fetchBetween) {
      const pairs: Array<[string, string]> = [];
      for (let i = 0; i < addresses.length; i++) for (let j = i + 1; j < addresses.length; j++) pairs.push([addresses[i], addresses[j]]);
      ctx.log(`Проверяю пары по всей истории: ${pairs.length}.`);
      const between = deps.provider.fetchBetween.bind(deps.provider);
      await mapLimit(pairs, 3, async ([a, b]) => ws.addTransfers(await between(a, b, 200, ctx)));
    }
    await ensureKinds([...addresses, ...addresses.flatMap((x) => neighbors(x))]);
    const funderOf = new Map<string, string>();
    for (const x of addresses) {
      const f = findFunder(x, hist.get(x)!);
      if (f) {
        funderOf.set(x, f.from);
        fundingOf.set(edgeIdOf(x, f.from), x);
      }
    }

    // Посредник с кошельками многих имён из списка — общий сервис (по кэшу).
    const entitiesAround = (x: string) => new Set(neighbors(x).map((n) => S.get(n)?.entity).filter((e): e is string => !!e && !ownEntities.has(e))).size;
    const okMid = (x: string) => !sel.has(x) && isPlainWallet(x) && !isHub(x) && entitiesAround(x) < HUB_ENTITIES;
    const degreeOf = (x: string) => ws.degrees.get(x) ?? Math.max(3, neighbors(x).filter((n) => flows(x, n).out + flows(x, n).in > 0).length);

    // Совместные покупки и плательщики комиссий — по кэшу.
    const coBuys = new Map<string, Map<string, ReturnType<Db['coBuysOf']>[number]>>();
    for (const x of addresses) {
      const list = db.coBuysOf(x).filter((c) => c.mints.size >= COBUY_MIN_MINTS);
      await ensureKinds(list.map((c) => c.wallet));
      const usable = list.filter((c) => isPlainWallet(c.wallet) && !isHub(c.wallet));
      const own = S.get(x)?.entity;
      const ents = new Set(usable.map((c) => S.get(c.wallet)?.entity).filter((e) => e && e !== own && !ownEntities.has(e)));
      if (ents.size > COBUY_MAX_ENTITIES) {
        warnings.push(`${label(x)} покупает в одном слоте с трейдерами многих имён — похоже на снайпинг; его совместные покупки не учитываются.`);
        continue;
      }
      coBuys.set(x, new Map(usable.map((c) => [c.wallet, c])));
    }
    const payers = new Map(addresses.map((x) => [x, new Map(db.payersOf(x).filter((r) => r.n >= FEE_PAYER_MIN_TX).map((r) => [r.payer, r.n]))]));
    const relayerQuick = (p: string) => {
      if (isHub(p)) return true;
      const ents = new Set(db.paidBy(p).map((r) => S.get(r.wallet)?.entity).filter((e) => e && !ownEntities.has(e)));
      return ents.size > FEE_PAYER_MAX_ENTITIES;
    };

    // ---------- 2. Пары ----------
    ctx.log('Ищу связи между выбранными кошельками…');
    const links: GroupLink[] = [];
    const midCandidates = new Map<string, number>();
    for (let i = 0; i < addresses.length; i++) {
      for (let j = i + 1; j < addresses.length; j++) {
        const a = addresses[i];
        const b = addresses[j];
        const found: GroupLink[] = [];
        const id = edgeIdOf(a, b);
        if (significant(a, b)) {
          const f = flows(a, b);
          const parts: string[] = [];
          if (f.solOut > 0) parts.push(`${label(a)} → ${label(b)} ${fmtSol(f.solOut)} SOL`);
          if (f.solIn > 0) parts.push(`${label(b)} → ${label(a)} ${fmtSol(f.solIn)} SOL`);
          if (f.tokOut + f.tokIn > 0) parts.push(`переводов токенов: ${f.tokOut + f.tokIn}`);
          const funded = fundingOf.get(id);
          const extra = funded ? ` ${label(funded === a ? b : a)} — первый источник SOL кошелька ${label(funded)}.` : '';
          found.push({ a, b, type: 'direct', score: strength(a, b), reason: `Прямые переводы: ${parts.join(', ')}.${extra}`, nodes: [a, b], edgeIds: [id] });
        }
        const cbA = coBuys.get(a)?.get(b);
        if (cbA && coBuys.has(b)) {
          found.push({
            a,
            b,
            type: 'co-buy',
            score: coBuyScore(cbA.mints.size),
            reason: `Покупали одни и те же токены в одном слоте: ${tokensText(cbA.mints.size)}, ${slotsText(cbA.slots.size)}.`,
            nodes: [a, b],
            edgeIds: [ws.addCoBuy(a, b, cbA)],
          });
        }
        for (const [payer, paid] of [[a, b], [b, a]] as const) {
          const n = payers.get(paid)?.get(payer);
          if (!n) continue;
          found.push({ a, b, type: 'fee-payer', score: FEE_PAYER_SCORE, reason: `${label(payer)} оплачивал комиссии за ${txText(n)} кошелька ${label(paid)}.`, nodes: [a, b], edgeIds: [ws.addFeesPaid(payer, paid, n)] });
        }
        for (const [p, na] of payers.get(a) ?? []) {
          const nb = payers.get(b)?.get(p);
          if (!nb || sel.has(p) || relayerQuick(p)) continue;
          found.push({
            a,
            b,
            type: 'fee-payer',
            score: COMMON_FEE_PAYER_SCORE,
            reason: `Общий плательщик комиссий ${label(p)}: за ${label(a)} — ${txText(na)}, за ${label(b)} — ${txText(nb)}.`,
            nodes: [a, p, b],
            edgeIds: [ws.addFeesPaid(p, a, na), ws.addFeesPaid(p, b, nb)],
          });
        }
        const nbB = new Set(neighbors(b));
        for (const x of neighbors(a)) {
          if (!nbB.has(x) || !okMid(x) || !significant(a, x) || !significant(b, x)) continue;
          const fa = flows(x, a);
          const fb = flows(x, b);
          let type: ConnectionType = 'via-intermediary';
          let reason = `Оба связаны переводами с ${label(x)}.`;
          if (fa.out > 0 && fb.out > 0) {
            type = 'common-funder';
            reason = `Общий источник ${label(x)}: отправлял средства и ${label(a)} (${ws.amountText(fa.solOut, fa.out)}), и ${label(b)} (${ws.amountText(fb.solOut, fb.out)}).`;
          } else if (fa.in > 0 && fb.in > 0) {
            type = 'common-recipient';
            reason = `Общий получатель ${label(x)}: оба отправляли ему средства.`;
          }
          const deg = degreeOf(x);
          if (deg > 20) reason += ` У посредника много контрагентов (${deg}), связь ослаблена.`;
          const score = strength(a, x) * strength(x, b) * degreePenalty(deg) * HOP_DECAY;
          found.push({ a, b, type, score, reason, nodes: [a, x, b], edgeIds: [edgeIdOf(a, x), edgeIdOf(x, b)] });
          midCandidates.set(x, Math.max(midCandidates.get(x) ?? 0, score));
        }
        found.sort((p, q) => q.score - p.score);
        links.push(...found.slice(0, PATHS_PER_PAIR * 3));
      }
    }

    // Глубокий режим: самых значимых посредников проверяем на «сервис» и выбрасываем пути через них.
    if (opts.deep && midCandidates.size > 0) {
      const top = [...midCandidates].sort((p, q) => q[1] - p[1]).slice(0, DEEP_MID_PROFILES).map(([x]) => x);
      ctx.log(`Проверяю посредников: ${top.length}.`);
      await mapLimit(top, 3, (x) => ws.profile(x));
    }
    const kept = links.filter((l) => l.nodes.slice(1, -1).every((x) => !isHub(x)));
    // До PATHS_PER_PAIR лучших путей на пару.
    const perPair = new Map<string, GroupLink[]>();
    for (const l of kept.sort((p, q) => q.score - p.score)) {
      const k = edgeIdOf(l.a, l.b);
      const list = perPair.get(k) ?? perPair.set(k, []).get(k)!;
      if (list.length < PATHS_PER_PAIR) list.push(l);
    }
    const finalLinks = [...perPair.values()].flat().sort((p, q) => q.score - p.score);

    // ---------- 3. Кластеры ----------
    const parent = new Map(addresses.map((x) => [x, x]));
    const find = (x: string): string => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
    for (const l of finalLinks) if (l.score >= CLUSTER_MIN_SCORE) parent.set(find(l.a), find(l.b));
    const byRoot = new Map<string, string[]>();
    for (const x of addresses) (byRoot.get(find(x)) ?? byRoot.set(find(x), []).get(find(x))!).push(x);
    const clusters = [...byRoot.values()].sort((p, q) => q.length - p.length);
    const clusterOf = new Map<string, number>();
    clusters.forEach((c, i) => c.forEach((x) => clusterOf.set(x, i)));

    // ---------- 4. Связи с остальным списком ----------
    const external: GroupResult['external'] = [];
    const extEdges = new Set<string>();
    for (const x of addresses) {
      const seen = new Map<string, GroupResult['external'][number] & { id: string }>();
      const offer = (w: string, type: ConnectionType, score: number, reason: string, id: string) => {
        const tw: TrackedWallet | undefined = S.get(w);
        if (!tw || sel.has(w) || labelOf(w) || ws.kinds.get(w) === 'program') return;
        const cur = seen.get(w);
        if (!cur || cur.score < score) seen.set(w, { from: x, wallet: tw, type, score, reason, id });
      };
      for (const n of neighbors(x)) {
        if (!S.has(n) || !significant(x, n)) continue;
        const f = flows(x, n);
        const parts: string[] = [];
        if (f.solOut > 0) parts.push(`отправлено ${fmtSol(f.solOut)} SOL`);
        if (f.solIn > 0) parts.push(`получено ${fmtSol(f.solIn)} SOL`);
        if (f.tokOut + f.tokIn > 0) parts.push(`переводов токенов: ${f.tokOut + f.tokIn}`);
        offer(n, 'direct', strength(x, n), `Прямые переводы с ${label(n)}: ${parts.join(', ')}.`, edgeIdOf(x, n));
      }
      for (const [w, c] of coBuys.get(x) ?? []) {
        if (S.has(w) && !sel.has(w)) offer(w, 'co-buy', coBuyScore(c.mints.size), `Покупки в одном слоте с ${label(w)}: ${tokensText(c.mints.size)}.`, ws.addCoBuy(x, w, c));
      }
      for (const [p, n] of payers.get(x) ?? []) {
        if (S.has(p) && !sel.has(p) && !relayerQuick(p)) offer(p, 'fee-payer', FEE_PAYER_SCORE, `${label(p)} оплачивал комиссии за ${txText(n)}.`, ws.addFeesPaid(p, x, n));
      }
      for (const e of seen.values()) {
        const { id, ...rest } = e;
        external.push(rest);
        extEdges.add(id);
      }
    }
    external.sort((p, q) => q.score - p.score);
    external.splice(MAX_EXTERNAL);
    const keptExternal = new Set(external.map((e) => `${e.from}|${e.wallet.address}`));

    // ---------- 5. Карта ----------
    const nodeKinds = new Map<string, NodeKind>(addresses.map((x) => [x, 'target'] as const));
    const edgeIds = new Set<string>();
    for (const l of finalLinks) {
      l.nodes.slice(1, -1).forEach((x) => ws.setKind(nodeKinds, x, S.has(x) ? 'tracked' : 'intermediary'));
      l.edgeIds.forEach((id) => edgeIds.add(id));
    }
    for (const e of external) {
      ws.setKind(nodeKinds, e.wallet.address, 'tracked');
      const id = edgeIdOf(e.from, e.wallet.address);
      if (extEdges.has(id) && keptExternal.has(`${e.from}|${e.wallet.address}`)) edgeIds.add(id);
    }
    const scoreOf = new Map(external.map((e) => [e.wallet.address, e.score] as const));
    const { nodes, edges } = ws.buildGraph(nodeKinds, edgeIds, scoreOf, addresses[0]);
    for (const n of nodes) if (clusterOf.has(n.id)) n.cluster = clusterOf.get(n.id);

    const hidden = [...ws.hubs.keys()].filter((h) => addresses.some((x) => neighbors(x).includes(h))).length;
    if (hidden > 0) warnings.push(`Биржи и сервисы среди контрагентов (${hidden}) не считаются связью.`);
    if (finalLinks.length === 0) warnings.push(opts.deep ? 'Связей между выбранными кошельками не найдено.' : 'По кэшу связей между выбранными не найдено — попробуйте «Глубже».');
    ctx.log(`Готово: связей ${finalLinks.length}, кластеров ${clusters.filter((c) => c.length > 1).length}.`);
    return {
      addresses,
      generatedAt: Date.now(),
      options: opts,
      links: finalLinks,
      clusters,
      external,
      nodes,
      edges,
      warnings,
      stats: {
        provider: deps.provider.name,
        transfersLoaded: ws.transfersLoaded(),
        walletsFetched: opts.deep ? ws.fetched.size : 0,
        apiCalls: ctx.meter.calls - callsBefore,
        creditsEstimate: ctx.meter.credits - creditsBefore,
        durationMs: Date.now() - startedAt,
        truncated: [...hist.values()].some((h) => h.truncated),
      },
    };
  }

  return { group };
}

