import { wholeUsd } from '../core/money.js';
import type { Cents } from './int.js';
import type { Plan } from './plan.js';
import type { ScheduleEvent, ScheduleEventName } from './schedule.js';

const LABELS: Record<ScheduleEventName, string> = {
  drop1_m6: 'M6', drop2_m18: 'M18', geo_drop_m12: 'M12', final_push: 'final push', delist: 'delist',
};
export const eventLabel = (e: ScheduleEventName) => LABELS[e];

const SKIP_TEXT: Partial<Record<ScheduleEvent['status'], string>> = {
  skipped_at_minimum: 'skipped (minimum)', skipped_no_change: 'skipped (no change)', skipped_disabled: 'skipped (disabled)',
};

function eventText(plan: Plan, e: ScheduleEvent): string | null {
  if (e.status === 'superseded_by_final_push') return null;
  const skip = SKIP_TEXT[e.status];
  if (skip) return `${eventLabel(e.event)} ${skip}`;
  if (e.event === 'delist') return `delist ${e.dueOn}`;
  if (plan.mode === 'bin') return `${eventLabel(e.event)} ${e.dueOn} ${wholeUsd(e.binCents!)}`;
  return `${eventLabel(e.event)} ${e.dueOn} ${wholeUsd(e.binCents!)}/${wholeUsd(e.floorCents!)}/${wholeUsd(e.walkawayCents!)}`;
}

export function sellPlanLine(plan: Plan, schedule: ScheduleEvent[], ltoMaxMonths?: number | null): string {
  const head = plan.mode === 'bin'
    ? [`bin (geo ${plan.grade}) · BIN ${wholeUsd(plan.binCents)} · no offers`]
    : [`hybrid · BIN ${wholeUsd(plan.binCents)} · floor (auto-accept) ${wholeUsd(plan.floorCents)} · walk-away (private) ${wholeUsd(plan.walkawayCents)} · min offer ${wholeUsd(plan.minOfferCents)} · ${ltoMaxMonths ? `LTO ${ltoMaxMonths} mo` : 'LTO off'}`];
  const events = schedule.map((e) => eventText(plan, e)).filter((t): t is string => t !== null);
  return [...head, ...events, `settings v${plan.settingsVersion}`].join(' · ');
}
