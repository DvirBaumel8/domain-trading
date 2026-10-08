import { addDays, addMonthsClamped } from '../../../core/dates.js';
import { ceil95, nice95, pct, round5 } from './round.js';
import type { Category, ListingMode, PriceScheduleEvent, PriceScheduleStatus } from '../../../db/types.js';
import type { Cents } from './int.js';
import { hybridBinMin, priceFormula } from './plan.js';
import { isV3, type PricingSettings } from './settings.js';

export type ScheduleEventName = PriceScheduleEvent;
export type ScheduleStatus = Extract<PriceScheduleStatus, 'planned' | 'skipped_at_minimum' | 'skipped_no_change' | 'skipped_disabled' | 'superseded_by_final_push'>;
export interface ScheduleEvent {
  event: ScheduleEventName; dueOn: string;
  binCents: Cents | null; floorCents: Cents | null; walkawayCents: Cents | null; status: ScheduleStatus | PriceScheduleStatus;
}

const BPS = 10000;
const DROP_NAMES: readonly ScheduleEventName[] = ['drop1_m6', 'drop2_m18'];

export interface SchedulePlan {
  category: Category; mode: ListingMode; grade: 'strong' | 'weaker' | null;
  binCents: Cents | null; floorCents: Cents | null; walkawayCents: Cents | null;
}

interface Values { bin: Cents; floor: Cents; walk: Cents }

/** The price list for a lane: non-geo from `nongeo_bin_min`, geo within `geo_bin_min..geo_bin_max` (ascending). */
export function laneList(lane: 'geo' | 'nongeo', s: PricingSettings): Cents[] {
  const all = [...(s.allowedBinsCents ?? [])].sort((a, b) => a - b);
  return lane === 'geo'
    ? all.filter((v) => v >= s.geoBinMinCents && v <= s.geoBinMaxCents)
    : all.filter((v) => v >= (s.nongeoBinMinCents ?? 0));
}

/** v3: the BIN `steps` rungs below `bin` on the lane's price list; null when already at the bottom. */
export function ladderStep(bin: Cents, steps: number, lane: 'geo' | 'nongeo', s: PricingSettings): Cents | null {
  const below = laneList(lane, s).filter((v) => v < bin);
  if (below.length === 0 || steps < 1) return null;
  return below[Math.max(0, below.length - steps)]!;
}

/** v3 final push: the lowest list price that is still >= floor and <= BIN. */
function lowestListedAtOrAboveFloor(v: Values, s: PricingSettings): Cents {
  return laneList('nongeo', s).find((x) => x >= v.floor && x <= v.bin) ?? v.bin;
}

function applyDrop(v: Values, pctBps: number, s: PricingSettings): Values | null {
  const keep = BPS - pctBps;
  const bin = Math.max(nice95(pct(v.bin, keep)), hybridBinMin(s));
  if (bin >= v.bin) return null; // can't lower the BIN: skipped_at_minimum, nothing changes
  const floor = Math.min(bin, Math.max(round5(pct(v.floor, keep)), s.floorMinCents));
  const walk = Math.min(floor, Math.max(round5(pct(v.walk, keep)), s.walkawayMinCents));
  return { bin, floor, walk };
}

export function buildSchedule(input: {
  plan: SchedulePlan; anchor: string; dropDate: string; settings: PricingSettings; startAfter?: string;
}): ScheduleEvent[] {
  const { plan, anchor, dropDate, settings: s, startAfter } = input;
  const keep = (list: ScheduleEvent[]) => (startAfter ? list.filter((e) => e.event === 'delist' || e.dueOn > startAfter) : list);
  const out: ScheduleEvent[] = [];
  const delistOn = addDays(dropDate, -s.delistDaysBeforeDrop);
  const ev = (event: ScheduleEventName, dueOn: string, v: Values | null, status: ScheduleStatus): ScheduleEvent => ({
    event, dueOn, binCents: v?.bin ?? null, floorCents: v?.floor ?? null, walkawayCents: v?.walk ?? null, status,
  });

  const standardGeo = plan.category === 'geo' && plan.mode === 'bin';
  const standardHybrid = plan.category !== 'geo' && plan.mode === 'hybrid';
  if (!standardGeo && !standardHybrid) return keep([ev('delist', delistOn, null, 'planned')]);

  if (standardGeo) {
    const rule = s.geoDrops[0];
    if (s.dropMode === 'ladder') {
      const next = rule && plan.binCents !== null ? ladderStep(plan.binCents, rule.steps ?? 1, 'geo', s) : null;
      if (rule && next !== null) {
        const due = addMonthsClamped(anchor, rule.afterMonths);
        const v = { bin: next, floor: next, walk: next };
        if (!s.geoDropsEnabled) out.push(ev('geo_drop_m12', due, null, 'skipped_disabled'));
        else if (due >= delistOn) out.push(ev('geo_drop_m12', due, null, 'superseded_by_final_push'));
        else out.push(ev('geo_drop_m12', due, v, 'planned'));
      }
      out.push(ev('delist', delistOn, null, 'planned'));
      return keep(out);
    }
    if (plan.grade === 'strong' && rule && rule.toCents != null && plan.binCents === rule.fromCents) {
      const due = addMonthsClamped(anchor, rule.afterMonths);
      const v = { bin: rule.toCents, floor: rule.toCents, walk: rule.toCents };
      if (!s.geoDropsEnabled) out.push(ev('geo_drop_m12', due, null, 'skipped_disabled'));
      else if (due >= delistOn) out.push(ev('geo_drop_m12', due, null, 'superseded_by_final_push'));
      else out.push(ev('geo_drop_m12', due, v, 'planned'));
    }
    out.push(ev('delist', delistOn, null, 'planned'));
    return keep(out);
  }

  const finalOn = addDays(dropDate, -s.finalPushDaysBeforeDrop);
  if (plan.binCents === null || plan.floorCents === null || plan.walkawayCents === null) throw new Error('hybrid plan without prices');
  let cur: Values = { bin: plan.binCents, floor: plan.floorCents, walk: plan.walkawayCents };
  s.drops.forEach((d, i) => {
    const name = DROP_NAMES[i];
    if (!name) return;
    const due = addMonthsClamped(anchor, d.afterMonths);
    if (startAfter && due <= startAfter) return;
    if (due >= finalOn) {
      out.push(ev(name, due, null, 'superseded_by_final_push'));
      return;
    }
    let next: Values | null;
    if (s.dropMode === 'ladder') {
      const bin = ladderStep(cur.bin, d.steps ?? 1, 'nongeo', s);
      if (bin === null) next = null;
      else {
        const f = priceFormula(bin, s); // recomputed from the new BIN; an exception does not carry through
        next = { bin, floor: f.floorCents, walk: f.walkawayCents };
      }
    } else next = applyDrop(cur, d.pctBps ?? 0, s);
    if (!next) out.push(ev(name, due, cur, 'skipped_at_minimum'));
    else {
      cur = next;
      out.push(ev(name, due, cur, 'planned'));
    }
  });

  const pushedBin = s.finalPushMode === 'bin_to_lowest_listed_ge_floor' && isV3(s)
    ? lowestListedAtOrAboveFloor(cur, s)
    : Math.min(cur.bin, Math.max(ceil95(cur.floor), hybridBinMin(s)));
  out.push(pushedBin === cur.bin ? ev('final_push', finalOn, cur, 'skipped_no_change') : ev('final_push', finalOn, { ...cur, bin: pushedBin }, 'planned'));
  out.push(ev('delist', delistOn, null, 'planned'));
  return keep(out);
}
