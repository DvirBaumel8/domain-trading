// v2.10.0 (CR-011 part B): the review packet. Built from the database only; the service calls nobody.
import { createHash, randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { currentSettings } from '../../pricing/settings.js';
import { activeSelectionSettings } from '../../screening/settings.js';
import { toJerusalemIso } from '../../time.js';
import { buildReport } from '../report/index.js';
import { unifiedDiff } from './diff.js';

/** The month's review spend limit in USD (CR-011 T11-22). A constant, not a setting. */
export const REVIEW_MONTHLY_CAP_USD = 5;
/** A weekly packet is due when the newest weekly one is older than this. */
export const WEEKLY_EVERY_MS = 7 * 86_400_000;
/** Each list in `dom_changes` keeps at most this many of the newest rows. */
export const PACKET_LIST_LIMIT = 200;

export const newPacketId = (): string => `rvp_${randomBytes(6).toString('hex')}`;
export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export function monthOf(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

export async function monthSpend(db: Kysely<Database>, nowMs: number): Promise<{ month: string; spentUsd: number; okN: number; unknownN: number }> {
  const month = monthOf(nowMs);
  const from = new Date(`${month}-01T00:00:00Z`);
  const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  const rows = await db.selectFrom('review_feedback').select(['status', 'cost_usd']).where('created_at', '>=', from).where('created_at', '<', to).execute();
  const spent = rows.reduce((s, r) => s + Math.round(Number(r.cost_usd) * 10_000), 0) / 10_000;
  return { month, spentUsd: spent, okN: rows.filter((r) => r.status === 'ok').length, unknownN: rows.filter((r) => r.status === 'unknown').length };
}

/** Drops every field named like a walk-away, at any depth: the walk-away is private and never leaves the service. */
export function stripWalkaway(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripWalkaway);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).filter(([k]) => !/walk.?away/i.test(k)).map(([k, x]) => [k, stripWalkaway(x)]));
  }
  return v;
}

export interface PacketBuild { kind: 'daily' | 'weekly'; documentVersion: number; content: Record<string, unknown> }

/** Throws nothing for a missing document: the caller checks `latestDocument` first. */
export async function latestDocument(db: Kysely<Database>) {
  return db.selectFrom('company_documents').selectAll().orderBy('version', 'desc').limit(1).executeTakeFirst();
}

export async function buildPacket(db: Kysely<Database>, now: Date, serviceVersion: string): Promise<PacketBuild | null> {
  const doc = await latestDocument(db);
  if (!doc) return null;
  const lastWeekly = await db.selectFrom('review_packets').select('created_at').where('kind', '=', 'weekly').orderBy('created_at', 'desc').limit(1).executeTakeFirst();
  const kind: 'daily' | 'weekly' = !lastWeekly || lastWeekly.created_at.getTime() < now.getTime() - WEEKLY_EVERY_MS ? 'weekly' : 'daily';
  const prev = await db.selectFrom('review_packets').select(['created_at', 'document_version']).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  const full = kind === 'weekly' || !prev;
  let diffSince: { from_version: number; diff: string } | null = null;
  if (!full && prev) {
    const old = await db.selectFrom('company_documents').select('text').where('version', '=', prev.document_version).executeTakeFirstOrThrow();
    diffSince = { from_version: prev.document_version, diff: unifiedDiff(old.text, doc.text, `v${prev.document_version}`, `v${doc.version}`) };
  }
  const since = prev?.created_at ?? new Date(0);
  const iso = (d: Date) => toJerusalemIso(d);

  const pricing = await db.selectFrom('pricing_settings').select(['version', 'created_at']).orderBy('version').execute();
  const pricingActive = (await currentSettings(db, now)).version;
  const selActive = (await activeSelectionSettings(db)).label;
  const sel = await db.selectFrom('selection_settings').select(['label', 'created_at']).orderBy('id').execute();
  const settingsVersions = [
    ...pricing.filter((p) => p.version === pricingActive || p.created_at > since).map((p) => ({ label: `pricing:v${p.version}`, created_at: iso(p.created_at), active: p.version === pricingActive })),
    ...sel.filter((s) => s.label === selActive || s.created_at > since).map((s) => ({ label: `selection:${s.label}`, created_at: iso(s.created_at), active: s.label === selActive })),
  ];

  // walkaway_cents is never selected.
  const listing = (await db.selectFrom('listing_history as h').innerJoin('domains as d', 'd.id', 'h.domain_id')
    .select(['d.domain', 'h.at', 'h.source', 'h.mode', 'h.bin_cents', 'h.floor_cents']).where('h.at', '>', since).orderBy('h.id', 'desc').limit(PACKET_LIST_LIMIT).execute()).reverse()
    .map((r) => ({ domain: r.domain, at: iso(r.at), source: r.source, mode: r.mode, bin_cents: r.bin_cents, floor_cents: r.floor_cents }));
  const offers = (await db.selectFrom('offers as o').innerJoin('domains as d', 'd.id', 'o.domain_id')
    .select(['d.domain', 'o.amount_cents', 'o.outcome', 'o.created_at']).where('o.created_at', '>', since).orderBy('o.id', 'desc').limit(PACKET_LIST_LIMIT).execute()).reverse()
    .map((r) => ({ domain: r.domain, amount_cents: r.amount_cents, outcome: r.outcome, at: iso(r.created_at) }));
  const sales = (await db.selectFrom('sales as s').innerJoin('domains as d', 'd.id', 's.domain_id')
    .select(['d.domain', 's.sale_price_cents', 's.venue', 's.created_at']).where('s.created_at', '>', since).orderBy('s.id', 'desc').limit(PACKET_LIST_LIMIT).execute()).reverse()
    .map((r) => ({ domain: r.domain, gross_cents: r.sale_price_cents, venue: r.venue, at: iso(r.created_at) }));
  const runs = await db.selectFrom('job_runs').select(['job', 'finished_at', 'steps']).where('finished_at', '>', since).orderBy('id', 'desc').limit(PACKET_LIST_LIMIT).execute();
  const failed: { job: string; step: string; at: string; error: string | null }[] = [];
  for (const r of runs.reverse()) {
    const steps = (r.steps ?? {}) as Record<string, { ok?: boolean; error?: string }>;
    for (const [step, res] of Object.entries(steps)) {
      if (res && res.ok === false) failed.push({ job: r.job, step, at: iso(r.finished_at), error: res.error ?? null });
    }
  }

  const numbers = stripWalkaway(await buildReport(db, now));
  const content = {
    kind,
    generated_at: iso(now),
    document: { version: doc.version, sha256: doc.sha256, text: full ? doc.text : null, diff_since: diffSince },
    dom_changes: {
      since: prev ? iso(prev.created_at) : null,
      service_version: serviceVersion,
      settings_versions: settingsVersions,
      listing_changes: listing,
      offers,
      sales,
      failed_job_steps: failed.slice(-PACKET_LIST_LIMIT),
    },
    numbers,
  };
  return { kind, documentVersion: doc.version, content };
}
