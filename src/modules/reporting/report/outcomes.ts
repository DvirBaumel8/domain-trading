// v4.0.0 (CR-044 item 2, CR-045 item 3, CR-046 item 4, CR-049 item 5): the life of each bought name from idea to outcome, the monthly interest report by card feature,
// passed against borderline, venue against venue, and the quarterly renewal cost against sales. Read-only; no walk-away or floor appears here.
import { sql, type Kysely } from 'kysely';
import { addMonthsClamped, dayNumber, idtDay, toJerusalemIso } from '../../../core/dates.js';
import { pair } from '../../../core/money.js';
import type { Database } from '../../../db/types.js';
import { activeSelectionSettings } from '../../selection/index.js';

const VENUES = ['afternic', 'sedo', 'sellerhub'] as const;
const lengthBand = (n: number): string => (n <= 8 ? '1-8' : n <= 12 ? '9-12' : n <= 16 ? '13-16' : '17+');

interface Card { lane: string | null; tier: string | null; words: number | null; sld_len: number; length_band: string; lookalikes_registered: number | null; lookalikes_in_use: number | null; pack_id: string | null }
interface Stat { views: number; leads: number; inquiries: number; offers: number }
const zero = (): Stat => ({ views: 0, leads: 0, inquiries: 0, offers: 0 });

interface Row {
  domain: string; status: string; category: string | null; horizon: string; screening_group: string | null; buy_date: string | null; days_held: number | null;
  card: Card; sell_or_drop_by: string | null; drop_date: string | null; expiry_date: string | null; renewals_used: number;
  cost_cents: number | null; renewal_paid_cents: number; sold: { price_cents: number; sold_at: string; venue: string } | null;
  offers_logged: number; stats: Stat; stats_by_venue: Record<string, Stat>; inquiries_6m: number; inquiries_12m: number; listing_changes: number;
  interest: boolean;
}

async function build(db: Kysely<Database>, now: Date): Promise<{ rows: Row[]; statsAll: { domain: string; month: string; venue: string; s: Stat }[]; judgeMonths: number }> {
  const today = idtDay(now);
  const sel = (await activeSelectionSettings(db)).values;
  const doms = await db.selectFrom('domains').selectAll().where('status', '!=', 'pending_purchase').orderBy('domain').execute();
  const packs = await sql<{ domain: string; id: string; content: any }>`select distinct on (domain) domain, id, content from screening_packs order by domain, version desc`.execute(db); // eslint-disable-line @typescript-eslint/no-explicit-any
  const packOf = new Map(packs.rows.map((p) => [p.domain, p]));
  const stats = await db.selectFrom('portfolio_stats').selectAll().orderBy('id').execute();
  const offers = await sql<{ domain_id: number; n: string }>`select domain_id, count(*)::text as n from offers group by domain_id`.execute(db);
  const offersOf = new Map(offers.rows.map((o) => [o.domain_id, Number(o.n)]));
  const sales = await sql<{ domain_id: number; price: number; at: Date; venue: string }>`select domain_id, sale_price_cents as price, sold_at as at, venue from sales`.execute(db);
  const saleOf = new Map(sales.rows.map((s) => [s.domain_id, s]));
  const renewals = await sql<{ domain_id: number; c: string }>`select domain_id, (-sum(amount_cents))::text as c from ledger_entries where type = 'renewal' group by domain_id`.execute(db);
  const renewOf = new Map(renewals.rows.map((r) => [r.domain_id, Number(r.c)]));
  const changes = await sql<{ domain_id: number; n: string }>`select domain_id, count(*)::text as n from listing_history group by domain_id`.execute(db);
  const changesOf = new Map(changes.rows.map((c) => [c.domain_id, Number(c.n)]));
  const latestLook = await sql<{ domain: string; n: number | null }>`
    select distinct on (d.domain) d.domain, (pc.details->>'in_use_n')::int as n from portfolio_checks pc join domains d on d.id = pc.domain_id where pc.kind = 'lookalikes' and pc.status = 'ok' order by d.domain, pc.id desc`.execute(db);
  const lookNow = new Map(latestLook.rows.map((l) => [l.domain, l.n]));

  const statsAll: { domain: string; month: string; venue: string; s: Stat }[] = [];
  const byDomain = new Map<string, typeof stats>();
  for (const s of stats) {
    statsAll.push({ domain: s.domain, month: s.month, venue: s.venue, s: { views: s.views ?? 0, leads: s.leads ?? 0, inquiries: s.inquiries ?? 0, offers: s.offers ?? 0 } });
    byDomain.set(s.domain, [...(byDomain.get(s.domain) ?? []), s]);
  }
  const rows: Row[] = doms.map((d) => {
    const p = packOf.get(d.domain);
    const gates: { check: string; fields: any }[] = Array.isArray(p?.content?.gates) ? p!.content.gates : []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const g = (id: string) => gates.find((x) => x.check === id)?.fields ?? null;
    const sld = d.domain.replace(/\.[a-z.]+$/, '');
    const look = g('lookalikes')?.lookalikes ?? null;
    const card: Card = {
      lane: p?.content?.lane ?? null, tier: g('tier')?.fired ?? g('tier')?.tier ?? null, words: g('form')?.word_count ?? null, sld_len: sld.length, length_band: lengthBand(sld.length),
      lookalikes_registered: look?.registered_n ?? null, lookalikes_in_use: lookNow.get(d.domain) ?? look?.in_use_n ?? null, pack_id: p?.id ?? null,
    };
    const ss = byDomain.get(d.domain) ?? [];
    const total = zero();
    const perVenue: Record<string, Stat> = {};
    const buyMonth = d.buy_date ? d.buy_date.slice(0, 7) : null;
    const m6 = buyMonth ? addMonthsClamped(`${buyMonth}-01`, 6).slice(0, 7) : null;
    const m12 = buyMonth ? addMonthsClamped(`${buyMonth}-01`, 12).slice(0, 7) : null;
    let i6 = 0; let i12 = 0;
    for (const s of ss) {
      const v = perVenue[s.venue] ?? (perVenue[s.venue] = zero());
      for (const t of [total, v]) { t.views += s.views ?? 0; t.leads += s.leads ?? 0; t.inquiries += s.inquiries ?? 0; t.offers += s.offers ?? 0; }
      const q = (s.inquiries ?? 0) + (s.leads ?? 0);
      if (m6 && s.month <= m6) i6 += q;
      if (m12 && s.month <= m12) i12 += q;
    }
    const sale = saleOf.get(d.id);
    const offersLogged = offersOf.get(d.id) ?? 0;
    return {
      domain: d.domain, status: d.status, category: d.category, horizon: d.horizon, screening_group: d.screening_group, buy_date: d.buy_date,
      days_held: d.buy_date ? Math.max(0, dayNumber(sale ? idtDay(sale.at) : d.sold_at ? idtDay(d.sold_at) : today) - dayNumber(d.buy_date)) : null,
      card, sell_or_drop_by: d.sell_or_drop_by, drop_date: d.drop_date, expiry_date: d.expiry_date, renewals_used: d.renewals_used,
      cost_cents: d.cost_cents, renewal_paid_cents: renewOf.get(d.id) ?? 0,
      sold: sale ? { price_cents: sale.price, sold_at: toJerusalemIso(sale.at), venue: sale.venue } : null,
      offers_logged: offersLogged, stats: total, stats_by_venue: perVenue, inquiries_6m: i6, inquiries_12m: i12, listing_changes: changesOf.get(d.id) ?? 0,
      interest: offersLogged > 0 || total.inquiries + total.leads + total.offers > 0 || sale !== undefined,
    };
  });
  return { rows, statsAll, judgeMonths: sel.portfolio.judge_sales_months };
}

const view = (r: Row) => ({
  ...r, ...pair('cost', r.cost_cents), ...pair('renewal_paid', r.renewal_paid_cents),
  sold: r.sold ? { ...r.sold, ...pair('price', r.sold.price_cents) } : null,
});

/** GET /portfolio/outcomes: one row per name. */
export async function outcomes(db: Kysely<Database>, now: Date) {
  const { rows, judgeMonths } = await build(db, now);
  return { as_of: toJerusalemIso(now), judge_sales_after_months: judgeMonths, names: rows.map((r) => ({ ...view(r), sale_judged: r.buy_date ? addMonthsClamped(r.buy_date, judgeMonths) <= idtDay(now) : false })) };
}

const featureOf: Record<string, (r: Row) => string> = {
  lane: (r) => r.card.lane ?? 'unknown', word_count: (r) => (r.card.words === null ? 'unknown' : String(r.card.words)), length_band: (r) => r.card.length_band,
  tier: (r) => r.card.tier ?? 'unknown', lookalikes_registered: (r) => (r.card.lookalikes_registered === null ? 'unknown' : String(r.card.lookalikes_registered)),
  category: (r) => r.category ?? 'unknown',
};

function groupBy(rows: Row[], key: (r: Row) => string) {
  const g = new Map<string, Row[]>();
  for (const r of rows) g.set(key(r), [...(g.get(key(r)) ?? []), r]);
  return [...g].sort((a, b) => a[0].localeCompare(b[0])).map(([k, rs]) => ({
    value: k, names: rs.length, with_interest: rs.filter((r) => r.interest).length, without_interest: rs.filter((r) => !r.interest).length,
    views: rs.reduce((s, r) => s + r.stats.views, 0), leads: rs.reduce((s, r) => s + r.stats.leads + r.stats.inquiries, 0), offers: rs.reduce((s, r) => s + r.stats.offers + r.offers_logged, 0),
    sales: rs.filter((r) => r.sold).length,
  }));
}

/** GET /portfolio/outcomes/monthly[?month=YYYY-MM]: interest against none by card feature, passed against borderline, venue against venue. */
export async function outcomesMonthly(db: Kysely<Database>, now: Date, month: string | null) {
  const { rows, statsAll, judgeMonths } = await build(db, now);
  const m = month ?? idtDay(now).slice(0, 7);
  // interest of the month: any stats row of that month with leads, inquiries or offers
  const inMonth = statsAll.filter((s) => s.month === m);
  const interestIn = new Set(inMonth.filter((s) => s.s.leads + s.s.inquiries + s.s.offers > 0).map((s) => s.domain));
  const monthRows = rows.filter((r) => r.status !== 'pending_purchase').map((r) => ({ ...r, interest: interestIn.has(r.domain) }));
  const stat = (rs: typeof inMonth) => rs.reduce((a, s) => ({ views: a.views + s.s.views, leads: a.leads + s.s.leads + s.s.inquiries, offers: a.offers + s.s.offers }), { views: 0, leads: 0, offers: 0 });
  const groups = ['passed', 'borderline'].map((g) => {
    const names = rows.filter((r) => r.screening_group === g);
    const set = new Set(names.map((r) => r.domain));
    return {
      group: g, names: names.length, with_interest: names.filter((r) => interestIn.has(r.domain)).length,
      ...stat(inMonth.filter((s) => set.has(s.domain))),
      inquiries_6m: names.reduce((s, r) => s + r.inquiries_6m, 0), inquiries_12m: names.reduce((s, r) => s + r.inquiries_12m, 0),
      sales: names.filter((r) => r.sold).length,
      sales_judged_after_months: judgeMonths, names_old_enough_to_judge_sales: names.filter((r) => r.buy_date && addMonthsClamped(r.buy_date, judgeMonths) <= idtDay(now)).length,
    };
  });
  const byVenue = VENUES.map((v) => {
    const rs = statsAll.filter((s) => s.venue === v);
    const rm = rs.filter((s) => s.month === m);
    return { venue: v, month: stat(rm), all_time: stat(rs), sales: rows.filter((r) => r.sold?.venue === v).length };
  });
  const perName = rows.map((r) => ({
    domain: r.domain, screening_group: r.screening_group,
    venues: Object.fromEntries(VENUES.map((v) => { const x = statsAll.filter((s) => s.domain === r.domain && s.venue === v && s.month === m); return [v, { ...stat(x), sales: r.sold?.venue === v ? 1 : 0 }]; })),
  }));
  return {
    month: m, as_of: toJerusalemIso(now),
    by_feature: Object.fromEntries(Object.entries(featureOf).map(([k, f]) => [k, groupBy(monthRows, f)])),
    passed_vs_borderline: groups, by_venue: byVenue, per_name_and_venue: perName,
    venue_comparison_after_12_months: rows.some((r) => r.buy_date && addMonthsClamped(r.buy_date, 12) <= idtDay(now)) ? byVenue.map((v) => ({ venue: v.venue, ...v.all_time, sales: v.sales })) : null,
  };
}

/** GET /portfolio/outcomes/quarterly: renewal cost against sales per calendar quarter (IDT days). */
export async function outcomesQuarterly(db: Kysely<Database>) {
  const q = (col: string) => sql.raw(`to_char(date_trunc('quarter', ${col}), 'YYYY') || '-Q' || to_char(date_trunc('quarter', ${col}), 'Q')`);
  const ren = await sql<{ q: string; c: string; n: string }>`
    select ${q('occurred_on')} as q, (-sum(amount_cents))::text as c, count(*)::text as n from ledger_entries where type = 'renewal' group by 1`.execute(db);
  const reg = await sql<{ q: string; c: string }>`select ${q('occurred_on')} as q, (-sum(amount_cents))::text as c from ledger_entries where type = 'registration' group by 1`.execute(db);
  const sale = await sql<{ q: string; c: string; n: string }>`
    select ${q("(sold_at at time zone 'Asia/Jerusalem')::date")} as q, sum(sale_price_cents)::text as c, count(*)::text as n from sales group by 1`.execute(db);
  const keys = [...new Set([...ren.rows, ...reg.rows, ...sale.rows].map((r) => r.q))].sort();
  return {
    quarters: keys.map((k) => {
      const r = ren.rows.find((x) => x.q === k); const g = reg.rows.find((x) => x.q === k); const s = sale.rows.find((x) => x.q === k);
      const renewal = Number(r?.c ?? 0); const sales = Number(s?.c ?? 0);
      return { quarter: k, renewals: Number(r?.n ?? 0), ...pair('renewal_cost', renewal), ...pair('registration_cost', Number(g?.c ?? 0)), sales: Number(s?.n ?? 0), ...pair('sales_total', sales), ...pair('sales_minus_renewals', sales - renewal) };
    }),
  };
}
