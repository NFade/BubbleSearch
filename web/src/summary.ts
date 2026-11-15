import type { AnalyzeResult, ConnectionType, GraphNode, GroupResult, LinkResult } from '../../shared/types.ts';
import { fmtSol, isExchangeHub, plural, scoreLabel, shortAddr } from './util.ts';

/** Как называть тип связи в середине предложения. */
const TYPE_PHRASE: Record<ConnectionType, string> = {
  direct: 'прямые переводы',
  'common-funder': 'общий источник пополнения',
  'common-recipient': 'общий получатель средств',
  'shared-deposit': 'общий депозитный адрес биржи',
  'co-buy': 'покупки одних токенов в одном слоте',
  'via-intermediary': 'связь через посредника',
  'funding-chain': 'общая цепочка финансирования',
  'fee-payer': 'один кошелёк оплачивал комиссии за другой',
};

function nameOfNode(nodes: GraphNode[], addr: string): string {
  const n = nodes.find((x) => x.id === addr);
  if (n?.kind === 'tracked') return `«${n.label}»`;
  if (n?.hubLabel) return n.hubLabel;
  return shortAddr(addr);
}

/** Краткая сводка результата одного кошелька, 2–4 предложения. */
export function summarizeSingle(r: AnalyzeResult): string {
  const parts: string[] = [];
  const top = r.entities[0];
  if (r.targetTracked) parts.push(`Кошелёк есть в вашем списке: «${r.targetTracked.name}».`);

  if (top) {
    const strong = scoreLabel(top.score);
    const lead =
      strong === 'сильная'
        ? `Кошелёк, скорее всего, принадлежит ${top.entityName}`
        : strong === 'средняя'
          ? `Кошелёк, возможно, связан с ${top.entityName}`
          : `Найдена только слабая связь с ${top.entityName}`;
    const n = top.wallets.length;
    const found = `${plural(n, ['найден', 'найдено', 'найдено'])} ${n} ${plural(n, ['кошелёк', 'кошелька', 'кошельков'])} этого имени`;
    // Сильнейшая связь внутри имени.
    const conns = r.connections.filter((c) => top.wallets.includes(c.wallet.address));
    const best = conns.reduce<(typeof conns)[number] | null>((m, c) => (!m || c.score > m.score ? c : m), null);
    const bp = best?.paths[0];
    let why = '';
    if (best && bp) {
      why =
        bp.type === 'direct' && best.totalSol > 0
          ? `прямые переводы на ${fmtSol(best.totalSol)} SOL`
          : TYPE_PHRASE[bp.type] ?? bp.type;
    }
    parts.push(`${lead}: ${found}${why ? `, сильнейшая связь — ${why}` : ''}.`);
  } else {
    parts.push('Связей с кошельками из вашего списка не найдено.');
  }

  // Первое пополнение цели: самое раннее ребро с fundingOf = цель.
  const fund = r.edges
    .filter((e) => e.fundingOf === r.target)
    .sort((a, b) => (a.firstTime ?? Infinity) - (b.firstTime ?? Infinity))[0];
  if (fund) {
    const from = fund.source === r.target ? fund.target : fund.source;
    const sol = fund.source === r.target ? fund.solBackward : fund.solForward;
    const who = nameOfNode(r.nodes, from);
    const named = r.nodes.some((n) => n.id === from && (n.kind === 'tracked' || n.hubLabel));
    const place = named ? who : `адреса ${who}`;
    parts.push(`Первое пополнение пришло с ${place}${sol > 0 ? ` (${fmtSol(sol)} SOL)` : ''}.`);
  }

  const sib = (r.siblings ?? []).length;
  if (sib > 0) {
    parts.push(
      `Вероятно, ещё ${sib} ${plural(sib, ['свой кошелёк', 'своих кошелька', 'своих кошельков'])} не из списка.`,
    );
  }

  const hubs = r.nodes.filter(isExchangeHub).length;
  if (hubs > 0) parts.push(`Биржи и сервисы (${hubs}) не учитывались.`);

  if (!top && sib === 0 && !fund && r.options.depth < 3) {
    parts.push('Попробуйте глубину «До трёх шагов».');
  }
  return parts.slice(0, 4).join(' ');
}

/** Краткая сводка связи двух кошельков. */
export function summarizeLink(l: LinkResult): string {
  const nm = (addr: string) => {
    if (addr === l.a) return l.aTracked ? `«${l.aTracked.name}»` : shortAddr(addr);
    if (addr === l.b) return l.bTracked ? `«${l.bTracked.name}»` : shortAddr(addr);
    return nameOfNode(l.nodes, addr);
  };
  const best = l.paths[0];
  if (!best) {
    return `Связь между ${nm(l.a)} и ${nm(l.b)} не найдена в пределах ${l.options.maxHops} шагов. ${
      l.options.maxHops < 4 ? 'Попробуйте увеличить число шагов.' : 'Скорее всего, кошельки не связаны или связь скрыта за биржами.'
    }`;
  }
  const lead = `Связь ${scoreLabel(l.score)} (${Math.round(l.score * 100)}%)`;
  let how: string;
  if (best.nodes.length === 2) {
    const e = l.edges.find((x) => x.id === best.edgeIds[0]);
    if (e?.fundingOf) {
      const funded = e.fundingOf;
      const funder = funded === e.source ? e.target : e.source;
      const sol = funded === e.target ? e.solForward : e.solBackward;
      how = `${nm(funder)} — первый источник SOL кошелька ${nm(funded)}${sol > 0 ? ` (${fmtSol(sol)} SOL)` : ''}`;
    } else if (best.type === 'co-buy') {
      how = 'кошельки покупали одни и те же токены в одном слоте';
    } else if (e && e.solForward + e.solBackward > 0) {
      how = `между ними есть прямые переводы на ${fmtSol(e.solForward + e.solBackward)} SOL`;
    } else {
      how = TYPE_PHRASE[best.type] ?? best.type;
    }
  } else {
    const mid = best.nodes.length - 2;
    how = `${TYPE_PHRASE[best.type]}, ${mid} ${plural(mid, ['посредник', 'посредника', 'посредников'])} на пути`;
  }
  const out = [`${lead}: ${how}.`];
  const rest = l.paths.length - 1;
  if (rest > 0) {
    out.push(`Ещё ${rest} ${plural(rest, ['путь', 'пути', 'путей'])}${best.nodes.length === 2 ? ' через посредников' : ''}.`);
  }
  return out.join(' ');
}

/** Название кластера: самое частое имя сущности среди его кошельков. */
export function clusterName(g: GroupResult, members: string[]): string {
  const count = new Map<string, number>();
  for (const a of members) {
    const n = g.nodes.find((x) => x.id === a);
    const k = n?.entityName ?? n?.label ?? shortAddr(a);
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  return [...count.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? '—';
}

/** «3 кластера: Yugi (4 кошелька), …; связей между выбранными: N». */
export function summarizeGroup(g: GroupResult): string {
  const k = g.clusters.length;
  const parts = g.clusters.map((c) => `${clusterName(g, c)} (${c.length} ${plural(c.length, ['кошелёк', 'кошелька', 'кошельков'])})`);
  const l = g.links.length;
  return `${k} ${plural(k, ['кластер', 'кластера', 'кластеров'])}: ${parts.join(', ')}; связей между выбранными: ${l}.`;
}
