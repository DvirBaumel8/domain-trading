import { div, type Cents } from './int.js';

const BPS = 10000;
const HALF_BPS = 5000;
const DOLLAR = 100;
const HUNDRED_DOLLARS = 10000;

/** c × bps / 10000, half-up to the cent. */
export function pct(c: Cents, bps: number): Cents {
  return div(c * bps + HALF_BPS, BPS);
}

/** Nearest $5, ties up. */
export function round5(c: Cents): Cents {
  return div(c + 250, 500) * 500;
}

/** Nearest whole dollar, ties up (v3 floor rounding). */
export function roundDollar(c: Cents): Cents {
  return div(c + 50, DOLLAR) * DOLLAR;
}

function niceEnding(c: Cents, ending: Cents): Cents {
  const n = c + ending;
  const lo = div(n, HUNDRED_DOLLARS) * HUNDRED_DOLLARS;
  const hi = lo + HUNDRED_DOLLARS;
  return (n - lo <= hi - n ? lo : hi) - ending;
}

/** Nearest whole-dollar price ending in 95; ties go down. */
export function nice95(c: Cents): Cents {
  return niceEnding(c, 5 * DOLLAR);
}

/** Nearest price ending in 99; ties go down. */
export function nice99(c: Cents): Cents {
  return niceEnding(c, DOLLAR);
}

/** Smallest whole-dollar price ending in 95 that is ≥ c. */
export function ceil95(c: Cents): Cents {
  const step = HUNDRED_DOLLARS;
  const offset = step - 5 * DOLLAR; // 9500: the "…95" position inside each $100 band
  const k = Math.max(0, div(c - offset + step - 1, step));
  return k * step + offset;
}
