import { sellPlanLine, wholeUsd } from '../pricing/present.js';
import type { Plan } from '../pricing/plan.js';
import type { ScheduleEvent } from '../pricing/schedule.js';
import type { ListingPlan } from './listing-v2.js';

interface EventLike {
  event: string; dueOn: string; binCents: number | null; floorCents: number | null; walkawayCents: number | null; status: string;
}

export function scheduleView(events: EventLike[]): object[] {
  return events.map((e) => (e.event === 'delist' || e.status === 'superseded_by_final_push' || e.status === 'superseded'
    || e.binCents === null || e.floorCents === null || e.walkawayCents === null
    ? { event: e.event, due_on: e.dueOn, status: e.status }
    : { event: e.event, due_on: e.dueOn, bin: wholeUsd(e.binCents), floor: wholeUsd(e.floorCents), walkaway: wholeUsd(e.walkawayCents), status: e.status }));
}

const money = (c: number | null) => (c === null ? null : wholeUsd(c));

export function planView(plan: ListingPlan, events: ScheduleEvent[] = []): object {
  const standard = (plan.category === 'geo' && plan.mode === 'bin') || (plan.category !== 'geo' && plan.mode === 'hybrid');
  let line: string | null = null;
  if (standard && plan.binCents !== null && plan.floorCents !== null && plan.walkawayCents !== null && (plan.mode === 'bin' || plan.mode === 'hybrid')) {
    const p: Plan = {
      mode: plan.mode, category: plan.category, grade: plan.grade, binCents: plan.binCents, floorCents: plan.floorCents,
      walkawayCents: plan.walkawayCents, minOfferCents: plan.minOfferCents, pricingSource: plan.pricingSource,
      settingsVersion: plan.settingsVersion, warnings: plan.warnings, formula: plan.formula,
    };
    line = sellPlanLine(p, events);
  }
  return {
    mode: plan.mode, category: plan.category, price_grade: plan.grade,
    bin_cents: plan.binCents, bin: money(plan.binCents),
    floor_cents: plan.floorCents, floor: money(plan.floorCents),
    walkaway_cents: plan.walkawayCents, walkaway: plan.walkawayCents === null ? null : `${wholeUsd(plan.walkawayCents)} (private)`,
    min_offer_cents: plan.minOfferCents, min_offer: wholeUsd(plan.minOfferCents),
    lto_max_months: plan.ltoMaxMonths, pricing_source: plan.pricingSource, settings_version: plan.settingsVersion, override: plan.overrideUsed,
    schedule: scheduleView(events), sell_plan_line: line,
  };
}
