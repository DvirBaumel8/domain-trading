// v4.0.0 (CR-046 item 3): the renewal maths gate. ratio = BIN x (1 - commission) x STRe / renewal cost, in integer cents and basis points (no float money).
// STRe (the expected sell-through over the renewal period) and its reason are the scout's judgment; the server only does the arithmetic and logs it.
import { sql, type Kysely } from 'kysely';
import type { Category, Database } from '../../db/types.js';
import type { PricingSettings } from '../listing/index.js';
import { latestScreeningRun } from './buy-hold.js';

export interface RenewalMath {
  venue: string; bin_cents: number; commission_bp: number; stre_bp: number; renewal_cents: number;
  expected_net_cents: number; ratio: number; min: number; pass: boolean;
}

export function renewalMath(o: { binCents: number; commission: number; stre: number; renewalCents: number; min: number; venue: string }): RenewalMath {
  const commissionBp = Math.round(o.commission * 10_000);
  const streBp = Math.round(o.stre * 10_000);
  const exact = (o.binCents * (10_000 - commissionBp) * streBp) / 100_000_000;
  const ratio = o.renewalCents > 0 ? exact / o.renewalCents : Number.POSITIVE_INFINITY;
  return {
    venue: o.venue, bin_cents: o.binCents, commission_bp: commissionBp, stre_bp: streBp, renewal_cents: o.renewalCents,
    expected_net_cents: Math.round(exact), ratio: Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : ratio, min: o.min, pass: ratio >= o.min,
  };
}

/** The BIN the name will be listed at: the plan's, else the grade price (geo) or the v3 default (other). Null when the settings define none. */
export function binForMath(category: Category, grade: 'strong' | 'weaker' | null, planBin: number | null, p: PricingSettings): number | null {
  if (planBin !== null) return planBin;
  if (category === 'geo') return grade === 'strong' ? p.geoBinStrongCents : p.geoBinWeakerCents;
  return p.nongeoDefaultBinCents;
}

/** The test group of a bought name (CR-045 item 3): `borderline` when its latest screening run holds a FLAG result, else `passed`;
 * null when the name has no screening pack (CR-051 B-1: a name with no pack is in neither test group). */
export async function screeningGroupOf(db: Kysely<Database>, domain: string): Promise<'passed' | 'borderline' | null> {
  const pack = await db.selectFrom('screening_packs').select('id').where('domain', '=', domain).limit(1).executeTakeFirst();
  if (!pack) return null;
  const run = await latestScreeningRun(db, domain);
  if (!run) return null;
  const r = await sql<{ n: string }>`
    select count(*)::text as n from (select distinct on (check_id) status from screening_results where run_id = ${run.id} and domain = ${domain} order by check_id, checked_at desc, id desc) x
    where status = 'FLAG'`.execute(db);
  return Number(r.rows[0]?.n ?? 0) > 0 ? 'borderline' : 'passed';
}
