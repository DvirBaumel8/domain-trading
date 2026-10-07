import type { Kysely, Transaction } from 'kysely';
import { trySessionLock } from '../core/locks.js';
import type { Database, DomainRow, ListingMode, PriceScheduleTable } from '../db/types.js';
import type { Selectable } from 'kysely';
import { idtDay, isYmd } from '../core/dates.js';
import { newAuditId } from '../http/audit.js';
import { hybridBinMin } from '../pricing/plan.js';
import { isV3, settingsByVersion, type PricingSettings } from '../pricing/settings.js';
import { changedColumns } from '../services/export-state.js';
import { withDomainLock } from '../core/locks.js';

type Row = Selectable<PriceScheduleTable>;
type Q = Kysely<Database> | Transaction<Database>;

export interface PriceJobResult {
  today: string; dryRun: boolean; skipped: boolean;
  applied: { domain: string; event: string; rowId: number; bin_cents: number | null; floor_cents: number | null }[];
  superseded: number[]; failed: { domain: string; rowId: number; reason: string }[];
  held: string[]; delisted: string[]; cancelled: number[];
}


/** V5/V6 re-check of a planned row against the settings version it was planned under (R8). Returns a reason or null. */
export function rowValid(row: Pick<Row, 'bin_cents' | 'floor_cents' | 'walkaway_cents'>, s: PricingSettings, mode: ListingMode | null): string | null {
  const { bin_cents: bin, floor_cents: floor, walkaway_cents: walk } = row;
  if (bin === null || floor === null || walk === null) return 'row has no prices';
  if ([bin, floor, walk].some((v) => v % 100 !== 0)) return 'prices are not whole dollars';
  if (mode === 'hybrid') {
    if (!(s.walkawayMinCents <= walk && walk <= floor && floor <= bin)) return 'walk-away/floor/BIN order or walk-away minimum violated';
    if (floor < s.floorMinCents) return 'floor below the floor minimum';
    if (bin < hybridBinMin(s)) return 'BIN below the minimum hybrid BIN';
    if (isV3(s) && !(s.allowedBinsCents ?? []).includes(bin)) return 'BIN not on the price list';
    return null;
  }
  if (mode === 'bin') {
    if (bin < s.geoBinMinCents || bin > s.geoBinMaxCents) return 'geo BIN outside the allowed range';
    if (isV3(s) && !(s.allowedBinsCents ?? []).includes(bin)) return 'geo BIN not on the price list';
    if (floor !== bin || walk !== bin) return 'geo floor and walk-away must equal the BIN';
    return null;
  }
  return `mode ${mode ?? 'none'} cannot take scheduled prices`;
}

type Partial_ = Omit<PriceJobResult, 'today' | 'dryRun' | 'skipped'>;
const emptyPartial = (): Partial_ => ({ applied: [], superseded: [], failed: [], held: [], delisted: [], cancelled: [] });

export class PriceScheduleJob {
  constructor(private readonly deps: {
    db: Kysely<Database>; now: () => number; lockTimeoutMs?: number;
    log?: { warn(o: object, m: string): void; error(o: object, m: string): void };
  }) {}

  async runOnce(opts: { today?: string; dryRun?: boolean } = {}): Promise<PriceJobResult> {
    const today = opts.today ?? idtDay(new Date(this.deps.now()));
    if (!isYmd(today)) throw new Error(`today must be YYYY-MM-DD, got ${today}`);
    const dryRun = opts.dryRun ?? false;
    const out: PriceJobResult = { today, dryRun, skipped: false, ...emptyPartial() };
    const lock = await trySessionLock(this.deps.db, 'job:price');
    if (!lock) return { ...out, skipped: true };
    try {
      const doms = await this.deps.db.selectFrom('price_schedule').innerJoin('domains', 'domains.id', 'price_schedule.domain_id')
        .select(['domains.id as id', 'domains.domain as domain']).distinct()
        .where('price_schedule.status', '=', 'planned').where('price_schedule.due_on', '<=', today).orderBy('domains.domain').execute();
      for (const d of doms) {
        try {
          const part = dryRun
            ? await this.processDomain(this.deps.db, d.id, d.domain, today, true)
            : await withDomainLock(this.deps.db, d.domain, (conn) => conn.transaction().execute((trx) => this.processDomain(trx, d.id, d.domain, today, false)),
              { timeoutMs: this.deps.lockTimeoutMs });
          // merged only after the transaction committed
          out.applied.push(...part.applied); out.superseded.push(...part.superseded); out.failed.push(...part.failed);
          out.held.push(...part.held); out.delisted.push(...part.delisted); out.cancelled.push(...part.cancelled);
        } catch (e) {
          const message = (e as Error).message;
          this.deps.log?.error({ domain: d.domain, errMessage: message }, 'price job failed for domain');
          out.failed.push({ domain: d.domain, rowId: 0, reason: 'error' });
          if (!dryRun) {
            try {
              await this.deps.db.insertInto('audit_log').values({
                id: newAuditId(), scope: 'job', method: 'JOB', path: 'price-schedule',
                request: JSON.stringify({ domain: d.domain, today }), status_code: 500, result_summary: `error: ${message}`,
              }).execute();
            } catch (ae) {
              this.deps.log?.error({ domain: d.domain, errMessage: (ae as Error).message }, 'price job error audit failed');
            }
          }
        }
      }
      return out;
    } finally {
      await lock.release();
    }
  }

  private async processDomain(q: Q, domainId: number, domain: string, today: string, dry: boolean): Promise<Partial_> {
    const now = new Date(this.deps.now());
    let base = q.selectFrom('domains').selectAll().where('id', '=', domainId);
    if (!dry) base = base.forUpdate();
    const cur: DomainRow | undefined = await base.executeTakeFirst();
    const res = emptyPartial();
    if (!cur) return res;
    const planned = await q.selectFrom('price_schedule').selectAll().where('domain_id', '=', domainId).where('status', '=', 'planned').orderBy('due_on').orderBy('id').execute();
    const setStatus = async (ids: number[], status: Row['status'], note?: string) => {
      if (dry || ids.length === 0) return;
      await q.updateTable('price_schedule').set({ status, updated_at: now, ...(note !== undefined ? { note } : {}) }).where('id', 'in', ids).execute();
    };
    const audit = async (event: string, rowId: number, summary: string, code = 200) => {
      if (dry) return;
      await q.insertInto('audit_log').values({
        id: newAuditId(), scope: 'job', method: 'JOB', path: 'price-schedule',
        request: JSON.stringify({ domain, event, row_id: rowId, today }), status_code: code, result_summary: summary,
      }).execute();
    };

    // other plans' planned rows should not exist; retire them
    const stray = planned.filter((r) => r.plan_id !== cur.plan_id && r.due_on <= today).map((r) => r.id);
    await setStatus(stray, 'superseded');
    res.superseded.push(...stray);
    const strayIds = new Set(stray);

    if (cur.status === 'sold' || cur.status === 'dropped') {
      const ids = planned.filter((r) => !strayIds.has(r.id)).map((r) => r.id);
      await setStatus(ids, 'cancelled');
      res.cancelled.push(...ids);
      return res;
    }
    if (cur.status !== 'listed') return res;

    const due = planned.filter((r) => r.plan_id === cur.plan_id && r.due_on <= today);
    const delist = due.find((r) => r.event === 'delist');
    if (delist) {
      const others = planned.filter((r) => r.id !== delist.id && !strayIds.has(r.id)).map((r) => r.id);
      if (!dry) {
        await q.updateTable('domains').set({ status: 'delisted', delisted_at: now, updated_at: now, listing_changed_at: now }).where('id', '=', domainId).execute();
        const h = await q.insertInto('listing_history').values({
          domain_id: domainId, at: now, source: 'schedule', category: cur.category, mode: cur.listing_mode, bin_cents: cur.bin_cents, floor_cents: cur.floor_cents,
          min_offer_cents: cur.min_offer_cents, lto_max_months: cur.lto_max_months, lander: cur.lander, override: false, override_reason: null,
          approval_text: null, approval_at: null, audit_id: null, price_grade: cur.price_grade, walkaway_cents: cur.walkaway_cents,
          pricing_source: cur.pricing_source, pricing_settings_version: delist.settings_version, schedule_event_id: delist.id, plan_audit_id: cur.plan_audit_id,
        }).returning('id').executeTakeFirstOrThrow();
        await q.updateTable('price_schedule').set({ status: 'applied', applied_at: now, listing_history_id: h.id, updated_at: now }).where('id', '=', delist.id).execute();
        await setStatus(others, 'cancelled');
      }
      await audit('delist', delist.id, 'delist delisted');
      res.delisted.push(domain);
      res.cancelled.push(...others);
      return res;
    }
    if (due.length === 0) return res;
    if (cur.pricing_hold) {
      res.held.push(domain);
      return res;
    }

    // newest to oldest: invalid rows fail, the newest valid row applies, older rows are superseded
    let chosen: Row | null = null;
    const olderIdx: number[] = [];
    for (let i = due.length - 1; i >= 0; i--) {
      const row = due[i]!;
      if (chosen) { olderIdx.push(row.id); continue; }
      const settings = await settingsByVersion(q, row.settings_version);
      const reason = settings ? rowValid(row, settings, cur.listing_mode) : `pricing settings v${row.settings_version} not found`;
      if (reason) {
        await setStatus([row.id], 'failed', reason);
        await audit(row.event, row.id, reason, 422);
        res.failed.push({ domain, rowId: row.id, reason });
        this.deps.log?.warn({ domain, rowId: row.id, reason }, 'price schedule row failed validation');
      } else {
        chosen = row;
      }
    }
    await setStatus(olderIdx, 'superseded');
    res.superseded.push(...olderIdx);
    if (!chosen) return res;
    const last = chosen;
    if (!dry) {
      await q.updateTable('domains').set({
        bin_cents: last.bin_cents, floor_cents: last.floor_cents, walkaway_cents: last.walkaway_cents,
        ...(cur.listing_mode === 'bin' ? { min_offer_cents: last.bin_cents } : {}),
        updated_at: now, ...changedColumns(cur, now),
      }).where('id', '=', domainId).execute();
      const h = await q.insertInto('listing_history').values({
        domain_id: domainId, at: now, source: 'schedule', category: cur.category, mode: cur.listing_mode, bin_cents: last.bin_cents, floor_cents: last.floor_cents,
        min_offer_cents: cur.listing_mode === 'bin' ? last.bin_cents : cur.min_offer_cents, lto_max_months: cur.lto_max_months, lander: cur.lander,
        override: false, override_reason: null, approval_text: null, approval_at: null, audit_id: null, price_grade: cur.price_grade,
        walkaway_cents: last.walkaway_cents, pricing_source: cur.pricing_source, pricing_settings_version: last.settings_version,
        schedule_event_id: last.id, plan_audit_id: cur.plan_audit_id,
      }).returning('id').executeTakeFirstOrThrow();
      await q.updateTable('price_schedule').set({ status: 'applied', applied_at: now, listing_history_id: h.id, updated_at: now }).where('id', '=', last.id).execute();
    }
    await audit(last.event, last.id, `${last.event} applied`);
    res.applied.push({ domain, event: last.event, rowId: last.id, bin_cents: last.bin_cents, floor_cents: last.floor_cents });
    return res;
  }
}
