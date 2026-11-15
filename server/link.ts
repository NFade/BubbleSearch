// Режим «Два кошелька»: ищет пути между a и b длиной до maxHops встречным поиском
// и общий источник выше по цепочкам финансирования обоих. Биржи и сервисы промежуточными звеньями не считаются.

import type { ConnectionType, LinkOptions, LinkPath, LinkResult, NodeKind } from '../shared/types.ts';
import type { Classifier } from './accounts.ts';
import { shortAddr } from './config.ts';
import type { Db } from './db.ts';
import type { Ctx } from './http.ts';
import { mapLimit } from './http.ts';
import type { TransferProvider } from './providers/types.ts';
import { COBUY_MAX_ENTITIES, COBUY_MIN_MINTS, COMMON_FEE_PAYER_SCORE, FEE_PAYER_MIN_TX, FEE_PAYER_SCORE, HOP_DECAY, txText, clamp, coBuyScore, combineScores, degreePenalty, edgeIdOf, fmtSol, slotsText, tokensText } from './scoring.ts';
import type { TrackedIndex } from './tracked.ts';
import type { History, LoadHistory } from './workspace.ts';
import { createWorkspace } from './workspace.ts';

const LINK_RECENT = 1500;
const OLDEST_ROWS = 100;
/** Сколько самых значимых контрагентов каждой стороны раскрывать при maxHops ≥ 3, и сколько их переводов брать. */
const EXPAND_PER_SIDE = 10;
const EXPAND_RECENT = 300;
/** Сколько ещё не проверенных промежуточных звеньев лучших путей проверять на «сервис» (10 кредитов каждый). */
const MID_PROFILE_LIMIT = 25;
const CHAIN_LEVELS = 4;
const MAX_PATHS = 15;
const MAX_CANDIDATES = 300;
/** Точечные проверки пар по всей истории (фильтр with, 10 кредитов каждая): главные контрагенты одной стороны против другой. */
const PAIR_CHECKS_PER_SIDE = 8;

export interface LinkDeps {
  db: Db;
  provider: TransferProvider;
  classify: Classifier;
  tracked: () => TrackedIndex;
  loadHistory: LoadHistory;
  /** Загрузка плательщиков комиссий (engine.loadPayers); без неё признак не проверяется. */
  loadPayers?: (address: string, ctx: Ctx, refresh?: boolean) => Promise<boolean>;
}

export function createLinkFinder(deps: LinkDeps) {
  async function link(a: string, b: string, optsIn: LinkOptions, ctx: Ctx): Promise<LinkResult> {
    const startedAt = Date.now();
    const callsBefore = ctx.meter.calls;
    const opts: Required<LinkOptions> = {
      maxHops: optsIn.maxHops === 2 || optsIn.maxHops === 4 ? optsIn.maxHops : 3,
      minSol: clamp(optsIn.minSol ?? 0.01, 0, 100),
      refresh: !!optsIn.refresh,
    };
    const tracked = deps.tracked();
    const ws = createWorkspace({ db: deps.db, classify: deps.classify, tracked, loadHistory: deps.loadHistory, minSol: opts.minSol, refresh: opts.refresh, ctx, self: new Set([a, b]) });
    const { S, fundingOf, hubs, degrees, neighbors, strength, flows, amountText, significant, ensureKinds, isPlainWallet, isHub, nameOf, hist, findFunder } = ws;
    const warnings: string[] = [];
    const label = (x: string) => (x === a ? 'A' : x === b ? 'B' : nameOf(x));

    // ---------- 1. Истории обоих ----------
    ctx.log(`Загружаю переводы ${shortAddr(a)} и ${shortAddr(b)}…`);
    const [hA, hB] = await Promise.all([hist(a, LINK_RECENT, OLDEST_ROWS), hist(b, LINK_RECENT, OLDEST_ROWS)]);
    ctx.log(`Переводов: A — ${hA.transfers.length}, B — ${hB.transfers.length}.`);
    for (const [h, n] of [[hA, 'A'], [hB, 'B']] as const) {
      if (h.truncated) warnings.push(`История кошелька ${n} длинная: взяты последние ${LINK_RECENT} переводов и самые ранние, связи из середины истории могли не попасть.`);
    }
    const ta = S.get(a);
    const tb = S.get(b);
    if (ta && tb && ta.entity === tb.entity) warnings.push(`Оба кошелька в вашем списке под одним именем — «${ta.entityName}». Ниже — что подтверждается переводами.`);
    await ensureKinds([a, b, ...neighbors(a), ...neighbors(b)]);
    for (const [x, h] of [[a, hA], [b, hB]] as const) {
      const f = findFunder(x, h);
      if (f) fundingOf.set(edgeIdOf(x, f.from), x);
    }

    const okMid = (x: string) => x !== a && x !== b && isPlainWallet(x) && !isHub(x);
    const topNeighbors = (x: string) =>
      neighbors(x)
        .filter((n) => okMid(n) && significant(x, n))
        .sort((p, q) => strength(x, q) - strength(x, p))
        .slice(0, EXPAND_PER_SIDE);

    // ---------- 1б. Точечные проверки по всей истории ----------
    // Свежие окна историй могут не пересекаться: прямой перевод A ↔ B или перевод главного контрагента A с B
    // мог быть давно. Фильтр with отдаёт переводы пары за всю историю одним запросом.
    if (deps.provider.fetchBetween) {
      const between = deps.provider.fetchBetween.bind(deps.provider);
      const checks: Array<[string, string]> = [[a, b]];
      for (const x of topNeighbors(a).slice(0, PAIR_CHECKS_PER_SIDE)) if (!significant(x, b)) checks.push([x, b]);
      for (const y of topNeighbors(b).slice(0, PAIR_CHECKS_PER_SIDE)) if (!significant(y, a)) checks.push([y, a]);
      ctx.log(`Проверяю пары по всей истории: ${checks.length}.`);
      await mapLimit(checks, 3, async ([x, y]) => ws.addTransfers(await between(x, y, 200, ctx)));
    }

    // ---------- 2. Раскрытие ближайших контрагентов ----------
    if (opts.maxHops >= 3) {
      const side = [...new Set([...topNeighbors(a), ...topNeighbors(b)])];
      ctx.log(`Раскрываю контрагентов: ${side.length}.`);
      let done = 0;
      await mapLimit(side, 3, async (x) => {
        await ws.profile(x, EXPAND_RECENT);
        done++;
        if (done % 5 === 0 || done === side.length) ctx.log(`Контрагентов проверено: ${done} из ${side.length}.`);
      });
      await ensureKinds(side.flatMap((x) => neighbors(x)));
    }

    // ---------- 3. Встречный поиск ----------
    /** Полупути длиной до 2 от root по значимым рёбрам: конечная точка → пути. */
    const halfPaths = (root: string, other: string, maxLen: number) => {
      const out = new Map<string, string[][]>([[root, [[root]]]]);
      const push = (p: string[]) => {
        const end = p[p.length - 1];
        (out.get(end) ?? out.set(end, []).get(end)!).push(p);
      };
      if (maxLen < 1) return out;
      for (const x of neighbors(root)) {
        if (!significant(root, x)) continue;
        if (x === other) {
          push([root, x]);
          continue;
        }
        if (!okMid(x)) continue;
        push([root, x]);
        if (maxLen < 2) continue;
        for (const z of neighbors(x)) {
          if (z === root || !significant(x, z)) continue;
          if (z === other || okMid(z)) push([root, x, z]);
        }
      }
      return out;
    };
    const leftLen = Math.ceil(opts.maxHops / 2);
    const left = halfPaths(a, b, leftLen);
    const right = halfPaths(b, a, opts.maxHops - leftLen);
    const found = new Map<string, string[]>();
    for (const [m, ls] of left) {
      const rs = right.get(m);
      if (!rs) continue;
      for (const l of ls) {
        for (const r of rs) {
          const nodes = [...l, ...r.slice(0, -1).reverse()];
          if (nodes.length < 2 || nodes.length - 1 > opts.maxHops || nodes[0] !== a || nodes[nodes.length - 1] !== b) continue;
          if (new Set(nodes).size !== nodes.length) continue;
          found.set(nodes.join('>'), nodes);
        }
      }
    }

    const degreeOf = (x: string) => degrees.get(x) ?? Math.max(3, neighbors(x).filter((n) => significant(x, n)).length);
    const rawScore = (nodes: string[]) => {
      let s = 1;
      for (let i = 1; i < nodes.length; i++) s *= strength(nodes[i - 1], nodes[i]);
      for (const x of nodes.slice(1, -1)) s *= degreePenalty(degreeOf(x));
      return s * HOP_DECAY ** Math.max(0, nodes.length - 2);
    };
    let candidates = [...found.values()].sort((p, q) => rawScore(q) - rawScore(p)).slice(0, MAX_CANDIDATES);

    // Промежуточные звенья лучших путей, которые ещё не проверялись, — не биржа ли это.
    const mids = [...new Set(candidates.slice(0, 60).flatMap((p) => p.slice(1, -1)))].filter((x) => !degrees.has(x)).slice(0, MID_PROFILE_LIMIT);
    if (mids.length > 0) {
      ctx.log(`Проверяю промежуточные кошельки: ${mids.length}.`);
      await mapLimit(mids, 3, (x) => ws.profile(x));
    }
    candidates = candidates.filter((p) => p.slice(1, -1).every((x) => !isHub(x)));

    const paths: LinkPath[] = [];
    for (const nodes of candidates.slice(0, MAX_PATHS * 2)) {
      const edgeIds = nodes.slice(1).map((n, i) => edgeIdOf(nodes[i], n));
      let type: ConnectionType = nodes.length === 2 ? 'direct' : 'via-intermediary';
      let score = rawScore(nodes);
      let reason: string;
      if (nodes.length === 2) {
        const f = flows(a, b);
        const parts: string[] = [];
        if (f.solOut > 0) parts.push(`A → B ${fmtSol(f.solOut)} SOL`);
        if (f.solIn > 0) parts.push(`B → A ${fmtSol(f.solIn)} SOL`);
        if (f.tokOut + f.tokIn > 0) parts.push(`переводов токенов: ${f.tokOut + f.tokIn}`);
        reason = `Прямые переводы между кошельками: ${parts.join(', ') || 'только пыль'}.`;
        if (fundingOf.get(edgeIds[0])) reason += ` ${fundingOf.get(edgeIds[0]) === a ? 'B — первый источник SOL кошелька A.' : 'A — первый источник SOL кошелька B.'}`;
      } else if (nodes.length === 3) {
        const x = nodes[1];
        const fa = flows(x, a);
        const fb = flows(x, b);
        const sideEntities = new Set([S.get(a)?.entity, S.get(b)?.entity].filter((e): e is string => !!e));
        const deposit = fa.in > 0 && fb.in > 0 && ws.depositPersonal(x, 0, sideEntities) ? await ws.depositOf(x) : null;
        if (deposit) {
          type = 'shared-deposit';
          score = Math.max(0.75, score);
          reason = `Общий депозитный адрес ${deposit === 'биржа' ? 'биржи' : deposit} ${shortAddr(x)}: на него отправляли средства оба кошелька (A — ${amountText(fa.solIn, fa.in)}, B — ${amountText(fb.solIn, fb.in)}). Такой адрес обычно принадлежит одному пользователю биржи.`;
        } else if (fa.out > 0 && fb.out > 0) {
          type = 'common-funder';
          reason = `Общий источник ${label(x)}: отправлял средства и A (${amountText(fa.solOut, fa.out)}), и B (${amountText(fb.solOut, fb.out)}).`;
        } else if (fa.in > 0 && fb.in > 0) {
          type = 'common-recipient';
          reason = `Общий получатель ${label(x)}: на него отправляли средства и A (${amountText(fa.solIn, fa.in)}), и B (${amountText(fb.solIn, fb.in)}).`;
        } else {
          reason = `Оба кошелька связаны переводами с ${label(x)}.`;
        }
        const deg = degreeOf(x);
        if (type !== 'shared-deposit' && deg > 20) reason += ` У посредника много контрагентов (${deg}), связь ослаблена.`;
      } else {
        reason = `Цепочка переводов: ${nodes.map(label).join(' — ')}.`;
      }
      paths.push({ type, nodes, edgeIds, score, reason });
    }

    // ---------- 3в. Плательщики комиссий ----------
    if (deps.loadPayers) {
      let ok = false;
      try {
        const [ra, rb] = await Promise.all([deps.loadPayers(a, ctx, opts.refresh), deps.loadPayers(b, ctx, opts.refresh)]);
        ok = ra && rb;
      } catch (e) {
        warnings.push(`Не удалось проверить плательщиков комиссий: ${e instanceof Error ? e.message.slice(0, 120) : e}.`);
      }
      if (ok) {
        const sideEntities = new Set([S.get(a)?.entity, S.get(b)?.entity].filter((e): e is string => !!e));
        const pa = new Map(deps.db.payersOf(a).filter((r) => r.n >= FEE_PAYER_MIN_TX).map((r) => [r.payer, r.n]));
        const pb = new Map(deps.db.payersOf(b).filter((r) => r.n >= FEE_PAYER_MIN_TX).map((r) => [r.payer, r.n]));
        for (const [payer, paid, n] of [[b, a, pa.get(b)], [a, b, pb.get(a)]] as const) {
          if (!n) continue;
          const id = ws.addFeesPaid(payer, paid, n);
          paths.push({ type: 'fee-payer', nodes: [a, b], edgeIds: [id], score: FEE_PAYER_SCORE, reason: `${payer === a ? 'A' : 'B'} оплачивал комиссии за ${txText(n)} кошелька ${paid === a ? 'A' : 'B'}.` });
        }
        const common = [...pa.keys()].filter((p) => pb.has(p) && p !== a && p !== b);
        await ensureKinds(common);
        for (const p of common) {
          if (await ws.isFeeRelayer(p, sideEntities)) continue;
          const edgeIds = [ws.addFeesPaid(p, a, pa.get(p)!), ws.addFeesPaid(p, b, pb.get(p)!)];
          paths.push({
            type: 'fee-payer',
            nodes: [a, p, b],
            edgeIds,
            score: COMMON_FEE_PAYER_SCORE,
            reason: `Общий плательщик комиссий ${label(p)}: платил за A (${txText(pa.get(p)!)}) и за B (${txText(pb.get(p)!)}).`,
          });
        }
      }
    }

    // ---------- 3б. Совместные покупки (по кэшу) ----------
    {
      const usable = (c: { wallet: string; mints: Set<string> }) => c.mints.size >= COBUY_MIN_MINTS;
      let cbA = deps.db.coBuysOf(a).filter(usable);
      let cbB = new Map(deps.db.coBuysOf(b).filter(usable).map((c) => [c.wallet, c]));
      await ensureKinds([...cbA.map((c) => c.wallet), ...cbB.keys()]);
      // Снайпинг: совместные покупки с трейдерами многих разных имён — не бандл, такие совпадения не учитываем.
      const sniper = (list: ReadonlyArray<{ wallet: string }>, self: string) => {
        const own = S.get(self)?.entity;
        return new Set(list.filter((c) => S.has(c.wallet) && S.get(c.wallet)!.entity !== own).map((c) => S.get(c.wallet)!.entity)).size > COBUY_MAX_ENTITIES;
      };
      for (const [list, self, n] of [[cbA, a, 'A'], [[...cbB.values()], b, 'B']] as const) {
        if (sniper(list, self)) warnings.push(`Кошелёк ${n} покупает в одном слоте с трейдерами многих имён из списка — похоже на снайпинг; его совместные покупки не учитываются.`);
      }
      if (sniper(cbA, a)) cbA = [];
      if (sniper([...cbB.values()], b)) cbB = new Map();
      for (const c of cbA) {
        if (c.wallet === b) {
          const id = ws.addCoBuy(a, b, c);
          paths.push({
            type: 'co-buy',
            nodes: [a, b],
            edgeIds: [id],
            score: coBuyScore(c.mints.size),
            reason: `A и B покупали одни и те же токены в одном слоте разными транзакциями: ${tokensText(c.mints.size)}, ${slotsText(c.slots.size)}. Так обычно работают бандлы одного владельца.`,
          });
          continue;
        }
        const other = cbB.get(c.wallet);
        if (!other || !okMid(c.wallet)) continue;
        const nodes = [a, c.wallet, b];
        const edgeIds = [ws.addCoBuy(a, c.wallet, c), ws.addCoBuy(c.wallet, b, other)];
        paths.push({
          type: 'co-buy',
          nodes,
          edgeIds,
          score: coBuyScore(c.mints.size) * coBuyScore(other.mints.size) * HOP_DECAY,
          reason: `Оба покупали токены в одном слоте с ${label(c.wallet)}: A — ${tokensText(c.mints.size)}, B — ${tokensText(other.mints.size)}. Похоже на один бандл.`,
        });
      }
    }

    // ---------- 4. Цепочки финансирования ----------
    ctx.log('Сравниваю цепочки финансирования…');
    const chainOf = async (start: string, h0: History): Promise<string[]> => {
      const chain = [start];
      let cur = start;
      let h = h0;
      for (let level = 0; level < CHAIN_LEVELS; level++) {
        const f = findFunder(cur, h);
        if (!f || chain.includes(f.from)) break;
        fundingOf.set(edgeIdOf(cur, f.from), cur);
        chain.push(f.from);
        await ensureKinds([f.from]);
        if (f.from === a || f.from === b || isHub(f.from)) break;
        await ws.profile(f.from);
        if (isHub(f.from) || S.has(f.from)) break;
        cur = f.from;
        h = await hist(cur, 0, OLDEST_ROWS);
      }
      return chain;
    };
    const [chainA, chainB] = await Promise.all([chainOf(a, hA), chainOf(b, hB)]);
    const meet = chainA.find((x, i) => i > 0 && chainB.includes(x) && !isHub(x));
    const meetDirect = chainA.includes(b) ? b : chainB.includes(a) ? a : null;
    const chainPath = (() => {
      if (meetDirect === b) return chainA.slice(0, chainA.indexOf(b) + 1);
      if (meetDirect === a) return chainB.slice(0, chainB.indexOf(a) + 1).reverse();
      if (!meet) return null;
      return [...chainA.slice(0, chainA.indexOf(meet) + 1), ...chainB.slice(0, chainB.indexOf(meet)).reverse()];
    })();
    if (chainPath && chainPath.length > 2 && !paths.some((p) => p.nodes.join('>') === chainPath.join('>'))) {
      let score = 1;
      for (let i = 1; i < chainPath.length; i++) score *= strength(chainPath[i - 1], chainPath[i]);
      score *= HOP_DECAY ** (chainPath.length - 2);
      const top = meetDirect ?? meet!;
      const reason =
        meetDirect != null
          ? `${top === a ? 'A' : 'B'} стоит в цепочке финансирования другого кошелька: ${chainPath.map(label).join(' → ')}.`
          : `Общий источник выше по цепочкам финансирования — ${label(top)}: ${chainA.slice(0, chainA.indexOf(top) + 1).map(label).join(' ← ')} и ${chainB.slice(0, chainB.indexOf(top) + 1).map(label).join(' ← ')}.`;
      paths.push({ type: 'funding-chain', nodes: chainPath, edgeIds: chainPath.slice(1).map((n, i) => edgeIdOf(chainPath[i], n)), score, reason });
    } else if (chainPath && chainPath.length === 2) {
      const p = paths.find((q) => q.nodes.length === 2);
      if (p) p.score = Math.max(p.score, strength(a, b));
    }
    for (const [chain, n] of [[chainA, 'A'], [chainB, 'B']] as const) {
      const end = chain[chain.length - 1];
      const hub = chain.length > 1 ? hubs.get(end) : undefined;
      if (hub?.category === 'cex') warnings.push(`Кошелёк ${n} пополнен с биржи ${hub.label}: выше цепочку проследить нельзя.`);
      else if (hub?.category === 'service') warnings.push(`Кошелёк ${n} пополнен с адреса, похожего на биржу или сервис (${shortAddr(end)}): выше цепочку проследить нельзя.`);
    }

    // ---------- 5. Итог ----------
    paths.sort((p, q) => q.score - p.score);
    paths.splice(MAX_PATHS);
    // Итоговая сила — по путям без общих промежуточных звеньев, чтобы один посредник не считался дважды.
    const used = new Set<string>();
    const independent: number[] = [];
    for (const p of paths) {
      const mid = p.nodes.slice(1, -1);
      if (mid.some((x) => used.has(x))) continue;
      mid.forEach((x) => used.add(x));
      independent.push(p.score);
      if (independent.length >= 5) break;
    }
    const score = combineScores(independent);

    const nodeKinds = new Map<string, NodeKind>([
      [a, 'target'],
      [b, 'pair'],
    ]);
    const edgeIds = new Set<string>();
    for (const p of paths) {
      for (const x of p.nodes.slice(1, -1)) ws.setKind(nodeKinds, x, p.type === 'funding-chain' ? 'funder' : S.has(x) ? 'tracked' : 'intermediary');
      p.edgeIds.forEach((id) => edgeIds.add(id));
    }
    for (const chain of [chainA, chainB]) {
      chain.slice(1).forEach((x, i) => {
        ws.setKind(nodeKinds, x, isHub(x) ? 'hub' : 'funder');
        edgeIds.add(edgeIdOf(chain[i], x));
      });
    }
    const skipped = [...hubs.keys()].filter((x) => neighbors(a).includes(x) || neighbors(b).includes(x)).length;
    if (skipped > 0) warnings.push(`Биржи и сервисы среди контрагентов (${skipped}) пропущены: связь через них ничего не говорит о владельце.`);
    if (paths.length === 0) warnings.push(`В пределах ${opts.maxHops} шагов и цепочек финансирования (до ${CHAIN_LEVELS} уровней) связь не найдена.`);
    if (ws.infraTracked.size > 0) warnings.push(`Служебные адреса из списка (${[...ws.infraTracked].map(nameOf).join(', ')}) не считаются связью.`);

    const { nodes, edges } = ws.buildGraph(nodeKinds, edgeIds, new Map(), a);
    ctx.log(`Готово: путей ${paths.length}.`);
    return {
      a,
      b,
      aTracked: S.get(a) ?? null,
      bTracked: S.get(b) ?? null,
      generatedAt: Date.now(),
      options: opts,
      score,
      paths,
      nodes,
      edges,
      warnings,
      stats: {
        provider: deps.provider.name,
        transfersLoaded: ws.transfersLoaded(),
        walletsFetched: ws.fetched.size,
        apiCalls: ctx.meter.calls - callsBefore,
        creditsEstimate: ctx.meter.credits,
        durationMs: Date.now() - startedAt,
        truncated: hA.truncated || hB.truncated,
      },
    };
  }

  return { link };
}
