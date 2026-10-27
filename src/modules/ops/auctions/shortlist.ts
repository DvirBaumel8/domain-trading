// v5.45.0 (G-127): the daily auction shortlist (datasave step `auctionShortlist`) and its two reads (GET /auctions/shortlist, GET /auctions/funnel).
// Flow: the in-range GoDaddy auctions of the newest data date that end inside the horizon -> hard filters offline (name rules, owned, open bid plan, no headroom)
// -> auction score v1 without the other endings -> brand typo filter (BRAND-TYPO-2 against the stored list) -> the top names get their five other endings asked (RDAP,
// 2 minute budget) -> final score -> the top `shortlist_size` are stored for the data date -> an automatic pre-bid for the top `shortlist_prebid_n` that do not fail.
// Rules, score and test ids: docs/internal/auctions.md "Shortlist". It calls no registrar or marketplace; the only outside calls are RDAP and the pre-bid checks' own sources.
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import { chunks } from '../../../core/chunks.js';
import { addDays, idtDay, isRealDate, toJerusalemIso } from '../../../core/dates.js';
import { pair } from '../../../core/money.js';
import type { Database } from '../../../db/types.js';
import { AppError } from '../../../http/errors.js';
import { askEndingsFor, endingDue, endingsState, liftTable, loadLiftModel, scoreLift, type LiftInput, type LiftModel, type LiftScore, type OtherEnding } from '../../engine/index.js';
import { activeSelectionSettings, brandMatches, closeoutNameChecker, commonWord, latestPopularity, splitV2, type PrebidCheck, type ScreeningDeps, type SplitV2Table } from '../../selection/index.js';
import { currentTerms } from '../closeouts/filters.js';
import { storePrebid } from './prebid-store.js';
import { adultFilter } from './adult-terms.js';
import { personName } from './person-names.js';
import { AUCTION_SCORE_VERSION, AUCTION_SCORE_VERSION_V4, fieldPercentile, maxBidRule, positionFactor, scoreAuction, type EndingsKnown, type ScoreInput, type ScoreResult } from './shortlist-score.js';
import { pickControl, recordOutcomes, updateOutcomes, type OutcomeRow } from './outcomes.js';

export const ENDINGS_BUDGET_MS = 2 * 60_000;
export const PREBID_BUDGET_MS = 8 * 60_000;
/** A stored pre-bid younger than this is reused by a second run of the step on the same day. */
export const PREBID_REUSE_MS = 12 * 3_600_000;
const VENUE = 'godaddy' as const;
const DAY = 86_400_000;

export interface ShortlistDeps {
  db: Kysely<Database>;
  now: () => number;
  /** Without it the endings and the automatic pre-bid are skipped (reported in the summary). */
  screening?: ScreeningDeps;
  log?: { warn: (obj: unknown, msg?: string) => void };
  endingsBudgetMs?: number;
  prebidBudgetMs?: number;
}

interface Cand {
  domain: string; sld: string; end_time: Date; auction_type: string | null; price_cents: number; bids: number; domain_age: number | null; valuation_cents: number | null; pageviews: number | null; developed_tlds: number | null; exact_match_tlds: number | null;
  words: string[]; max_bid_cents: number; pre: ScoreResult; flags: string[];
}

const failReason = (checks: readonly PrebidCheck[]): string => {
  const f = checks.find((c) => c.result === 'FAIL');
  return f ? `${f.id}: ${f.reason ?? 'failed'}` : 'FAIL';
};

/** The lift score of a name from the stored table: length and word count always, the other endings only when some were asked (no endings = those patterns are skipped). */
export function liftOf(model: { bins: LiftModel['bins'] }, table: SplitV2Table, sld: string, endings: EndingsKnown): LiftScore {
  const asked = (['net', 'co', 'org', 'io', 'ai'] as const).filter((t) => endings[t] === true || endings[t] === false);
  const reg = asked.filter((t) => endings[t] === true).length;
  const words = /^[a-z]+$/.test(sld) ? splitV2(sld, table).length : 0;
  // v5.49.0 (P2): registered_share is served as unknown. It was trained on the 20 sibling names of CR-002, not on the five own endings (both lift features came from the same five lookups,
  // so one registered ending gave the capped +2 twice). A bin with no row at all (1 word, 4+ words outside the seed) counts 0, not the pattern's lowest lift.
  const input: LiftInput = { len: sld.length, words: words > 0 ? words : null, endings_before: asked.length > 0 ? reg : null, registered_share: null, past_site: null };
  return scoreLift(model.bins, input, { emptyBinZero: true });
}

export async function runAuctionShortlist(deps: ShortlistDeps): Promise<Record<string, unknown>> {
  const { db, now } = deps;
  const nowMs = now();
  const cfg = await db.selectFrom('settings').select(['s8_max_price_cents', 'shortlist_horizon_hours', 'shortlist_size', 'shortlist_endings_n', 'shortlist_prebid_n', 'shortlist_expected_resale_cents', 'shortlist_sale_chance_bp', 'shortlist_renewal_cents']).executeTakeFirstOrThrow();
  const latest = await db.selectFrom('godaddy_auctions_live').select((eb) => eb.fn.max('data_date').as('d')).executeTakeFirst();
  const dataDate = latest?.d ? String(latest.d).slice(0, 10) : null;
  // v5.49.0 (P4): first the end states of the open paper-trading rows, from the snapshot the inventory step just stored (a failure here never stops the shortlist)
  let outcomesUpdate: Record<string, unknown> | null = null;
  try { outcomesUpdate = { ...(await updateOutcomes(db, nowMs)) }; } catch (e) { outcomesUpdate = { error: (e as Error).message }; deps.log?.warn({ err: (e as Error).message }, 'auction shortlist: outcomes update failed'); }
  // v5.47.0 (F5): the trained lift table scores the name part (auction-v3); without one the v2 hand shape + endings part stays
  let lift: LiftModel | null = null;
  let liftSplit: SplitV2Table | null = null;
  try { lift = await loadLiftModel(db); if (lift) liftSplit = await liftTable(db); } catch (e) { lift = null; deps.log?.warn({ err: (e as Error).message }, 'auction shortlist: lift table not loaded, using auction-v2'); }
  const liftFor = (sld: string, endings: EndingsKnown): LiftScore | null => (lift && liftSplit ? liftOf(lift, liftSplit, sld, endings) : null);
  const v4 = lift !== null && liftSplit !== null;
  const inputOf = (c: Cand, endings: EndingsKnown, pct: number | null, fieldN: number | null): ScoreInput => ({
    words: c.words.length > 0 ? c.words : [c.sld], letters: c.sld.length, price_cents: c.price_cents, max_bid_cents: c.max_bid_cents, bids: c.bids, domain_age: c.domain_age, pageviews: c.pageviews, endings, lift: liftFor(c.sld, endings),
    ...(v4 ? { v4: { name_pct: pct, field_n: fieldN, developed_tlds: c.developed_tlds, exact_match_tlds: c.exact_match_tlds } } : {}),
  });
  const out: Record<string, unknown> = { status: 'ok', data_date: dataDate, score_version: lift ? AUCTION_SCORE_VERSION_V4 : AUCTION_SCORE_VERSION, lift_model: lift ? { id: Number(lift.id), auc: lift.auc, source: lift.source } : null, horizon_hours: cfg.shortlist_horizon_hours, size: cfg.shortlist_size, outcomes_update: outcomesUpdate };
  if (dataDate === null) return { ...out, status: 'no_data', shortlisted_n: 0 };

  const rows = (await sql<{ domain: string; end_time: Date; auction_type: string | null; price_cents: number; bid_count: number; domain_age: number | null; valuation_cents: number | null; pageviews: number | null; developed_tlds: number | null; exact_match_tlds: number | null }>`
    select domain, end_time, auction_type, price_cents, bid_count, domain_age, valuation_cents, pageviews, developed_tlds, exact_match_tlds from godaddy_auctions_live
    where data_date = ${dataDate}::date and end_time > ${new Date(nowMs)} and end_time <= ${new Date(nowMs + cfg.shortlist_horizon_hours * 3_600_000)}
      and price_cents <= ${cfg.s8_max_price_cents} and bid_count >= 1 and domain ~ '^[a-z0-9-]+[.]com$'`.execute(db)).rows;
  out.candidates_n = rows.length;

  // ---- hard filters, offline
  const [ownedRows, planRows, bigcoNames, tmKills, sel] = await Promise.all([
    db.selectFrom('domains').select('domain').execute(),
    db.selectFrom('bid_plans').select('domain').where('status', 'in', ['open', 'won']).execute(),
    currentTerms(db, 'bigco_names'), currentTerms(db, 'tm_kills'), activeSelectionSettings(db),
  ]);
  const owned = new Set(ownedRows.map((r) => r.domain));
  const planned = new Set(planRows.map((r) => r.domain));
  const checker = await closeoutNameChecker(db, { bigcoNames, tmKills });
  const adult = await adultFilter(db);
  const commission = sel.values.buy.commission[sel.values.buy.math_venue] ?? 0.2;
  const dropped = { owned_n: 0, open_plan_n: 0, no_headroom_n: 0, name_rules: {} as Record<string, number>, brand_typo_n: 0 };
  const cands: Cand[] = [];
  for (const r of rows) {
    if (owned.has(r.domain)) { dropped.owned_n++; continue; }
    if (planned.has(r.domain)) { dropped.open_plan_n++; continue; }
    const v = checker.check(r.domain);
    if (v.code) { dropped.name_rules[v.code] = (dropped.name_rules[v.code] ?? 0) + 1; continue; }
    const sld = r.domain.slice(0, -4);
    // v5.47.0 (F20): adult words and the company's forbidden terms, on the form tokens and on the engine's split
    const bad = adult.check(r.domain, [...v.words, ...(liftSplit && /^[a-z]+$/.test(sld) ? splitV2(sld, liftSplit) : [])]);
    if (bad) { dropped.name_rules[bad.code] = (dropped.name_rules[bad.code] ?? 0) + 1; continue; }
    // v5.56.0: a first name + surname (person-names.ts) is not a resale name
    if (personName(sld)) { dropped.name_rules.PERSON_NAME = (dropped.name_rules.PERSON_NAME ?? 0) + 1; continue; }
    const maxBid = maxBidRule({ capCents: cfg.s8_max_price_cents, resaleCents: cfg.shortlist_expected_resale_cents, saleChanceBp: cfg.shortlist_sale_chance_bp, renewalCents: cfg.shortlist_renewal_cents, commission });
    if (maxBid <= r.price_cents) { dropped.no_headroom_n++; continue; }
    const c: Cand = { domain: r.domain, sld, end_time: r.end_time, auction_type: r.auction_type, price_cents: r.price_cents, bids: r.bid_count, domain_age: r.domain_age, valuation_cents: r.valuation_cents, pageviews: r.pageviews, developed_tlds: r.developed_tlds, exact_match_tlds: r.exact_match_tlds, words: v.words, max_bid_cents: maxBid, pre: null as unknown as ScoreResult, flags: [] };
    c.pre = scoreAuction(inputOf(c, {}, null, null));
    cands.push(c);
  }
  // v5.49.0 (P2): auction-v4 name part = the name's position in the day's field. First pass above scored the raw value (quality x lift/100); now every candidate is placed in the sorted field and scored again.
  const fieldRaw = v4 ? cands.map((c) => c.pre.parts.name.raw ?? 0).sort((a, b) => a - b) : [];
  if (v4) for (const c of cands) c.pre = scoreAuction(inputOf(c, {}, fieldPercentile(fieldRaw, c.pre.parts.name.raw ?? 0), cands.length));
  const byPre = (a: Cand, b: Cand): number => b.pre.score - a.pre.score || a.end_time.getTime() - b.end_time.getTime() || (a.domain < b.domain ? -1 : 1);
  cands.sort(byPre);

  // v5.72.0 (CR-088, R-2): if more than 10,000 names pass the hard filters, stop and warn (Dvir wants to talk before we store that many)
  if (cands.length > 10_000) {
    deps.log?.warn({ field_n: cands.length }, 'auction shortlist: hard-filter passers exceed 10,000; storing none (R-2: talk to Dvir)');
    return { ...out, status: 'field_exceeds_10k', field_n: cands.length, shortlisted_n: 0, dropped, warning: `${cands.length} hard-filter passers exceed the 10,000 talk threshold (CR-088 R-2). No rows stored.` };
  }

  // ---- BRAND-TYPO-2 against the stored list, walking all ranked names (v5.72.0 CR-088: no pool size cap)
  let brands: Map<string, number> | null = null;
  let brandState: 'on' | 'off' | 'no_list' | 'old_list' = 'off';
  if (sel.values.sources.popularity) {
    const list = await latestPopularity(db);
    if (!list) brandState = 'no_list';
    else if (Math.floor((nowMs - new Date(`${list.listDate}T00:00:00Z`).getTime()) / DAY) > sel.values.typo.max_list_age_days) brandState = 'old_list';
    else {
      brandState = 'on';
      brands = new Map();
      for (const [label, rank] of list.ranks) if (rank <= sel.values.typo.top_n) brands.set(label, rank);
    }
  }
  const pool: Cand[] = [];
  for (const c of cands) {
    if (brands) {
      const m = brandMatches(c.sld, brands, commonWord, 1)[0];
      if (m?.severity === 'FAIL') { dropped.brand_typo_n++; continue; }
      if (m) c.flags.push(`brand-like: ${m.kind} of "${m.brand}" (an ordinary word, read it)`);
    }
    pool.push(c);
  }
  Object.assign(out, { dropped, brand_typo: brandState, pool_n: pool.length });

  // ---- the other endings of the top names, asked when unknown or older than 30 days
  const poolNames = pool.map((c) => c.sld);
  let state = await endingsState(db, poolNames);
  const endingsOut = { asked: 0, registered: 0, not_registered: 0, unknown: 0, partial: false, skipped: false, wanted_n: 0, status: 'ok' as 'ok' | 'not_configured' | 'failed' };
  if (deps.screening && cfg.shortlist_endings_n > 0 && pool.length > 0) {
    const dueNames = new Set(state.filter((r) => endingDue(r, nowMs)).map((r) => r.name));
    const want = pool.filter((c) => dueNames.has(c.sld)).slice(0, cfg.shortlist_endings_n).map((c) => c.sld);
    endingsOut.wanted_n = want.length;
    if (want.length > 0) {
      try {
        Object.assign(endingsOut, await askEndingsFor(db, deps.screening, now, want, { budgetMs: deps.endingsBudgetMs ?? ENDINGS_BUDGET_MS, log: deps.log as never }));
        state = await endingsState(db, poolNames);
      } catch (e) {
        endingsOut.status = 'failed';
        deps.log?.warn({ err: (e as Error).message }, 'auction shortlist: endings failed');
      }
    }
  } else if (!deps.screening) endingsOut.status = 'not_configured';
  out.endings = endingsOut;
  const known = new Map<string, EndingsKnown>();
  for (const r of state) {
    const k = known.get(r.name) ?? {};
    k[r.tld as OtherEnding] = r.checked_at === null ? null : r.registered;
    known.set(r.name, k);
  }

  // ---- final score and rank
  // v4: the raw name value with the endings now known is placed among the field's raw values (the field was scored without endings)
  const scored = pool.map((c) => {
    const e = known.get(c.sld) ?? {};
    if (!v4) return { c, s: scoreAuction(inputOf(c, e, null, null)) };
    const raw = scoreAuction(inputOf(c, e, null, null)).parts.name.raw ?? 0;
    return { c, s: scoreAuction(inputOf(c, e, fieldPercentile(fieldRaw, raw), cands.length)) };
  });
  scored.sort((a, b) => b.s.score - a.s.score || a.c.end_time.getTime() - b.c.end_time.getTime() || (a.c.domain < b.c.domain ? -1 : 1));
  // the suggested maximum follows the final score and (v5.55.0) the position in the day's field; walking down the ranking, a name whose maximum is not above its price has no room left and is dropped
  // (the rank of the next name counts only the names kept, so the factor uses the rank the route shows)
  const served: typeof scored = [];
  for (const x of scored) {
    const rank = served.length + 1;
    const topPct = cands.length > 0 ? Math.round((1000 * rank) / cands.length) / 10 : null;
    const f = positionFactor(topPct);
    const base = { capCents: cfg.s8_max_price_cents, resaleCents: cfg.shortlist_expected_resale_cents, saleChanceBp: cfg.shortlist_sale_chance_bp, renewalCents: cfg.shortlist_renewal_cents, commission, score: x.s.score };
    x.c.max_bid_cents = maxBidRule({ ...base, positionFactor: f });
    if (x.c.max_bid_cents <= x.c.price_cents) { dropped.no_headroom_n++; continue; }
    if (topPct !== null) x.s.reasons.push(`maximum $${x.c.max_bid_cents / 100}: top ${topPct}% of today's field (position factor ${Math.round(f * 100) / 100})`);
    served.push(x);
  }
  scored.splice(0, scored.length, ...served);
  // v5.72.0 (CR-088 R-1): store ALL hard-filter passers, not just shortlist_size; shortlist_size = 0 means "all"
  const sliced = cfg.shortlist_size > 0 ? scored.slice(0, cfg.shortlist_size) : scored;
  const top = sliced.map((x, i) => ({ ...x, rank: i + 1, prebid_id: null as number | null, verdict: null as 'pass' | 'flag' | 'fail' | null, dropped: null as string | null }));

  // ---- automatic pre-bid, walking down the list until prebid_n names did not fail
  const pre = { checked_n: 0, pass_n: 0, flag_n: 0, fail_n: 0, reused_n: 0, errors_n: 0, partial: false, status: 'ok' as 'ok' | 'not_configured' };
  if (!deps.screening) pre.status = 'not_configured';
  else if (cfg.shortlist_prebid_n > 0 && top.length > 0) {
    const reuse = new Map((await sql<{ id: string; domain: string; verdict: 'pass' | 'flag' | 'fail'; checks: PrebidCheck[] | null }>`
      select distinct on (domain) id::text as id, domain, verdict, answer->'checks' as checks from prebid_checks
      where venue = ${VENUE} and domain = any(${top.map((t) => t.c.domain)}::text[]) and created_at > ${new Date(nowMs - PREBID_REUSE_MS)} order by domain, created_at desc, id desc`.execute(db)).rows.map((r) => [r.domain, r]));
    const deadline = nowMs + (deps.prebidBudgetMs ?? PREBID_BUDGET_MS);
    let kept = 0;
    let tried = 0;
    for (const t of top) {
      if (kept >= cfg.shortlist_prebid_n || tried >= cfg.shortlist_prebid_n * 3) break;
      if (now() > deadline) { pre.partial = true; break; }
      tried++;
      const old = reuse.get(t.c.domain);
      let id: number; let verdict: 'pass' | 'flag' | 'fail'; let checks: readonly PrebidCheck[];
      if (old) { id = Number(old.id); verdict = old.verdict; checks = old.checks ?? []; pre.reused_n++; } else {
        try {
          const st = await storePrebid(db, deps.screening, t.c.domain, VENUE, now, { tokenName: 'datasave', auditId: null });
          id = st.id; verdict = st.verdict; checks = st.checks;
        } catch (e) { pre.errors_n++; deps.log?.warn({ domain: t.c.domain, err: (e as Error).message }, 'auction shortlist: pre-bid failed'); continue; }
      }
      pre.checked_n++;
      t.prebid_id = id; t.verdict = verdict;
      if (verdict === 'fail') { pre.fail_n++; t.dropped = failReason(checks); } else { kept++; if (verdict === 'pass') pre.pass_n++; else pre.flag_n++; }
    }
  }
  out.prebid = pre;

  // ---- store: replace the data date in one transaction
  const generated = new Date(nowMs);
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('auction_shortlist').where('data_date', '=', dataDate).execute();
    for (const part of chunks(top, 200)) {
      await trx.insertInto('auction_shortlist').values(part.map((t) => ({
        data_date: dataDate, domain: t.c.domain, rank: t.rank, score: t.s.score, score_version: t.s.version, parts: JSON.stringify(t.s.parts), price_cents: t.c.price_cents, bids: t.c.bids, end_time: t.c.end_time,
        auction_type: t.c.auction_type, valuation_cents: t.c.valuation_cents, domain_age: t.c.domain_age, pageviews: t.c.pageviews, max_bid_suggested_cents: t.c.max_bid_cents,
        reasons: [...t.s.reasons, ...t.c.flags], prebid_id: t.prebid_id, prebid_verdict: t.verdict, dropped_reason: t.dropped, generated_at: generated, field_n: cands.length,
      }))).execute();
    }
  });
  // v5.49.0 (P4): paper trading rows of the day: the served names and a deterministic random control of 25 from the rest of the field
  try {
    const topNames = new Set(top.map((t) => t.c.domain));
    const served: OutcomeRow[] = top.filter((t) => t.dropped === null).map((t) => ({ domain: t.c.domain, group: 'shortlist', rank: t.rank, score: t.s.score, max_bid_suggested_cents: t.c.max_bid_cents, first_price_cents: t.c.price_cents, end_time: t.c.end_time }));
    const ctl = await pickControl(db, dataDate, cands, topNames);
    const byName = new Map(cands.map((c) => [c.domain, c]));
    const control: OutcomeRow[] = ctl.map((d) => { const c = byName.get(d)!; return { domain: d, group: 'control', rank: null, score: c.pre.score, max_bid_suggested_cents: null, first_price_cents: c.price_cents, end_time: c.end_time }; });
    out.outcomes = await recordOutcomes(db, dataDate, [...served, ...control]);
  } catch (e) { out.outcomes = { error: (e as Error).message }; deps.log?.warn({ err: (e as Error).message }, 'auction shortlist: outcomes not stored'); }
  out.field_n = cands.length;
  out.shortlisted_n = top.length;
  out.served_n = top.filter((t) => t.dropped === null).length;
  return out;
}

// ---------- GET /auctions/shortlist ----------

export const ShortlistQuery = z.object({
  date: z.string().refine(isRealDate, 'must be a real date (YYYY-MM-DD)').optional(),
  limit: z.coerce.number().int().min(1).max(10_000).default(25),
  offset: z.coerce.number().int().min(0).default(0),
}).strict();

export async function getShortlist(db: Kysely<Database>, q: z.infer<typeof ShortlistQuery>, nowMs: number) {
  const settings = await db.selectFrom('settings').select(['shortlist_horizon_hours', 'shortlist_size', 'shortlist_endings_n', 'shortlist_prebid_n', 's8_max_price_cents', 'shortlist_expected_resale_cents', 'shortlist_sale_chance_bp', 'shortlist_renewal_cents']).executeTakeFirstOrThrow();
  const liftOn = (await db.selectFrom('lift_models').select('id').limit(1).executeTakeFirst()) !== undefined;
  const used = { ...settings, score_version: liftOn ? AUCTION_SCORE_VERSION_V4 : AUCTION_SCORE_VERSION, ...pair('s8_max_price', settings.s8_max_price_cents) };
  const u = used as Record<string, unknown>;
  delete u.s8_max_price_cents; delete u.shortlist_expected_resale_cents; delete u.shortlist_renewal_cents;
  // v5.48.0 (F22): the inputs of the expected-value maximum bid
  Object.assign(u, pair('expected_resale', settings.shortlist_expected_resale_cents), pair('renewal', settings.shortlist_renewal_cents));
  const newest = q.date ? null : await db.selectFrom('auction_shortlist').select((eb) => eb.fn.max('data_date').as('d')).executeTakeFirst();
  const dataDate = q.date ?? (newest?.d ? String(newest.d).slice(0, 10) : null);
  const base = { data_date: dataDate, as_of: toJerusalemIso(new Date(nowMs)), settings: used };
  if (dataDate === null) return { ...base, generated_at: null, total: 0, rows: [] };
  // v5.72.0 (CR-088 R-3): total = all eligible rows for the date (not dropped, not ended), for pagination
  const totalRow = await db.selectFrom('auction_shortlist').select((eb) => eb.fn.countAll<string>().as('n')).where('data_date', '=', dataDate).where('dropped_reason', 'is', null).where('end_time', '>', new Date(nowMs)).executeTakeFirst();
  const total = Number(totalRow?.n ?? 0);
  // served = not dropped by a failed pre-bid; names whose auction already ended are left out
  const rows = await db.selectFrom('auction_shortlist').selectAll().where('data_date', '=', dataDate).where('dropped_reason', 'is', null).where('end_time', '>', new Date(nowMs)).orderBy('rank').limit(q.limit).offset(q.offset).execute();
  const ids = rows.map((r) => r.prebid_id).filter((x): x is number => x !== null);
  const pre = ids.length === 0 ? [] : await db.selectFrom('prebid_checks').select(['id', 'verdict', 'created_at', 'answer']).where('id', 'in', ids).execute();
  const preById = new Map(pre.map((p) => [Number(p.id), p]));
  const gen = await db.selectFrom('auction_shortlist').select((eb) => eb.fn.max('generated_at').as('g')).where('data_date', '=', dataDate).executeTakeFirst();
  return {
    ...base, generated_at: gen?.g ? toJerusalemIso(new Date(gen.g as Date)) : null, total,
    rows: rows.map((r) => {
      const p = r.prebid_id === null ? undefined : preById.get(Number(r.prebid_id));
      const checks = ((p?.answer as { checks?: PrebidCheck[] } | undefined)?.checks ?? []);
      const created = p ? new Date(p.created_at as Date) : null;
      return {
        rank: r.rank, field_n: r.field_n, top_pct: r.field_n ? Math.round((1000 * r.rank) / r.field_n) / 10 : null, domain: r.domain, score: r.score, score_version: r.score_version, parts: r.parts, end_time: toJerusalemIso(new Date(r.end_time)), auction_type: r.auction_type,
        ...pair('price', r.price_cents), bids: r.bids, ...pair('max_bid_suggested', r.max_bid_suggested_cents), ...pair('valuation', r.valuation_cents), domain_age: r.domain_age, pageviews: r.pageviews,
        prebid: p && created ? {
          id: Number(p.id), verdict: p.verdict, checked_at: toJerusalemIso(created), valid_until: toJerusalemIso(new Date(created.getTime() + 72 * 3_600_000)),
          flags: checks.filter((c) => c.result === 'FLAG').map((c) => ({ id: c.id, reason: c.reason })),
        } : null,
        reasons: r.reasons,
      };
    }),
  };
}

// ---------- GET /auctions/funnel ----------

export const FunnelQuery = z.object({
  from: z.string().refine(isRealDate, 'must be a real date (YYYY-MM-DD)').optional(),
  to: z.string().refine(isRealDate, 'must be a real date (YYYY-MM-DD)').optional(),
}).strict();


/** The weekly funnel, plain counts. One query per table. Dates are IDT days; data dates are the data-date column, event times are the IDT day of the timestamp. */
export async function getFunnel(db: Kysely<Database>, q: z.infer<typeof FunnelQuery>, nowMs: number) {
  const today = idtDay(nowMs);
  const to = q.to ?? today;
  const from = q.from ?? addDays(to, -6);
  if (from > to) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid query: from must not be after to');
  if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 366 * DAY) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid query: the range is at most 366 days');
  const idt = (col: string) => sql.raw(`(${col} at time zone 'Asia/Jerusalem')::date`);
  const seen = await sql<{ n: string }>`select count(distinct domain)::text as n from godaddy_auctions_live where data_date between ${from}::date and ${to}::date`.execute(db);
  const sl = await sql<{ shortlisted: string; served: string; pass: string; flag: string; fail: string; checked: string }>`
    select count(distinct domain)::text as shortlisted, count(distinct domain) filter (where dropped_reason is null)::text as served,
      count(distinct domain) filter (where prebid_verdict = 'pass')::text as pass, count(distinct domain) filter (where prebid_verdict = 'flag')::text as flag,
      count(distinct domain) filter (where prebid_verdict = 'fail')::text as fail, count(distinct domain) filter (where prebid_verdict is not null)::text as checked
    from auction_shortlist where data_date between ${from}::date and ${to}::date`.execute(db);
  const pb = await sql<{ n: string; names: string; pass: string; flag: string; fail: string }>`
    select count(*)::text as n, count(distinct domain)::text as names, count(*) filter (where verdict = 'pass')::text as pass, count(*) filter (where verdict = 'flag')::text as flag, count(*) filter (where verdict = 'fail')::text as fail
    from prebid_checks where token_name is distinct from 'datasave' and ${idt('created_at')} between ${from}::date and ${to}::date`.execute(db);
  const plans = await sql<{ created: string; open: string; won: string; lost: string; withdrawn: string; expired: string; max_total: string }>`
    select count(*)::text as created,
      count(*) filter (where status = 'open' and not (auction_end_at is not null and auction_end_at < ${new Date(nowMs - 7 * DAY)}))::text as open,
      count(*) filter (where status = 'won')::text as won, count(*) filter (where status = 'lost')::text as lost, count(*) filter (where status = 'withdrawn')::text as withdrawn,
      count(*) filter (where status = 'expired' or (status = 'open' and auction_end_at is not null and auction_end_at < ${new Date(nowMs - 7 * DAY)}))::text as expired,
      coalesce(sum(max_bid_cents), 0)::text as max_total
    from bid_plans where ${idt('created_at')} between ${from}::date and ${to}::date`.execute(db);
  const imp = await sql<{ n: string }>`select count(distinct plan_id)::text as n from bid_plan_events where event = 'imported' and ${idt('created_at')} between ${from}::date and ${to}::date`.execute(db);
  const dom = await sql<{ bought: string; listed: string; sold: string; listed_now: string; names: string[] | null }>`
    select count(*) filter (where buy_date between ${from}::date and ${to}::date)::text as bought,
      count(*) filter (where buy_date between ${from}::date and ${to}::date and status = 'listed')::text as listed,
      count(*) filter (where buy_date between ${from}::date and ${to}::date and status = 'sold')::text as sold,
      count(*) filter (where status = 'listed')::text as listed_now,
      array_agg(domain) filter (where buy_date between ${from}::date and ${to}::date) as names
    from domains where lane = 'S8'`.execute(db);
  const names = dom.rows[0]!.names ?? [];
  const vis = names.length === 0 ? null : (await sql<{ views: string | null; leads: string | null; hits: string | null }>`
    with latest as (select distinct on (domain) domain, views_30d, leads_30d from visit_daily where source = 'afternic' and domain = any(${names}::text[]) order by domain, date_utc desc, id desc)
    select (select coalesce(sum(views_30d), 0)::text from latest) as views, (select coalesce(sum(leads_30d), 0)::text from latest) as leads,
      (select coalesce(sum(human_hits), 0)::text from visit_daily where source = 'dom_redirect' and domain = any(${names}::text[])) as hits`.execute(db)).rows[0]!;
  const sales = await sql<{ n: string; gross: string }>`
    select count(*)::text as n, coalesce(sum(s.sale_price_cents), 0)::text as gross from sales s join domains d on d.id = s.domain_id
    where d.lane = 'S8' and ${idt('s.sold_at')} between ${from}::date and ${to}::date`.execute(db);
  // v5.49.0 (P4) + v5.65.0 (F43): paper trading over the data dates of the range, one query grouped by group (final rows only)
  const pp = await sql<{ grp: string; final_n: string; win_n: string; lost_n: string; med: string | null; b_open: string; b_low: string; b_mid: string; b_high: string; med_bids: string | null; med_jump: string | null; jump_n: string; reached_100: string }>`
    with f as (select "group" as grp, would_win, coalesce(last_seen_price_cents, first_price_cents) as p, last_seen_bids, first_price_cents, prev_seen_price_cents
      from auction_outcomes where final and data_date between ${from}::date and ${to}::date)
    select grp, count(*)::text as final_n, count(*) filter (where would_win)::text as win_n, count(*) filter (where would_win is false)::text as lost_n,
      (percentile_cont(0.5) within group (order by p))::text as med,
      count(*) filter (where p <= 100)::text as b_open, count(*) filter (where p > 100 and p < 2500)::text as b_low,
      count(*) filter (where p >= 2500 and p < 10000)::text as b_mid, count(*) filter (where p >= 10000)::text as b_high,
      (percentile_cont(0.5) within group (order by last_seen_bids))::text as med_bids,
      (percentile_cont(0.5) within group (order by p - first_price_cents))::text as med_jump,
      count(*) filter (where prev_seen_price_cents is not null and p - prev_seen_price_cents >= 5000)::text as jump_n,
      count(*) filter (where p >= 10000)::text as reached_100
    from f group by grp`.execute(db);
  const med = (x: string | null | undefined): number | null => (x === null || x === undefined ? null : Math.round(Number(x)));
  const n = (x: string | null | undefined): number => Number(x ?? 0);
  const grp = (g: 'shortlist' | 'control') => {
    const r = pp.rows.find((x) => x.grp === g);
    const finalN = n(r?.final_n);
    return {
      final_n: finalN, r,
      bands: { opening: n(r?.b_open), low: n(r?.b_low), mid: n(r?.b_mid), high: n(r?.b_high) },
      median_final_price_cents: med(r?.med), median_final_bids: med(r?.med_bids),
      price_jump: { median_cents: med(r?.med_jump), jumped_50_last_window_n: n(r?.jump_n) },
    };
  };
  const sg = grp('shortlist'); const cg = grp('control');
  const paper = {
    shortlist: { final_n: sg.final_n, would_win_n: n(sg.r?.win_n), median_final_price_cents: sg.median_final_price_cents, lost_at_max_n: n(sg.r?.lost_n), lost_at_max_share: sg.final_n === 0 ? null : Math.round((n(sg.r?.lost_n) / sg.final_n) * 1000) / 1000, bands: sg.bands, median_final_bids: sg.median_final_bids, price_jump: sg.price_jump },
    control: { final_n: cg.final_n, median_final_price_cents: cg.median_final_price_cents, reached_100_n: n(cg.r?.reached_100), bands: cg.bands, median_final_bids: cg.median_final_bids, price_jump: cg.price_jump },
  };
  const d0 = dom.rows[0]!;
  return {
    from, to, as_of: toJerusalemIso(new Date(nowMs)),
    seen: { live_auctions: n(seen.rows[0]!.n) },
    shortlisted: { names: n(sl.rows[0]!.shortlisted), served: n(sl.rows[0]!.served) },
    auto_prebid: { checked: n(sl.rows[0]!.checked), pass: n(sl.rows[0]!.pass), flag: n(sl.rows[0]!.flag), fail: n(sl.rows[0]!.fail) },
    prebids_by_bots: { checks: n(pb.rows[0]!.n), names: n(pb.rows[0]!.names), pass: n(pb.rows[0]!.pass), flag: n(pb.rows[0]!.flag), fail: n(pb.rows[0]!.fail) },
    bid_plans: { created: n(plans.rows[0]!.created), open: n(plans.rows[0]!.open), won: n(plans.rows[0]!.won), lost: n(plans.rows[0]!.lost), withdrawn: n(plans.rows[0]!.withdrawn), expired: n(plans.rows[0]!.expired), ...pair('max_bid_total', n(plans.rows[0]!.max_total)) },
    imported: n(imp.rows[0]!.n),
    paper,
    s8_names: { bought: n(d0.bought), listed_of_bought: n(d0.listed), sold_of_bought: n(d0.sold), listed_now: n(d0.listed_now) },
    traffic_of_bought: vis ? { views_30d: n(vis.views), leads_30d: n(vis.leads), redirect_human_hits: n(vis.hits) } : { views_30d: 0, leads_30d: 0, redirect_human_hits: 0 },
    sold: { count: n(sales.rows[0]!.n), ...pair('gross', n(sales.rows[0]!.gross)) },
    note: 'shortlist, auto pre-bid and live-auction counts use the data date; plans, imports, pre-bids by bots and sales use the IDT day of the event; bought, listed and sold use domains.buy_date; traffic is the latest afternic views and leads (30 days) of the S8 names bought in the range.',
  };
}
