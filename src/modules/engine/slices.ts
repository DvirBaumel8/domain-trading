// v5.7.0 (CR-058 part B): the hold-time split of the sold test rows. quick = sold less than 91 days after the .com's registry creation date (looks like a
// drop-catch resale), held = 91 days or more. Report only: not a feature, so the .com-date leak guard is untouched. Pure.
import { auc } from './model/metrics.js';

const QUICK_SALE_DAYS = 91;
/** A test row counts as found when its score reaches this probability (the engine has no other cut-off; the same 0.5 is shown in the block). */
const RECALL_THRESHOLD = 0.5;
const DAY = 86_400_000;

interface SliceStats { n: number; recall: number | null; net_pit_share: number | null; auc: number | null }
export interface HoldSlices { threshold: number; quick: SliceStats; held: SliceStats; unknown_n: number }
export interface SliceRow { label: number; asOf: string; score: number; netPit: number | null; comCreatedMs: number | null }

const r4 = (x: number): number => Math.round(x * 10_000) / 10_000;

export function holdSlices(rows: readonly SliceRow[], threshold: number = RECALL_THRESHOLD): HoldSlices {
  const negScores = rows.filter((r) => r.label === 0).map((r) => r.score);
  const quick: SliceRow[] = []; const held: SliceRow[] = []; let unknown = 0;
  for (const r of rows) {
    if (r.label !== 1) continue;
    if (r.comCreatedMs === null) { unknown++; continue; }
    (Date.parse(`${r.asOf}T00:00:00Z`) < r.comCreatedMs + QUICK_SALE_DAYS * DAY ? quick : held).push(r);
  }
  const stats = (s: SliceRow[]): SliceStats => {
    if (s.length === 0) return { n: 0, recall: null, net_pit_share: null, auc: null };
    const a = s.length >= 2 && negScores.length > 0 ? auc([...s.map((r) => r.score), ...negScores], [...s.map(() => 1), ...negScores.map(() => 0)]) : null;
    return {
      n: s.length, recall: r4(s.filter((r) => r.score >= threshold).length / s.length), net_pit_share: r4(s.filter((r) => r.netPit === 1).length / s.length), auc: a === null ? null : r4(a),
    };
  };
  return { threshold, quick: stats(quick), held: stats(held), unknown_n: unknown };
}
