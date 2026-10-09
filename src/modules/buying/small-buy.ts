// CR-030: Dvir-approved small-buy exception to the buy hold. A /buy with `small_buy_exception: true`, an approval line that names the domain and
// says "small buy", a non-premium quote of at most SMALL_BUY_MAX_FIRST_YEAR_CENTS and room under the rolling 7-day cap skips BUY_HOLD (only).
// Changing these constants needs a release (Dvir's approval); there is no API or settings switch.
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { AppError } from '../../http/errors.js';
import { formatUsd } from '../../core/money.js';
import type { Gate } from './buy-gates.js';

export const SMALL_BUY_MAX_FIRST_YEAR_CENTS = 1108;
export const SMALL_BUY_WEEKLY_CAP_CENTS = 5000;
const WEEK_MS = 7 * 86_400_000;

/** (a) + (b): the flag, and an approval line that says "small buy" (the domain is checked by the normal approval check). */
export const smallBuyRequested = (flag: boolean | undefined, approvalText: unknown): boolean =>
  flag === true && typeof approvalText === 'string' && /small buy/i.test(approvalText);

export interface SmallBuyState { cap_cents: number; spent_cents: number; cost_cents: number; remaining_cents: number }

/** First-year cost of small-buy purchases in the last 7 days (open ones at their expected cost, failed ones not counted). */
export async function smallBuySpend(db: Kysely<Database>, nowMs: number): Promise<{ spentCents: number; rows: { at: Date; cents: number }[] }> {
  const rows = (await db.selectFrom('purchases').select(['charged_cents', 'expected_cents', 'created_at'])
    .where('small_buy_exception', '=', true).where('dry_run', '=', false).where('state', '!=', 'failed')
    .where('created_at', '>', new Date(nowMs - WEEK_MS)).orderBy('created_at').execute())
    .map((r) => ({ at: r.created_at as Date, cents: r.charged_cents ?? r.expected_cents ?? 0 }));
  return { spentCents: rows.reduce((s, r) => s + r.cents, 0), rows };
}

/** (c) then (d) for a quote. Returns the gate that refuses, or null plus the numbers for the dry-run answer. */
export async function smallBuyGate(db: Kysely<Database>, nowMs: number, costCents: number, premium: boolean | null): Promise<{ gate: Gate } | { state: SmallBuyState }> {
  if (premium === true || costCents > SMALL_BUY_MAX_FIRST_YEAR_CENTS) {
    return { gate: { code: 'SMALL_BUY_PRICE', message: `A small buy is a non-premium name with a first-year price of at most ${formatUsd(SMALL_BUY_MAX_FIRST_YEAR_CENTS)}; this quote is ${formatUsd(costCents)}`,
      details: { max_first_year_cents: SMALL_BUY_MAX_FIRST_YEAR_CENTS, cost_cents: costCents, premium: premium === true } } };
  }
  const { spentCents, rows } = await smallBuySpend(db, nowMs);
  if (spentCents + costCents > SMALL_BUY_WEEKLY_CAP_CENTS) {
    let left = spentCents;
    let next = new Date(nowMs);
    for (const r of rows) { // the earliest moment enough of the oldest small buys have aged out of the 7-day window
      left -= r.cents;
      next = new Date(r.at.getTime() + WEEK_MS);
      if (left + costCents <= SMALL_BUY_WEEKLY_CAP_CENTS) break;
    }
    return { gate: { code: 'SMALL_BUY_WEEKLY_CAP', message: `Small buys are capped at ${formatUsd(SMALL_BUY_WEEKLY_CAP_CENTS)} per rolling 7 days (${formatUsd(spentCents)} used); this one costs ${formatUsd(costCents)}`,
      details: { cap_cents: SMALL_BUY_WEEKLY_CAP_CENTS, spent_cents: spentCents, cost_cents: costCents, next_allowed_at: next.toISOString() } } };
  }
  return { state: { cap_cents: SMALL_BUY_WEEKLY_CAP_CENTS, spent_cents: spentCents, cost_cents: costCents, remaining_cents: SMALL_BUY_WEEKLY_CAP_CENTS - spentCents - costCents } };
}

export const smallBuyError = (g: Gate): AppError => new AppError(409, g.code, g.message, g.details);
