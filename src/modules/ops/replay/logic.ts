// v5.59.0 (CR-081): the point-in-time logic of the historical replay. It takes the archived rows of ONE day D and returns the ranked field exactly as the auction shortlist would have
// ranked it on D: the same name rules (closeoutNameChecker), adult filter, person-name filter, scoreAuction v4 with the field percentile and the demand fields of the row, and the
// maxBidRule with the position factor. Inputs: the archived rows of day D, the frozen lists, the settings and a lift table trained on or before D (else the CR-002 seed table).
// It never reads anything dated after D (no later archive file, no RDAP, no sales, no endings: those stay unknown, which the score allows). Rules and test ids: docs/internal/replay.md.
import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import { MT19937, shuffle } from '../../../core/mt19937.js';
import type { Database } from '../../../db/types.js';
import { liftTable, loadLiftSeed, trainLift, type LiftModel } from '../../engine/index.js';
import { activeSelectionSettings, closeoutNameChecker, splitV2, type SplitV2Table } from '../../selection/index.js';
import { adultFilter, type AdultFilter } from '../auctions/adult-terms.js';
import { personName } from '../auctions/person-names.js';
import { AUCTION_SCORE_VERSION, AUCTION_SCORE_VERSION_V4, fieldPercentile, maxBidRule, positionFactor, scoreAuction, type ScoreInput, type ScoreResult } from '../auctions/shortlist-score.js';
import { liftOf } from '../auctions/shortlist.js';
import { currentTerms } from '../closeouts/filters.js';
import { priceToCents } from '../jobs/datasave/datasave-price.js';

export const REPLAY_LOGIC = 'replay-v1';
/** The time of day the shortlist step runs (the datasave job, 15:00 UTC): the "now" of day D for the horizon of the auctions. */
export const REPLAY_NOW_UTC = 'T15:00:00Z';

export type ReplayKind = 'auctions' | 'closeouts';

export interface DayRow {
  domain: string; sld: string; end_time: Date | null; auction_type: string | null; price_cents: number; bids: number; domain_age: number | null; valuation_cents: number | null; pageviews: number | null;
  developed_tlds: number | null; exact_match_tlds: number | null; keyword_registrations: number | null; search_volume: number | null;
}

const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/** One archived JSON row (GoDaddy's own field names) to the fields the logic uses; null when it has no usable name or price. */
export function dayRow(raw: Record<string, unknown>): DayRow | null {
  if (typeof raw.domainName !== 'string') return null;
  const domain = raw.domainName.trim().toLowerCase();
  if (!/^[a-z0-9-]+[.]com$/.test(domain)) return null;
  const price = priceToCents(raw.price);
  if (price === null) return null;
  const end = typeof raw.auctionEndTime === 'string' ? new Date(raw.auctionEndTime) : null;
  return {
    domain, sld: domain.slice(0, -4), end_time: end && !Number.isNaN(end.getTime()) ? end : null, auction_type: typeof raw.auctionType === 'string' ? raw.auctionType : null, price_cents: price, bids: int(raw.numberOfBids) ?? 0,
    domain_age: int(raw.domainAge), valuation_cents: priceToCents(raw.valuation), pageviews: int(raw.pageviews), developed_tlds: int(raw.developedTlds), exact_match_tlds: int(raw.exactMatchTlds),
    keyword_registrations: int(raw.keywordRegistrations), search_volume: int(raw.semrushSearchVolume),
  };
}

export interface LogicContext {
  date: string;
  kind: ReplayKind;
  lift: { bins: LiftModel['bins'] } | null;
  liftSplit: SplitV2Table | null;
  liftSource: string;
  checker: Awaited<ReturnType<typeof closeoutNameChecker>>;
  adult: AdultFilter;
  cfg: { capCents: number; horizonHours: number; resaleCents: number; saleChanceBp: number; renewalCents: number; commission: number };
  nowMs: number;
  version: string;
}

/** The newest stored lift table trained on or before the end of day D (UTC); else the table trained from the frozen CR-002 seed alone; else none (score v2). */
export async function liftAsOf(db: Kysely<Database>, date: string): Promise<{ lift: { bins: LiftModel['bins'] } | null; source: string }> {
  const r = await db.selectFrom('lift_models').select(['id', 'bins', 'trained_at']).where('trained_at', '<', new Date(`${date}T23:59:59.999Z`)).orderBy('trained_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  if (r) return { lift: { bins: r.bins as unknown as LiftModel['bins'] }, source: `model:${r.id}@${r.trained_at.toISOString()}` };
  const seed = loadLiftSeed();
  const t = seed ? trainLift([], seed.rows) : null;
  if (seed && t) return { lift: { bins: t.bins }, source: `seed:${seed.sha256.slice(0, 12)}` };
  return { lift: null, source: 'none' };
}

export async function logicContext(db: Kysely<Database>, date: string, kind: ReplayKind): Promise<LogicContext> {
  const cfgRow = await db.selectFrom('settings').select(['s8_max_price_cents', 'shortlist_horizon_hours', 'shortlist_expected_resale_cents', 'shortlist_sale_chance_bp', 'shortlist_renewal_cents']).executeTakeFirstOrThrow();
  const [bigcoNames, tmKills, sel, l] = await Promise.all([currentTerms(db, 'bigco_names'), currentTerms(db, 'tm_kills'), activeSelectionSettings(db), liftAsOf(db, date)]);
  const checker = await closeoutNameChecker(db, { bigcoNames, tmKills });
  const adult = await adultFilter(db);
  const liftSplit = l.lift ? await liftTable(db) : null;
  const cfg = { capCents: cfgRow.s8_max_price_cents, horizonHours: cfgRow.shortlist_horizon_hours, resaleCents: cfgRow.shortlist_expected_resale_cents, saleChanceBp: cfgRow.shortlist_sale_chance_bp, renewalCents: cfgRow.shortlist_renewal_cents, commission: sel.values.buy.commission[sel.values.buy.math_venue] ?? 0.2 };
  const scoreVersion = l.lift ? AUCTION_SCORE_VERSION_V4 : AUCTION_SCORE_VERSION;
  const settingsSha = createHash('sha256').update(JSON.stringify(cfg)).digest('hex').slice(0, 8);
  return { date, kind, lift: l.lift, liftSplit, liftSource: l.source, checker, adult, cfg, nowMs: Date.parse(`${date}${REPLAY_NOW_UTC}`), version: `${REPLAY_LOGIC}|${scoreVersion}|lift:${l.source}|settings:${settingsSha}` };
}

export interface Ranked {
  row: DayRow; words: string[]; score: number; parts: ScoreResult['parts']; rank: number; top_pct: number | null; max_bid_cents: number;
}
export interface DayField { field: Ranked[]; candidates_n: number; read_n: number; dropped: Record<string, number> }

/** Ranks the archived rows of day D. Pure given the context. */
export function rankDay(rows: readonly DayRow[], ctx: LogicContext): DayField {
  const { cfg } = ctx;
  const v4 = ctx.lift !== null && ctx.liftSplit !== null;
  const dropped: Record<string, number> = {};
  const bump = (k: string) => { dropped[k] = (dropped[k] ?? 0) + 1; };
  type Cand = { row: DayRow; words: string[]; maxBid: number; pre: ScoreResult };
  const inputOf = (c: Pick<Cand, 'row' | 'words' | 'maxBid'>, pct: number | null, fieldN: number | null): ScoreInput => ({
    words: c.words.length > 0 ? c.words : [c.row.sld], letters: c.row.sld.length, price_cents: c.row.price_cents, max_bid_cents: c.maxBid, bids: c.row.bids, domain_age: c.row.domain_age, pageviews: c.row.pageviews, endings: {},
    lift: ctx.lift && ctx.liftSplit ? liftOf(ctx.lift, ctx.liftSplit, c.row.sld, {}) : null,
    ...(v4 ? { v4: { name_pct: pct, field_n: fieldN, developed_tlds: c.row.developed_tlds, exact_match_tlds: c.row.exact_match_tlds } } : {}),
  });
  const baseMax = maxBidRule({ capCents: cfg.capCents, resaleCents: cfg.resaleCents, saleChanceBp: cfg.saleChanceBp, renewalCents: cfg.renewalCents, commission: cfg.commission });
  const horizonEnd = ctx.nowMs + cfg.horizonHours * 3_600_000;
  const cands: Cand[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.domain)) continue; // a name twice in one file: the first row
    seen.add(r.domain);
    if (r.price_cents > cfg.capCents) { bump('over_cap'); continue; }
    if (ctx.kind === 'auctions') {
      if (r.bids < 1) { bump('no_bids'); continue; }
      if (!r.end_time || r.end_time.getTime() <= ctx.nowMs || r.end_time.getTime() > horizonEnd) { bump('outside_horizon'); continue; }
    }
    const v = ctx.checker.check(r.domain);
    if (v.code) { bump(v.code); continue; }
    const bad = ctx.adult.check(r.domain, [...v.words, ...(ctx.liftSplit && /^[a-z]+$/.test(r.sld) ? splitV2(r.sld, ctx.liftSplit) : [])]);
    if (bad) { bump(bad.code); continue; }
    if (personName(r.sld)) { bump('PERSON_NAME'); continue; }
    if (baseMax <= r.price_cents) { bump('no_headroom'); continue; }
    const c = { row: r, words: v.words, maxBid: baseMax, pre: null as unknown as ScoreResult };
    c.pre = scoreAuction(inputOf(c, null, null));
    cands.push(c);
  }
  // the name part is the name's position in the day's field (auction-v4), as in the shortlist
  const fieldRaw = v4 ? cands.map((c) => c.pre.parts.name.raw ?? 0).sort((a, b) => a - b) : [];
  if (v4) for (const c of cands) c.pre = scoreAuction(inputOf(c, fieldPercentile(fieldRaw, c.pre.parts.name.raw ?? 0), cands.length));
  const t = (c: Cand) => c.row.end_time?.getTime() ?? 0;
  cands.sort((a, b) => b.pre.score - a.pre.score || t(a) - t(b) || (a.row.domain < b.row.domain ? -1 : 1));
  // the suggested maximum follows the score and the position in the field; a name whose maximum is not above its price is dropped (same walk as the shortlist)
  const field: Ranked[] = [];
  for (const c of cands) {
    const rank = field.length + 1;
    const topPct = cands.length > 0 ? Math.round((1000 * rank) / cands.length) / 10 : null;
    const max = maxBidRule({ capCents: cfg.capCents, resaleCents: cfg.resaleCents, saleChanceBp: cfg.saleChanceBp, renewalCents: cfg.renewalCents, commission: cfg.commission, score: c.pre.score, positionFactor: positionFactor(topPct) });
    if (max <= c.row.price_cents) { bump('no_headroom_after_position'); continue; }
    field.push({ row: c.row, words: c.words, score: c.pre.score, parts: c.pre.parts, rank, top_pct: topPct, max_bid_cents: max });
  }
  return { field, candidates_n: cands.length, read_n: rows.length, dropped };
}

/** The random group: n names of the field, not among our top n, shuffled with the pick-proof's MT19937 / Fisher-Yates (src/core/mt19937.ts) seeded from sha256(seed | date): reproducible. */
export function randomGroup(field: readonly Ranked[], n: number, seed: string, date: string): Ranked[] {
  const rest = field.slice(n).map((r) => r.row.domain).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  shuffle(rest, new MT19937([parseInt(createHash('sha256').update(`${seed}|${date}`).digest('hex').slice(0, 8), 16) >>> 0]));
  const by = new Map(field.map((r) => [r.row.domain, r]));
  return rest.slice(0, n).map((d) => by.get(d)!);
}
