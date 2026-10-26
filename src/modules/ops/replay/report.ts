// v5.59.0 (CR-081): the replay report. Per group (ours, random): n, counts and rates per label, always with the counts; `too_small` when a label has fewer than 20 positives in
// total (ours + random). A paired bootstrap (1,000 resamples, seeded) of ours minus random per label with the share of resamples where ours wins; and the list of names that did well
// (any positive label) from both groups with their features. Labels are never merged into one number.
import { createHash } from 'node:crypto';
import { formatUsd } from '../../../core/money.js';
import type { DayField, LogicContext, Ranked, ReplayKind } from './logic.js';
import type { NameOutcome, OutcomeSet } from './outcomes.js';

export const BOOTSTRAP_RESAMPLES = 1_000;
export const MIN_POSITIVES = 20;

/** mulberry32 seeded from text. */
function rng(text: string): () => number {
  let a = Buffer.from(createHash('sha256').update(text).digest('hex'), 'hex').readUInt32BE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r4 = (x: number): number => Math.round(x * 10_000) / 10_000;

interface LabelStat { known_n: number; unknown_n: number; positives: number; rate: number | null }

function groupStats(names: readonly Ranked[], outcomes: OutcomeSet, labels: readonly string[]) {
  const out: Record<string, LabelStat> = {};
  for (const l of labels) {
    let known = 0, pos = 0;
    for (const r of names) {
      const v = outcomes.byName.get(r.row.domain)?.labels[l];
      if (v === true || v === false) { known++; if (v) pos++; }
    }
    out[l] = { known_n: known, unknown_n: names.length - known, positives: pos, rate: known === 0 ? null : r4(pos / known) };
  }
  return { n: names.length, labels: out };
}

/** Paired by position (ours rank i with random draw i): resamples the pairs where both are known. */
export function bootstrap(ours: ReadonlyArray<boolean | null>, rand: ReadonlyArray<boolean | null>, seedText: string, resamples = BOOTSTRAP_RESAMPLES) {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < Math.min(ours.length, rand.length); i++) if (ours[i] !== null && rand[i] !== null) pairs.push([ours[i] ? 1 : 0, rand[i] ? 1 : 0]);
  if (pairs.length === 0) return { resamples, pairs_n: 0, mean_diff: null, ours_win_share: null, tie_share: null };
  const next = rng(seedText);
  let wins = 0, ties = 0, sum = 0;
  for (let b = 0; b < resamples; b++) {
    let d = 0;
    for (let k = 0; k < pairs.length; k++) { const p = pairs[Math.floor(next() * pairs.length)]!; d += p[0] - p[1]; }
    sum += d / pairs.length;
    if (d > 0) wins++; else if (d === 0) ties++;
  }
  return { resamples, pairs_n: pairs.length, mean_diff: r4(sum / resamples), ours_win_share: r4(wins / resamples), tie_share: r4(ties / resamples) };
}

const features = (r: Ranked, group: 'ours' | 'random', o: NameOutcome | undefined) => ({
  domain: r.row.domain, group, rank: r.rank, top_pct: r.top_pct, score: r.score,
  score_parts: Object.fromEntries(Object.entries(r.parts).map(([k, p]) => [k, (p as { points: number }).points])),
  price_cents: r.row.price_cents, price: formatUsd(r.row.price_cents), bids: r.row.bids, domain_age: r.row.domain_age, valuation_cents: r.row.valuation_cents, pageviews: r.row.pageviews,
  developed_tlds: r.row.developed_tlds, exact_match_tlds: r.row.exact_match_tlds, keyword_registrations: r.row.keyword_registrations, search_volume: r.row.search_volume,
  words: r.words, letters: r.row.sld.length, our_max_cents: r.max_bid_cents, end_time: r.row.end_time ? r.row.end_time.toISOString() : null,
  final_price_cents: o?.final_price_cents ?? null, final_bids: o?.final_bids ?? null, final_basis: o?.basis ?? null, ended: o?.ended ?? null, rdap_tag: o?.rdap_tag ?? null, retail_sales: o?.retail ?? [], labels: o?.labels ?? {},
});

export function buildReport(o: { ctx: LogicContext; day: DayField; n: number; seed: string; ours: Ranked[]; random: Ranked[]; outcomes: OutcomeSet; kind: ReplayKind }) {
  const { ctx, day, outcomes } = o;
  const labels = outcomes.labels;
  const gOurs = groupStats(o.ours, outcomes, labels);
  const gRand = groupStats(o.random, outcomes, labels);
  const labelOf = (names: readonly Ranked[], l: string) => names.map((r) => outcomes.byName.get(r.row.domain)?.labels[l] ?? null);
  const perLabel: Record<string, unknown> = {};
  for (const l of labels) {
    const total = gOurs.labels[l]!.positives + gRand.labels[l]!.positives;
    perLabel[l] = { positives_total: total, too_small: total < MIN_POSITIVES, bootstrap: bootstrap(labelOf(o.ours, l), labelOf(o.random, l), `${o.seed}|${ctx.date}|${o.kind}|${l}`) };
  }
  const did: Array<ReturnType<typeof features>> = [];
  for (const [group, names] of [['ours', o.ours], ['random', o.random]] as const) {
    for (const r of names) {
      const out = outcomes.byName.get(r.row.domain);
      if (out && Object.values(out.labels).some((v) => v === true)) did.push(features(r, group, out));
    }
  }
  return {
    date: ctx.date, kind: o.kind, n: o.n, seed: o.seed,
    logic: { version: ctx.version, lift: ctx.liftSource, score_version: ctx.lift ? 'auction-v4' : 'auction-v2', settings: ctx.cfg, now_utc: new Date(ctx.nowMs).toISOString(), brand_typo: 'not applied (v1)', endings: 'unknown (not asked)' },
    field: { rows_read_n: day.read_n, candidates_n: day.candidates_n, field_n: day.field.length, dropped: day.dropped },
    outcome_status: outcomes.status,
    groups: { ours: gOurs, random: gRand },
    labels: perLabel,
    names: { ours: o.ours.map((r) => features(r, 'ours', outcomes.byName.get(r.row.domain))), random: o.random.map((r) => features(r, 'random', outcomes.byName.get(r.row.domain))) },
    did_well: did,
    notes: [
      'Outcomes are read from data stored after the day; the logic used only the day\'s own archived rows, frozen lists and a lift table trained on or before the day.',
      `A rate with fewer than ${MIN_POSITIVES} positives in total (ours + random) is "too small to decide" (too_small: true).`,
      'beat_our_max is reported, not counted as a miss of the logic: a name that went above our maximum we could not have won.',
    ],
  };
}
