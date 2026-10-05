import { ceil95, nice95, pct, round5 } from './round.js';
import type { Category, ListingMode, PriceScheduleEvent, PriceScheduleStatus } from '../db/types.js';
import type { Cents } from './int.js';
import { hybridBinMin } from './plan.js';
import type { PricingSettings } from './settings.js';

export type ScheduleEventName = PriceScheduleEvent;
export type ScheduleStatus = Extract<PriceScheduleStatus, 'planned' | 'skipped_at_minimum' | 'skipped_no_change' | 'skipped_disabled' | 'superseded_by_final_push'>;
export interface ScheduleEvent {
  event: ScheduleEventName; dueOn: string;
  binCents: Cents | null; floorCents: Cents | null; walkawayCents: Cents | null; status: ScheduleStatus;
}

const DATE = new RegExp('^(\\d{4})-(\\d{2})-(\\d{2})$');
const BPS = 10000;
const DROP_NAMES: readonly ScheduleEventName[] = ['drop1_m6', 'drop2_m18'];

function parse(date: string): [number, number, number] {
  const m = DATE.exec(date);
  if (!m) throw new Error(`Not a date: ${date}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const back = new Date(Date.UTC(y, mo - 1, d));
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) throw new Error(`Not a date: ${date}`);
  return [y, mo, d];
}
const fmt = (d: Date) => d.toISOString().slice(0, 10);

/** Same day N months later; clamps to the last day of a shorter month. */
export function addMonthsClamped(date: string, months: number): string {
  const [y, mo, d] = parse(date);
  const target = new Date(Date.UTC(y, mo - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return fmt(new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, lastDay))));
}

export function addDays(date: string, days: number): string {
  const [y, mo, d] = parse(date);
  return fmt(new Date(Date.UTC(y, mo - 1, d + days)));
}

export interface SchedulePlan {
  category: Category; mode: ListingMode; grade: 'strong' | 'weaker' | null;
  binCents: Cents | null; floorCents: Cents | null; walkawayCents: Cents | null;
}

interface Values { bin: Cents; floor: Cents; walk: Cents }

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
  const keep = (list: ScheduleEvent[]) => (startAfter ? list.filter((e) => e.dueOn > startAfter) : list);
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
    if (plan.grade === 'strong' && rule && plan.binCents === rule.fromCents) {
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
    const next = applyDrop(cur, d.pctBps, s);
    if (!next) out.push(ev(name, due, cur, 'skipped_at_minimum'));
    else {
      cur = next;
      out.push(ev(name, due, cur, 'planned'));
    }
  });

  const pushedBin = Math.min(cur.bin, Math.max(ceil95(cur.floor), hybridBinMin(s)));
  out.push(pushedBin === cur.bin ? ev('final_push', finalOn, cur, 'skipped_no_change') : ev('final_push', finalOn, { ...cur, bin: pushedBin }, 'planned'));
  out.push(ev('delist', delistOn, null, 'planned'));
  return keep(out);
}
