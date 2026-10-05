import type { Kysely } from 'kysely';
import { jerusalemDate } from '../../dates.js';
import type { Database } from '../../db/types.js';
import { settingsByVersion } from '../../pricing/settings.js';
import { addDays, dayNumber } from './domains.js';
import { moneyOrNull } from './money.js';

const LIVE = ['owned', 'listed', 'delisted'] as const;

export interface UpcomingEvent {
  domain: string; kind: 'first_renewal' | 'final_expiry' | 'fast_transfer' | 'drop_date' | 'price_event'; date: string;
  stage?: number; headsup?: boolean; event?: string; values?: { bin: ReturnType<typeof moneyOrNull>; floor: ReturnType<typeof moneyOrNull>; walkaway: ReturnType<typeof moneyOrNull> }; note: string;
}

const stageOf = (days: number, stages: number[]) => stages.find((s) => days <= s)!;

export async function upcoming90d(db: Kysely<Database>, now: Date): Promise<UpcomingEvent[]> {
  const today = jerusalemDate(now);
  const t = dayNumber(today);
  const out: UpcomingEvent[] = [];
  const domains = await db.selectFrom('domains').selectAll().where('status', 'in', LIVE).orderBy('domain').execute();
  for (const d of domains) {
    if (d.expiry_date) {
      const days = dayNumber(d.expiry_date) - t;
      if (days >= 0 && days <= 60) {
        if (d.renewals_used === 0) {
          out.push({ domain: d.domain, kind: 'first_renewal', date: d.expiry_date, stage: stageOf(days, [7, 30, 60]),
            note: `First renewal decision: expires in ${days} days. Dvir decides whether to renew (once at most).` });
        } else {
          out.push({ domain: d.domain, kind: 'final_expiry', date: d.expiry_date, stage: days <= 30 ? 30 : 60,
            note: 'Final expiry: this name will not be extended again; the final push price is already scheduled at drop_date − 90; consider an outreach push (Gate C).' });
        }
      }
    }
    if (d.buy_date) {
      const ft = addDays(d.buy_date, 60);
      const days = dayNumber(ft) - t;
      if (days >= 0 && days <= 90) out.push({ domain: d.domain, kind: 'fast_transfer', date: ft, note: 'Fast Transfer opt-in date (buy date + 60 days).' });
    }
    if (d.drop_date) {
      const days = dayNumber(d.drop_date) - t;
      if (days >= 0 && days <= 90) out.push({ domain: d.domain, kind: 'drop_date', date: d.drop_date, note: 'Drop date: the registration lapses.' });
    }
  }
  const byId = new Map(domains.map((d) => [d.id, d]));
  const planned = await db.selectFrom('price_schedule').selectAll().where('status', '=', 'planned').orderBy('due_on').orderBy('id').execute();
  const settings = new Map<number, number>();
  for (const p of planned) {
    const d = byId.get(p.domain_id);
    if (!d || d.plan_id !== p.plan_id) continue;
    const days = dayNumber(p.due_on) - t;
    if (days > 90) continue;
    if (!settings.has(p.settings_version)) settings.set(p.settings_version, (await settingsByVersion(db, p.settings_version))?.headsupDaysBefore ?? 7);
    out.push({
      domain: d.domain, kind: 'price_event', date: p.due_on, event: p.event, headsup: days <= settings.get(p.settings_version)!,
      values: { bin: moneyOrNull(p.bin_cents), floor: moneyOrNull(p.floor_cents), walkaway: moneyOrNull(p.walkaway_cents) },
      note: `Scheduled price event ${p.event} (pre-approved by the buy approval; information only).`,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.domain.localeCompare(b.domain) || a.kind.localeCompare(b.kind));
}
