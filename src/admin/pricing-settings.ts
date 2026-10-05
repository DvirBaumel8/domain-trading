import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { newAuditId } from '../http/audit.js';
import { canonicalJson } from '../http/canonical-json.js';
import { ruleFields, rowToSettings } from '../pricing/settings.js';

const INT_KEYS = [
  'geo_bin_strong_cents', 'geo_bin_weaker_cents', 'geo_bin_min_cents', 'geo_bin_max_cents', 'floor_bps', 'floor_min_cents',
  'walkaway_bps', 'walkaway_min_cents', 'hybrid_min_offer_cents', 'final_push_days_before_drop', 'delist_days_before_drop',
  'headsup_days_before', 'comps_min', 'comps_max',
] as const;
const BOOL_KEYS = ['geo_drops_enabled', 'public_lto'] as const;
const JSON_KEYS = ['geo_drops', 'drops'] as const;
const TEXT_KEYS = ['final_push_mode'] as const;

function parseValue(key: string, raw: string): unknown {
  if ((INT_KEYS as readonly string[]).includes(key)) {
    if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a non-negative integer`);
    return Number(raw);
  }
  if ((BOOL_KEYS as readonly string[]).includes(key)) {
    if (raw !== 'true' && raw !== 'false') throw new Error(`${key} must be true or false`);
    return raw === 'true';
  }
  if ((JSON_KEYS as readonly string[]).includes(key)) return JSON.stringify(JSON.parse(raw));
  if ((TEXT_KEYS as readonly string[]).includes(key)) return raw;
  throw new Error(`unknown pricing setting: ${key}`);
}

export async function newPricingSettings(
  db: Kysely<Database>,
  o: { set: Record<string, string>; approvalText: string; approvalAt: string; note?: string; now: Date },
): Promise<{ version: number }> {
  if (!o.approvalText.trim()) throw new Error('approval text (Dvir\'s words) is required');
  if (Object.keys(o.set).length === 0) throw new Error('at least one --set is required');
  if (!z.iso.datetime({ offset: true }).safeParse(o.approvalAt).success) throw new Error('approval-at must be ISO 8601 with an offset or Z');
  const approvalAt = new Date(o.approvalAt);
  if (approvalAt.getTime() > o.now.getTime()) throw new Error('approval-at must not be in the future');
  const changes = Object.fromEntries(Object.entries(o.set).map(([k, v]) => [k, parseValue(k, v)]));
  return db.transaction().execute(async (trx) => {
    const cur = await trx.selectFrom('pricing_settings').selectAll().orderBy('version', 'desc').forUpdate().executeTakeFirstOrThrow();
    const { version, created_at: _c, ...rest } = cur;
    const row = {
      ...rest,
      geo_drops: JSON.stringify(cur.geo_drops),
      drops: JSON.stringify(cur.drops),
      ...changes,
      version: version + 1,
      effective_at: o.now,
      approval_text: o.approvalText,
      approval_at: approvalAt,
      note: o.note ?? null,
    };
    let inserted;
    try {
      inserted = await trx.insertInto('pricing_settings').values(row as never).returningAll().executeTakeFirstOrThrow();
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new Error('another pricing-settings version was created concurrently; re-run');
      throw e;
    }
    const next = rowToSettings(inserted); // validates the jsonb shapes; throws (and rolls back) on a bad value
    if (canonicalJson(ruleFields(next)) === canonicalJson(ruleFields(rowToSettings(cur)))) {
      throw new Error('no rule changed; a new version needs at least one different value');
    }
    await trx.insertInto('audit_log').values({
      id: newAuditId(), scope: 'admin', method: 'ADMIN', path: 'pricing-settings new',
      request: JSON.stringify({ set: o.set, note: o.note ?? null }), approval_text: o.approvalText, approval_at: approvalAt,
      status_code: 200, result_summary: `created pricing_settings version ${inserted.version}`,
    }).execute();
    return { version: inserted.version };
  });
}

export async function showPricingSettings(db: Kysely<Database>, version?: number): Promise<object> {
  let q = db.selectFrom('pricing_settings').selectAll();
  q = version ? q.where('version', '=', version) : q.orderBy('version', 'desc');
  const r = await q.executeTakeFirst();
  if (!r) throw new Error('no such pricing_settings version');
  return r;
}
