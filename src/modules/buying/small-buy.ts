// CR-030: Dvir-approved small-buy exception to the buy hold. A /buy with `small_buy_exception: true`, an approval line that names the domain and
// says "small buy", and a non-premium quote of at most SMALL_BUY_MAX_FIRST_YEAR_CENTS skips BUY_HOLD (only). G-86 (14 Oct 2026): no money total
// (the former rolling 7-day cap is gone; Gavriel owns the budget).
// Changing the constant needs a release (Dvir's approval); there is no API or settings switch.
import { AppError } from '../../http/errors.js';
import { formatUsd } from '../../core/money.js';
import type { Gate } from './buy-gates.js';

export const SMALL_BUY_MAX_FIRST_YEAR_CENTS = 1108;

/** (a) + (b): the flag, and an approval line that says "small buy" (the domain is checked by the normal approval check). */
export const smallBuyRequested = (flag: boolean | undefined, approvalText: unknown): boolean =>
  flag === true && typeof approvalText === 'string' && /small buy/i.test(approvalText);

/** (c) for a quote. Returns the gate that refuses, or null. */
export function smallBuyGate(costCents: number, premium: boolean | null): { gate: Gate } | null {
  if (premium === true || costCents > SMALL_BUY_MAX_FIRST_YEAR_CENTS) {
    return { gate: { code: 'SMALL_BUY_PRICE', message: `A small buy is a non-premium name with a first-year price of at most ${formatUsd(SMALL_BUY_MAX_FIRST_YEAR_CENTS)}; this quote is ${formatUsd(costCents)}`,
      details: { max_first_year_cents: SMALL_BUY_MAX_FIRST_YEAR_CENTS, cost_cents: costCents, premium: premium === true } } };
  }
  return null;
}

export const smallBuyError = (g: Gate): AppError => new AppError(409, g.code, g.message, g.details);

/** The read-only small-buy rule (for GET /selection/buy-hold): the per-name price ceiling. */
export function smallBuyView(): object {
  return { max_first_year_cents: SMALL_BUY_MAX_FIRST_YEAR_CENTS, max_first_year: formatUsd(SMALL_BUY_MAX_FIRST_YEAR_CENTS) };
}
