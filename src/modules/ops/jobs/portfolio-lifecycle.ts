// Daily step `portfolioLifecycle` (v4.0.0; CR-044 item 6, CR-045 item 1, G-85). Three parts, all database rows and public lookups; it never calls a registrar or a marketplace:
//   1. expireUnrenewed: a live name past its first expiry that was not renewed (renewals_used 0, drop_date later than the expiry) is marked delisted, so it leaves every
//      venue (MANUAL_DELIST) and /report keeps EXPIRED_NOT_RENEWED until Dvir decides; DropJob marks it dropped at its drop_date.
//   2. lookalikes: a name inside the renewal drop-check window gets the CR-043 lookalike check re-run once a month (portfolio_checks kind lookalikes), the "rise since buy" signal.
//   3. holdout: once per IDT month, 20 passed + 20 failed screened, not bought names (seeded pick) are stored; each is re-checked once after holdout_recheck_months.
import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { trySessionLock } from '../../../core/locks.js';
import { addDays, addMonthsClamped, idtDay } from '../../../core/dates.js';
import type { Database } from '../../../db/types.js';
import { newAuditId } from '../../../http/audit.js';
import { activeSelectionSettings, rerunLookalikes, screenedNames, type ScreeningDeps } from '../../selection/index.js';

export const LOOKALIKE_RECHECK_DAYS = 30;
export const LOOKALIKE_MAX_PER_RUN = 10;
export const HOLDOUT_RECHECK_MAX_PER_RUN = 10;
const seeded = (seed: string, domain: string): string => createHash('sha256').update(`${seed}:${domain}`).digest('hex');

export interface LifecycleSummary {
  skipped: boolean; expired: string[]; lookalikes: { domain: string; ok: boolean }[];
  holdout: { month: string; picked: { passed: number; failed: number } | null; rechecked: string[] };
}

export class PortfolioLifecycleJob {
  constructor(private readonly deps: {
    db: Kysely<Database>; screening: ScreeningDeps; now: () => number; log?: { warn(o: object, m: string): void };
    /** Test injection: the screened-name pool and the lookalike re-run. Production passes nothing. */
    screened?: typeof screenedNames; lookalikes?: typeof rerunLookalikes;
  }) {}

  private relook(domain: string) { return (this.deps.lookalikes ?? rerunLookalikes)(this.deps.db, this.deps.screening, domain, this.deps.now); }

  async runOnce(): Promise<LifecycleSummary> {
    const out: LifecycleSummary = { skipped: false, expired: [], lookalikes: [], holdout: { month: '', picked: null, rechecked: [] } };
    const lock = await trySessionLock(this.deps.db, 'job:portfolio-lifecycle');
    if (!lock) return { ...out, skipped: true };
    try {
      const today = idtDay(new Date(this.deps.now()));
      out.holdout.month = today.slice(0, 7);
      out.expired = await this.expireUnrenewed(today);
      out.lookalikes = await this.lookalikes(today);
      out.holdout.picked = await this.holdoutPick(today);
      out.holdout.rechecked = await this.holdoutRecheck(today);
      return out;
    } finally {
      await lock.release();
    }
  }

  private async expireUnrenewed(today: string): Promise<string[]> {
    const { db } = this.deps;
    const rows = await db.selectFrom('domains').select(['id', 'domain', 'status', 'expiry_date', 'drop_date'])
      .where('status', 'in', ['owned', 'listed', 'delisted']).where('renewals_used', '=', 0).where('expiry_date', '<', today).orderBy('domain').execute();
    const done: string[] = [];
    for (const d of rows) {
      if (d.status === 'delisted' || d.drop_date === null || d.drop_date <= today) continue; // already off the venues, or DropJob drops it today
      const now = new Date(this.deps.now());
      await db.transaction().execute(async (trx) => {
        await trx.updateTable('domains').set({ status: 'delisted', delisted_at: now, updated_at: now, ...(d.status === 'listed' ? { listing_changed_at: now } : {}) })
          .where('id', '=', d.id).where('status', 'in', ['owned', 'listed']).execute();
        await trx.insertInto('audit_log').values({
          id: newAuditId(), at: now, scope: 'job', method: 'JOB', path: 'expire-unrenewed', request: JSON.stringify({ domain: d.domain, expiry_date: d.expiry_date, drop_date: d.drop_date }),
          status_code: 200, result_summary: `expired ${d.expiry_date} not renewed; ${d.status} -> delisted`,
        }).execute();
      });
      done.push(d.domain);
    }
    return done;
  }

  private async lookalikes(today: string): Promise<{ domain: string; ok: boolean }[]> {
    const { db } = this.deps;
    const days = (await activeSelectionSettings(db)).values.renewal.drop_check_days;
    const rows = await db.selectFrom('domains').select(['id', 'domain', 'expiry_date'])
      .where('status', 'in', ['owned', 'listed', 'delisted']).where('renewals_used', '=', 0).where('expiry_date', '>=', today).where('expiry_date', '<=', addDays(today, days)).orderBy('expiry_date').orderBy('domain').execute();
    const out: { domain: string; ok: boolean }[] = [];
    for (const d of rows) {
      if (out.length >= LOOKALIKE_MAX_PER_RUN) break;
      const last = await db.selectFrom('portfolio_checks').select('at').where('domain_id', '=', d.id).where('kind', '=', 'lookalikes').orderBy('id', 'desc').limit(1).executeTakeFirst();
      if (last && idtDay(last.at) > addDays(today, -LOOKALIKE_RECHECK_DAYS)) continue;
      let counts = null;
      try { counts = await this.relook(d.domain); } catch (e) { this.deps.log?.warn({ domain: d.domain, errMessage: (e as Error).message }, 'lookalike re-check failed'); }
      await db.insertInto('portfolio_checks').values({
        domain_id: d.id, at: new Date(this.deps.now()), kind: 'lookalikes', status: counts ? 'ok' : 'unknown', details: JSON.stringify(counts ?? { reason: 'lookalike check unavailable' }),
      }).execute();
      out.push({ domain: d.domain, ok: counts !== null });
    }
    return out;
  }

  private async holdoutPick(today: string): Promise<{ passed: number; failed: number } | null> {
    const { db } = this.deps;
    const month = today.slice(0, 7);
    const exists = await db.selectFrom('holdout').select('id').where('month', '=', month).limit(1).executeTakeFirst();
    if (exists) return null;
    const p = (await activeSelectionSettings(db)).values.portfolio;
    const bought = new Set((await db.selectFrom('domains').select('domain').execute()).map((d) => d.domain));
    const earlier = new Set((await db.selectFrom('holdout').select('domain').execute()).map((d) => d.domain));
    const pool = (await (this.deps.screened ?? screenedNames)(db, new Date(Date.parse(`${addMonthsClamped(today, -1)}T00:00:00Z`)))).filter((n) => !bought.has(n.domain) && !earlier.has(n.domain));
    const take = (passed: boolean, n: number) => pool.filter((x) => x.passed === passed).sort((a, b) => (seeded(month, a.domain) < seeded(month, b.domain) ? -1 : 1)).slice(0, n);
    const picks = [...take(true, p.holdout_passed_n).map((x) => ({ ...x, grp: 'passed' as const })), ...take(false, p.holdout_failed_n).map((x) => ({ ...x, grp: 'failed' as const }))];
    if (picks.length === 0) return { passed: 0, failed: 0 };
    for (const x of picks) {
      let at: unknown = null;
      try { at = await this.relook(x.domain); } catch { at = null; }
      await db.insertInto('holdout').values({ month, domain: x.domain, grp: x.grp, run_id: x.run_id, seed: month, lookalikes_at_pick: at ? JSON.stringify(at) : null }).execute();
    }
    return { passed: picks.filter((x) => x.grp === 'passed').length, failed: picks.filter((x) => x.grp === 'failed').length };
  }

  private async holdoutRecheck(today: string): Promise<string[]> {
    const { db } = this.deps;
    const months = (await activeSelectionSettings(db)).values.portfolio.holdout_recheck_months;
    const cutoff = addMonthsClamped(today, -months);
    const due = await sql<{ id: number; domain: string; lookalikes_at_pick: Record<string, number | null> | null }>`
      select id, domain, lookalikes_at_pick from holdout where recheck_at is null and picked_at <= ${new Date(Date.parse(`${cutoff}T23:59:59Z`))} order by id limit ${HOLDOUT_RECHECK_MAX_PER_RUN}`.execute(db);
    const done: string[] = [];
    for (const h of due.rows) {
      let now: { registered_n: number | null; in_use_n: number | null; unknown_n: number | null } | null = null;
      try { now = await this.relook(h.domain); } catch { now = null; }
      const before = h.lookalikes_at_pick;
      const delta = now && before ? { registered_n: (now.registered_n ?? 0) - (before.registered_n ?? 0), in_use_n: (now.in_use_n ?? 0) - (before.in_use_n ?? 0) } : null;
      await db.updateTable('holdout').set({ recheck_at: new Date(this.deps.now()), lookalikes_recheck: now ? JSON.stringify(now) : null, delta: delta ? JSON.stringify(delta) : null }).where('id', '=', h.id).execute();
      done.push(h.domain);
    }
    return done;
  }
}
