// Drift report of the scoring engine (CR-056 part 3): per year and for the newest full quarter, how the sold names (and the dropped ones, where dated)
// look: share with a .net registered before the sale, share with 2 words, median length, hand-registered share, median price (overall and split).
// Point-in-time: every row's features are computed as of its own sale / observation date (features.ts), so a .net created later never counts.
import { quarterOf } from './dataset.js';
import { computeFeatures, sldOf, type FeatureContext } from './features.js';
import type { SaleRow, UnsoldRow } from './data.js';

/** `handreg_share` is null when the .com creation date is known for less than this share of the rows (the dropped names have no registry record). */
export const DRIFT_MIN_COM_KNOWN = 0.3;

export interface DriftRow { domain: string; asOf: string; priceCents: number | null }

export interface DriftBlock {
  n: number;
  /** among rows with a known .net answer */
  net_pit_share: number | null;
  /** among rows with a reading (known words) */
  two_word_share: number | null;
  median_length: number | null;
  com_date_known_share: number;
  handreg_share: number | null;
  /** sold blocks only (a dropped row has no price) */
  median_price_cents?: number | null;
  median_price_by?: {
    net_pit: { yes: number | null; no: number | null };
    words: { two: number | null; three: number | null };
    acq: { handreg: number | null; other: number | null };
  };
}

export interface DriftPeriod { window: { from: string; to_exclusive: string; label?: string }; sold: DriftBlock | null; dropped: DriftBlock | null }

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
const medCents = (xs: number[]): number | null => { const m = median(xs); return m === null ? null : Math.round(m); };
const share = (k: number, n: number): number | null => (n === 0 ? null : round4(k / n));

export function driftBlock(ctx: FeatureContext, rows: readonly DriftRow[], withPrice: boolean): DriftBlock | null {
  if (rows.length === 0) return null;
  let netKnown = 0; let netYes = 0; let wordsKnown = 0; let two = 0; let comKnown = 0; let hand = 0;
  const lens: number[] = [];
  const pr = { all: [] as number[], netYes: [] as number[], netNo: [] as number[], two: [] as number[], three: [] as number[], hand: [] as number[], other: [] as number[] };
  for (const r of rows) {
    const f = computeFeatures(ctx, r.domain, r.asOf);
    lens.push(sldOf(r.domain).length);
    const net = f.values.net_pit; const nw = f.values.n_words;
    if (net !== null) { netKnown++; if (net === 1) netYes++; }
    if (nw !== null) { wordsKnown++; if (nw === 2) two++; }
    if (f.acq !== null) { comKnown++; if (f.acq === 'handreg') hand++; }
    if (withPrice && r.priceCents !== null) {
      const p = r.priceCents;
      pr.all.push(p);
      if (net === 1) pr.netYes.push(p); else if (net === 0) pr.netNo.push(p);
      if (nw === 2) pr.two.push(p); else if (nw === 3) pr.three.push(p);
      if (f.acq === 'handreg') pr.hand.push(p); else if (f.acq !== null) pr.other.push(p);
    }
  }
  const comShare = comKnown / rows.length;
  const b: DriftBlock = {
    n: rows.length, net_pit_share: share(netYes, netKnown), two_word_share: share(two, wordsKnown), median_length: median(lens),
    com_date_known_share: round4(comShare), handreg_share: comShare >= DRIFT_MIN_COM_KNOWN ? share(hand, comKnown) : null,
  };
  if (withPrice) {
    b.median_price_cents = medCents(pr.all);
    b.median_price_by = {
      net_pit: { yes: medCents(pr.netYes), no: medCents(pr.netNo) },
      words: { two: medCents(pr.two), three: medCents(pr.three) },
      acq: { handreg: medCents(pr.hand), other: medCents(pr.other) },
    };
  }
  return b;
}

/**
 * Drift per year present in the sold data (2024, 2025, ...) and `last_quarter` (the newest full calendar quarter before `today` with a sale).
 * Sold = every stored sale; dropped = dropped_after_held rows not marked caught by a catcher. A period with no dropped row has `dropped: null`.
 */
export function computeDrift(ctx: FeatureContext, sales: readonly SaleRow[], unsold: readonly UnsoldRow[], today: string): Record<string, DriftPeriod> {
  const sold: DriftRow[] = sales.map((s) => ({ domain: s.domain, asOf: s.sale_date, priceCents: s.price_cents }));
  const dropped: DriftRow[] = unsold.filter((u) => u.type === 'dropped_after_held' && u.caught_by_catcher !== true).map((u) => ({ domain: u.domain, asOf: u.observation_date, priceCents: null }));
  const inWin = (rows: DriftRow[], from: string, to: string): DriftRow[] => rows.filter((r) => r.asOf >= from && r.asOf < to);
  const period = (from: string, to: string): DriftPeriod => ({ window: { from, to_exclusive: to }, sold: driftBlock(ctx, inWin(sold, from, to), true), dropped: driftBlock(ctx, inWin(dropped, from, to), false) });
  const out: Record<string, DriftPeriod> = {};
  for (const y of [...new Set(sold.map((s) => s.asOf.slice(0, 4)))].sort()) out[y] = period(`${y}-01-01`, `${Number(y) + 1}-01-01`);
  let q: ReturnType<typeof quarterOf> | null = null;
  for (const s of sold) { const c = quarterOf(s.asOf); if (c.to <= today && (q === null || c.from > q.from)) q = c; }
  if (q) { const p = period(q.from, q.to); out.last_quarter = { ...p, window: { ...p.window, label: q.label } }; }
  return out;
}
