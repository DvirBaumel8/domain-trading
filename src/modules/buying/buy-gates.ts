// v2.0.0 /buy gates: a complete, current screening pack (SEL7-1) and an open tranche. Pure reads: the caller
// throws (real buy) or reports (dry run). 
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { AppError } from '../../http/errors.js';
import { latestPackFor } from '../selection/index.js';
import { activeSelectionSettings } from '../selection/index.js';
import { latestScreeningRun, screeningHold } from './buy-hold.js';
import { openTrancheFor } from '../selection/index.js';

export type BuyBlock = 'BUY_HOLD' | 'SCREENING_PACK_REQUIRED' | 'NO_TRANCHE' | 'SMALL_BUY_PRICE' | 'DOMAIN_CAP_REACHED';
type PackReason = 'NO_PACK' | 'INCOMPLETE' | 'NOT_FROM_LATEST_RUN' | 'SETTINGS_NOT_ACTIVE' | 'PACK_TOO_OLD';
export interface Gate { code: BuyBlock; message: string; details: Record<string, unknown> }

export async function packGate(db: Kysely<Database>, domain: string, nowMs: number, latestRun?: Awaited<ReturnType<typeof latestScreeningRun>> | null): Promise<Gate | null> {
  const block = (reason: PackReason, packId: string | null, message: string): Gate =>
    ({ code: 'SCREENING_PACK_REQUIRED', message, details: { reason, pack_id: packId } });
  const pack = await latestPackFor(db, domain);
  if (!pack) return block('NO_PACK', null, `${domain} has no screening pack: screen it, judge it and issue a pack (POST /screening/packs)`);
  if (pack.status !== 'complete') return block('INCOMPLETE', pack.id, `The latest pack of ${domain} is incomplete; fix what it lists as missing and issue a new one`);
  const run = latestRun === undefined ? await latestScreeningRun(db, domain) : latestRun;
  if (!run || run.id !== pack.run_id) return block('NOT_FROM_LATEST_RUN', pack.id, `The latest pack of ${domain} is not from its latest screening run; issue a pack from that run`);
  const active = await activeSelectionSettings(db);
  const content = pack.content as { settings_active?: unknown };
  if (content.settings_active !== true || pack.settings_label !== active.label) {
    return block('SETTINGS_NOT_ACTIVE', pack.id, `The pack of ${domain} was issued under settings "${pack.settings_label}", which is not the active version "${active.label}"`);
  }
  const maxH = active.values.pack.max_age_at_buy_hours;
  if (nowMs - pack.issued_at.getTime() > maxH * 3_600_000) return block('PACK_TOO_OLD', pack.id, `The pack of ${domain} is older than ${maxH} h; issue a new one`);
  return null;
}

/** The open tranche the name is an active member of, or NO_TRANCHE. */
export async function trancheGate(db: Kysely<Database>, domain: string): Promise<{ gate: Gate } | { trancheId: string }> {
  const t = await openTrancheFor(db, domain);
  if (!t) return { gate: { code: 'NO_TRANCHE', message: `${domain} is not an active member of the open tranche; open a tranche and add it first`, details: {} } };
  return { trancheId: t.trancheId };
}

export const gateError = (g: Gate): AppError => new AppError(409, g.code, g.message, g.details);

/**
 * v2.14.0 (CR-012 T12-7): every gate a real buy of `domain` would hit today, in the order /buy checks them (the same functions as a /buy dry run:
 * the buy hold of its latest screening run, the screening pack, the open tranche).
 * A /buy dry run reports only the first; the daily list reports all of them.
 */
export async function buyBlocks(db: Kysely<Database>, domain: string, nowMs: number): Promise<BuyBlock[]> {
  const out: BuyBlock[] = [];
  const run = (await latestScreeningRun(db, domain)) ?? null;
  if (await screeningHold(db, domain, run)) out.push('BUY_HOLD');
  const pg = await packGate(db, domain, nowMs, run);
  if (pg) out.push(pg.code);
  const tg = await trancheGate(db, domain);
  if ('gate' in tg) out.push(tg.gate.code);
  return out;
}
