// Tranches (CAP-04, ruling R6): a batch of screened names bought together, with a geo cap (checked on every addition) and a
// main-lane quota (checked at close). v1.1.0 is additive: /buy does not require a tranche (NO_TRANCHE is deferred to v2.0.0).
import { randomBytes } from 'node:crypto';
import type { Kysely, Selectable } from 'kysely';
import type { Database, TrancheMembersTable, TranchesTable } from '../db/types.js';
import { normalizeDomain } from '../domain-name.js';
import { AppError } from '../http/errors.js';
import { formatUsd } from '../money.js';
import { latestByCheck } from '../screening/derive.js';
import { assemble, effectiveHold, toResultRow } from '../screening/engine.js';
import { activeSelectionSettings, selectionSettingsByLabel } from '../screening/settings.js';
import type { CheckId, Lane, RunItem } from '../screening/types.js';
import { geoMembers, openTrancheFor } from './tranche-members.js';

type Trn = Selectable<TranchesTable>;
type Mem = Selectable<TrancheMembersTable>;
export interface Actor { by: string; auditId: string; now: Date }

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const OK_STATUS = ['would_buy', 'buy_candidate', 'pending_manual'];

export { geoMembers, openTrancheFor };

interface Counts { members: number; geo: number; main_lane: number; non_main: number; unknown_main_lane: number }
function counts(ms: Mem[]): Counts {
  const main = ms.filter((m) => m.main_lane === true).length;
  const unknown = ms.filter((m) => m.main_lane === null).length;
  return { members: ms.length, geo: ms.filter((m) => m.is_geo).length, main_lane: main, non_main: ms.length - main - unknown, unknown_main_lane: unknown };
}

/** Main-lane share needed for `n` members: `min_main_lane` of `size`, rounded up (a full 15 needs 10; 3 members need 2). */
export const requiredMainLane = (n: number, size: number, min: number): number => (size > 0 ? Math.ceil((n * min) / size) : 0);

export class TrancheService {
  constructor(private readonly db: Kysely<Database>) {}

  private async load(db: Kysely<Database>, id: string, lock = false): Promise<Trn> {
    let q = db.selectFrom('tranches').selectAll().where('id', '=', id);
    if (lock) q = q.forUpdate();
    const t = await q.executeTakeFirst();
    if (!t) throw new AppError(404, 'TRANCHE_NOT_FOUND', `No tranche "${id}"`);
    return t;
  }

  async view(db: Kysely<Database>, t: Trn, withRemoved = false): Promise<Record<string, unknown>> {
    let q = db.selectFrom('tranche_members').selectAll().where('tranche_id', '=', t.id).orderBy('id');
    if (!withRemoved) q = q.where('removed_at', 'is', null);
    const ms = await q.execute();
    const active = ms.filter((m) => m.removed_at === null);
    const c = counts(active);
    const committed = active.reduce((s, m) => s + (m.est_cost_cents ?? 0), 0);
    return {
      id: t.id, name: t.name, status: t.status, opened_at: iso(t.opened_at), opened_by: t.opened_by, closed_at: iso(t.closed_at), closed_by: t.closed_by,
      settings_version: t.settings_label,
      spend_cap_cents: t.spend_cap_cents, spend_cap: t.spend_cap_cents === null ? null : formatUsd(t.spend_cap_cents),
      committed_cents: committed, committed: formatUsd(committed),
      members: ms.map((m) => ({
        domain: m.domain, lane: m.lane, is_geo: m.is_geo, main_lane: m.main_lane, run_id: m.run_id, added_at: iso(m.added_at),
        est_cost_cents: m.est_cost_cents, ...(withRemoved && { removed_at: iso(m.removed_at) }),
      })),
      counts: c, close_report: t.close_report,
    };
  }

  async list(): Promise<{ tranches: Record<string, unknown>[] }> {
    const ts = await this.db.selectFrom('tranches').selectAll().orderBy('opened_at', 'desc').execute();
    return { tranches: await Promise.all(ts.map((t) => this.view(this.db, t))) };
  }

  async get(id: string): Promise<Record<string, unknown>> {
    return this.view(this.db, await this.load(this.db, id));
  }

  async open(name: string, spendCapCents: number | null, a: Actor): Promise<Record<string, unknown>> {
    const sel = await activeSelectionSettings(this.db);
    const id = `trn_${randomBytes(6).toString('hex')}`;
    try {
      await this.db.insertInto('tranches').values({
        id, name, status: 'open', opened_at: a.now, opened_by: a.by, settings_label: sel.label, spend_cap_cents: spendCapCents, audit_id: a.auditId,
      }).execute();
    } catch (e) {
      const err = e as { code?: string; constraint?: string };
      if (err.code === '23505' && err.constraint === 'tranches_name_key') throw new AppError(409, 'TRANCHE_NAME_TAKEN', `A tranche named "${name}" exists`);
      if (err.code === '23505') {
        const open = await this.db.selectFrom('tranches').select(['id', 'name']).where('status', '=', 'open').executeTakeFirst();
        throw new AppError(409, 'TRANCHE_ALREADY_OPEN', 'A tranche is already open; close it first', { open_tranche: open ?? null });
      }
      throw e;
    }
    return this.get(id);
  }

  /** The name's standing in `runId`: derived status, lane and whether it counts for the main-lane quota (null = cannot be told). */
  private async standing(runId: string, domain: string): Promise<{ lane: Lane; mainLane: boolean | null }> {
    const { db } = this;
    const run = await db.selectFrom('screening_runs').selectAll().where('id', '=', runId).executeTakeFirst();
    if (!run) throw new AppError(404, 'RUN_NOT_FOUND', `No screening run "${runId}"`);
    if (run.backtest) throw new AppError(409, 'NOT_SCREENED_OK', 'A backtest run never makes a name eligible', { run_id: runId, reason: 'BACKTEST' });
    const sel = await selectionSettingsByLabel(db, run.settings_label);
    const rows = (await db.selectFrom('screening_results').selectAll().where('run_id', '=', run.id).orderBy('id').execute()).map(toResultRow);
    const a = assemble((run.input as { names: RunItem[] }).names, run.gate_plan as Partial<Record<Lane, CheckId[]>>, rows, sel!.values,
      await effectiveHold(db, run), run.status !== 'running', run.mode === 'live');
    const it = a.items.find((i) => i.item.domain === domain && !i.item.input_error);
    if (!it) throw new AppError(404, 'NAME_NOT_IN_RUN', `"${domain}" is not a screened name of run ${runId}`);
    if (!OK_STATUS.includes(it.derived.final_status)) {
      throw new AppError(409, 'NOT_SCREENED_OK', `${domain} is ${it.derived.final_status} in run ${runId}; only would_buy, buy_candidate or pending_manual names join a tranche`,
        { run_id: runId, final_status: it.derived.final_status, first_fail: it.derived.first_fail });
    }
    const latest = latestByCheck(it.rows);
    const lane = it.item.lane;
    const pass = (s?: string) => s === 'PASS' || s === 'PASS_WITH_NOTE';
    let mainLane: boolean | null = false;
    if (lane === 'S7') {
      const h = latest.get('history');
      if (!h || !pass(h.status)) mainLane = false;
      else {
        const sl = h.fields.source_lane;
        mainLane = sl === 'expired_drop' ? true : sl === 'fresh' ? false : null; // unknown while the archive source is off
      }
    } else if (lane === 'S3') {
      mainLane = latest.get('tier')?.status === 'PASS';
    }
    return { lane, mainLane };
  }

  async addMember(id: string, domainIn: string, runId: string, estCostCents: number | null, a: Actor): Promise<{ duplicate: boolean; tranche: Record<string, unknown> }> {
    let domain: string;
    try { domain = normalizeDomain(domainIn); } catch { throw new AppError(422, 'DOMAIN_INVALID', `"${domainIn}" is not a valid domain`); }
    const t0 = await this.load(this.db, id);
    if (t0.status === 'closed') throw new AppError(409, 'TRANCHE_CLOSED', 'A closed tranche is read-only');
    const active = await this.db.selectFrom('tranche_members').select('id').where('tranche_id', '=', id).where('domain', '=', domain).where('removed_at', 'is', null).executeTakeFirst();
    if (active) return { duplicate: true, tranche: await this.get(id) };
    const st = await this.standing(runId, domain);
    const sel = await activeSelectionSettings(this.db);
    const { size, geo_max } = sel.values.tranche;
    await this.db.transaction().execute(async (trx) => {
      const t = await this.load(trx, id, true);
      if (t.status === 'closed') throw new AppError(409, 'TRANCHE_CLOSED', 'A closed tranche is read-only');
      const ms = await trx.selectFrom('tranche_members').selectAll().where('tranche_id', '=', id).where('removed_at', 'is', null).execute();
      if (ms.some((m) => m.domain === domain)) return;
      if (ms.length >= size) throw new AppError(409, 'TRANCHE_FULL', `The tranche already has ${ms.length} names (size ${size})`, { size, members: ms.length });
      const isGeo = st.lane === 'S2';
      const geo = ms.filter((m) => m.is_geo).length;
      if (isGeo && geo >= geo_max) throw new AppError(409, 'GEO_CAP', `The tranche already has ${geo} geo name(s) (geo_max ${geo_max}); add geo names in Ratio order, the lowest-ranked is the one refused`, { geo_max, geo_members: geo });
      if (t.spend_cap_cents !== null) {
        if (estCostCents === null) throw new AppError(422, 'VALIDATION_ERROR', 'est_cost is required: this tranche has a spend cap');
        const committed = ms.reduce((s, m) => s + (m.est_cost_cents ?? 0), 0);
        if (committed + estCostCents > t.spend_cap_cents) {
          throw new AppError(409, 'TRANCHE_SPEND_CAP', `Adding ${formatUsd(estCostCents)} would pass the tranche spend cap of ${formatUsd(t.spend_cap_cents)}`,
            { spend_cap_cents: t.spend_cap_cents, committed_cents: committed, est_cost_cents: estCostCents });
        }
      }
      await trx.insertInto('tranche_members').values({
        tranche_id: id, domain, lane: st.lane, is_geo: isGeo, main_lane: st.mainLane, est_cost_cents: estCostCents, run_id: runId, added_at: a.now, added_by: a.by,
      }).execute();
    });
    return { duplicate: false, tranche: await this.get(id) };
  }

  async removeMember(id: string, domainIn: string, a: Actor): Promise<Record<string, unknown>> {
    let domain: string;
    try { domain = normalizeDomain(domainIn); } catch { throw new AppError(422, 'DOMAIN_INVALID', `"${domainIn}" is not a valid domain`); }
    await this.db.transaction().execute(async (trx) => {
      const t = await this.load(trx, id, true);
      if (t.status === 'closed') throw new AppError(409, 'TRANCHE_CLOSED', 'A closed tranche is read-only');
      const r = await trx.updateTable('tranche_members').set({ removed_at: a.now, removed_by: a.by })
        .where('tranche_id', '=', id).where('domain', '=', domain).where('removed_at', 'is', null).executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw new AppError(404, 'MEMBER_NOT_FOUND', `${domain} is not a member of ${id}`);
    });
    return this.get(id);
  }

  /**
   * Close (read-only from then on). A tranche may close below its target only with `allow_below_target` and a reason. The main-lane
   * share rule applies to the members present: at least ceil(members x min_main_lane / size). When the share cannot be told (S7 names
   * whose source lane is unknown) the close needs a reason too, and the report says so.
   */
  async close(id: string, o: { allowBelowTarget: boolean; reason: string | null }, a: Actor): Promise<Record<string, unknown>> {
    const sel = await activeSelectionSettings(this.db);
    const { size, min_main_lane, geo_max } = sel.values.tranche;
    await this.db.transaction().execute(async (trx) => {
      const t = await this.load(trx, id, true);
      if (t.status === 'closed') throw new AppError(409, 'TRANCHE_CLOSED', 'The tranche is already closed');
      const ms = await trx.selectFrom('tranche_members').selectAll().where('tranche_id', '=', id).where('removed_at', 'is', null).execute();
      const c = counts(ms);
      if (c.geo > geo_max) throw new AppError(409, 'GEO_CAP', `The tranche has ${c.geo} geo names (geo_max ${geo_max}); remove some first`, { geo_max, geo_members: c.geo });
      const below = c.members < size;
      if (below && !(o.allowBelowTarget && o.reason)) {
        throw new AppError(409, 'TRANCHE_BELOW_TARGET', `The tranche has ${c.members} of ${size} names; closing below target needs allow_below_target and a reason`, { size, members: c.members });
      }
      const required = requiredMainLane(c.members, size, min_main_lane);
      let quota: 'MET' | 'UNKNOWN_ACCEPTED' = 'MET';
      if (c.main_lane < required) {
        if (c.main_lane + c.unknown_main_lane < required) {
          throw new AppError(409, 'MAIN_LANE_QUOTA', `${c.main_lane} of ${c.members} names are main-lane; at least ${required} are needed (${min_main_lane} of ${size})`,
            { required_main_lane: required, ...c, status: 'FAIL' });
        }
        if (!o.reason) {
          throw new AppError(409, 'MAIN_LANE_QUOTA', `The main-lane share cannot be told for ${c.unknown_main_lane} name(s) (source lane unknown); close with a reason to accept it`,
            { required_main_lane: required, ...c, status: 'UNKNOWN' });
        }
        quota = 'UNKNOWN_ACCEPTED';
      }
      const report = {
        target_size: size, members: c.members, below_target: below, reason: o.reason, geo: c.geo, geo_max, main_lane: c.main_lane, non_main: c.non_main,
        unknown_main_lane: c.unknown_main_lane, required_main_lane: required, min_main_lane, main_lane_quota: quota, settings_version: sel.label,
        closed_with: o.allowBelowTarget ? 'allow_below_target' : 'plain',
        domains: ms.map((m) => m.domain),
      };
      await trx.updateTable('tranches').set({ status: 'closed', closed_at: a.now, closed_by: a.by, close_report: JSON.stringify(report) }).where('id', '=', id).execute();
    });
    return this.get(id);
  }
}
