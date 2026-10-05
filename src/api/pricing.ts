import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { jerusalemDate } from '../dates.js';
import type { Database } from '../db/types.js';
import { normalizeDomain } from '../domain-name.js';
import { AppError } from '../http/errors.js';
import { dollarsToCents, formatUsd } from '../money.js';
import { computePlan, type PlanCategory } from '../pricing/plan.js';
import { sellPlanLine, wholeUsd } from '../pricing/present.js';
import { pct } from '../pricing/round.js';
import { addMonthsClamped, buildSchedule } from '../pricing/schedule.js';
import { currentSettings } from '../pricing/settings.js';
import { afternicRow } from '../services/export.js';
import { isCategory } from '../services/listing-rules.js';
import { scheduleView } from '../services/plan-view.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONEY = /^\d+(\.\d{1,2})?$/;
const NET_BPS = 8500; // display only: net after Afternic's 15% Basic commission

const Query = z.object({
  category: z.string().optional(),
  bin: z.string().optional(),
  grade: z.enum(['strong', 'weaker']).optional(),
  floor: z.string().optional(),
  walkaway: z.string().optional(),
  listed_on: z.string().regex(DATE).optional(),
  drop_date: z.string().regex(DATE).optional(),
  domain: z.string().optional(),
}).strict();

const cents = (v: string | undefined, f: string) => {
  if (v === undefined) return undefined;
  if (!MONEY.test(v)) throw new AppError(400, 'VALIDATION_ERROR', `${f} must be a positive USD amount with at most 2 decimals`);
  try {
    return dollarsToCents(Number(v));
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', `${f} must be a positive USD amount with at most 2 decimals`);
  }
};

function validDate(d: string, f: string): string {
  const t = new Date(`${d}T00:00:00Z`);
  if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d) throw new AppError(400, 'VALIDATION_ERROR', `${f} is not a real date`);
  return d;
}

export function registerPricing(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number }): void {
  app.get('/pricing/preview', async (req) => {
    const parsed = Query.safeParse(req.query);
    if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid preview query', { issues: parsed.error.issues.map((i) => i.message) });
    const q = parsed.data;
    if (!isCategory(q.category)) throw new AppError(422, 'CATEGORY_REQUIRED', 'category is required (geo, trend, b2b, collision, regulation, buzzword, other)');
    const now = new Date(deps.now());
    const s = await currentSettings(deps.db, now);

    const exception = q.floor !== undefined || q.walkaway !== undefined;
    const r = computePlan({
      category: q.category as PlanCategory, grade: q.grade ?? null, binCents: cents(q.bin, 'bin'),
      floorCents: cents(q.floor, 'floor'), walkawayCents: cents(q.walkaway, 'walkaway'), exception,
    }, s);
    if (!r.ok) throw new AppError(422, r.code, r.message, r.details ?? {});
    const plan = r.plan;

    const today = jerusalemDate(now);
    const listedOn = q.listed_on ? validDate(q.listed_on, 'listed_on') : today;
    let name = 'example.com';
    let dropDate: string | undefined;
    if (q.domain) {
      if (q.drop_date) throw new AppError(400, 'VALIDATION_ERROR', 'drop_date comes from the domain');
      const key = normalizeDomain(q.domain);
      const row = await deps.db.selectFrom('domains').select(['domain', 'display_name', 'drop_date']).where('domain', '=', key).executeTakeFirst();
      if (!row) throw new AppError(404, 'DOMAIN_NOT_FOUND', 'No such domain', { domain: key });
      name = row.display_name ?? row.domain;
      dropDate = row.drop_date ?? undefined;
    } else if (q.drop_date) {
      dropDate = validDate(q.drop_date, 'drop_date');
    }
    dropDate = dropDate ?? addMonthsClamped(today, 24);
    if (dropDate <= listedOn) throw new AppError(400, 'VALIDATION_ERROR', 'drop_date must be after listed_on');
    const schedule = buildSchedule({ plan, anchor: listedOn, dropDate, settings: s });

    const a = afternicRow({
      domain: name.toLowerCase(), display_name: name, listing_mode: plan.mode, bin_cents: plan.binCents,
      floor_cents: plan.floorCents, min_offer_cents: plan.minOfferCents, lto_max_months: null,
    });

    return {
      settings_version: plan.settingsVersion, category: plan.category, mode: plan.mode, pricing_source: plan.pricingSource, grade: plan.grade,
      bin_cents: plan.binCents, floor_cents: plan.floorCents, walkaway_cents: plan.walkawayCents, min_offer_cents: plan.minOfferCents,
      display: { bin: wholeUsd(plan.binCents), floor: wholeUsd(plan.floorCents), walkaway: `${wholeUsd(plan.walkawayCents)} (private)`, min_offer: wholeUsd(plan.minOfferCents) },
      net_at_15pct: { bin: formatUsd(pct(plan.binCents, NET_BPS)), floor: formatUsd(pct(plan.floorCents, NET_BPS)), walkaway: formatUsd(pct(plan.walkawayCents, NET_BPS)) },
      schedule: scheduleView(schedule),
      afternic_row: 'cells' in a.row ? a.row.cells.join(',') : null,
      sell_plan_line: sellPlanLine(plan, schedule),
      warnings: plan.warnings,
    };
  });
}
