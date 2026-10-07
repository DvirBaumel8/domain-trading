import type { Kysely } from 'kysely';
import { addDays, dayNumber, idtDay } from '../../../core/dates.js';
import type { Database } from '../../../db/types.js';
import { currentSettings, settingsByVersion } from '../../../pricing/settings.js';
import { priceValues } from './money.js';

const LIVE = ['owned', 'listed', 'delisted'] as const;

export interface UpcomingEvent {
  domain: string; kind: 'first_renewal' | 'final_expiry' | 'fast_transfer' | 'drop_date' | 'price_event'; date: string;
  stage?: number; headsup?: boolean; event?: string; values?: ReturnType<typeof priceValues>; note: string;
}

const stageOf = (days: number, stages: number[]) => stages.find((s) => days <= s)!;

export async function upcoming90d(db: Kysely<Database>, now: Date): Promise<UpcomingEvent[]> {
  const today = idtDay(now);
  const t = dayNumber(today);
  const out: UpcomingEvent[] = [];
  const fp = await db.selectFrom('price_schedule').select(['domain_id', 'plan_id', 'due_on']).where('event', '=', 'final_push').where('status', 'in', ['planned', 'applied']).execute();
  const planOf = new Map<number, string | null>();
  const domains = await db.selectFrom('domains').selectAll().where('status', 'in', LIVE).orderBy('domain').execute();
  for (const d of domains) planOf.set(d.id, d.plan_id);
  const finalPush = new Map(fp.filter((f) => planOf.get(f.domain_id) === f.plan_id).map((f) => [f.domain_id, f.due_on]));
  for (const d of domains) {
    if (d.expiry_date) {
      const days = dayNumber(d.expiry_date) - t;
      if (days >= 0 && days <= 60) {
        // Gate F (drop_date = expiry_date) has no renewal left to decide: it is a final expiry even with renewals_used 0.
        if (d.renewals_used === 0 && d.drop_date !== d.expiry_date) {
          out.push({ domain: d.domain, kind: 'first_renewal', date: d.expiry_date, stage: stageOf(days, [7, 30, 60]),
            note: `First renewal decision: expires in ${days} days. Dvir decides whether to renew (once at most).` });
        } else {
          const push = finalPush.get(d.id) ?? (d.drop_date ? addDays(d.drop_date, -(await currentSettings(db, now)).finalPushDaysBeforeDrop) : 'drop_date − 90');
          out.push({ domain: d.domain, kind: 'final_expiry', date: d.expiry_date, stage: days <= 30 ? 30 : 60,
            note: `Final expiry: won't be renewed again; the final push price is already scheduled at ${push}; consider an outreach push (Gate C).` });
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
      const sameAsFinal = out.some((e) => e.domain === d.domain && e.kind === 'final_expiry' && e.date === d.drop_date);
      if (days >= 0 && days <= 90 && !sameAsFinal) out.push({ domain: d.domain, kind: 'drop_date', date: d.drop_date, note: 'Drop date: the registration lapses.' });
    }
  }
  const byId = new Map(domains.map((d) => [d.id, d]));
  const planned = await db.selectFrom('price_schedule').selectAll().where('status', '=', 'planned').orderBy('due_on').orderBy('id').execute();
  const settings = new Map<number, number>();
  for (const p of planned) {
    const d = byId.get(p.domain_id);
    if (!d || d.plan_id !== p.plan_id) continue;
    const days = dayNumber(p.due_on) - t;
    // Overdue events (due_on before today) are not upcoming; Task 2 reports them as warnings.
    if (days < 0 || days > 90) continue;
    if (!settings.has(p.settings_version)) {
      const st = await settingsByVersion(db, p.settings_version);
      if (!st) throw new Error(`pricing_settings v${p.settings_version} missing for a price_schedule row`);
      settings.set(p.settings_version, st.headsupDaysBefore);
    }
    out.push({
      domain: d.domain, kind: 'price_event', date: p.due_on, event: p.event, headsup: days <= settings.get(p.settings_version)!,
      values: priceValues(p),
      note: `Scheduled price event ${p.event} (pre-approved by the buy approval; information only).`,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.domain.localeCompare(b.domain) || a.kind.localeCompare(b.kind));
}
