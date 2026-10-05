import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Kysely } from 'kysely';
import { AppError } from '../http/errors.js';
import { checkTimedApproval } from './approval.js';
import { manualDelist, pendingDomains, type Venue } from './export-state.js';
import { withDomainLock } from './plan-store.js';
import { z } from 'zod';
import type { Config } from '../config.js';
import { jerusalemDate } from '../dates.js';
import type { Database, DomainRow } from '../db/types.js';
import { isValidDisplayName } from '../domain-name.js';

export const AFTERNIC_HEADER = [
  'Domain', 'Buy Now Price', 'Floor Price', 'Min Offer', 'Lease to Own', 'Max Lease Period', 'Sale Lander',
  'Show Buy Now Option', 'Show Lease to Own Option', 'Show Make Offer Option', 'Hidden',
] as const;

export type ExportDomain = Pick<DomainRow, 'domain' | 'display_name' | 'listing_mode' | 'bin_cents' | 'floor_cents' | 'min_offer_cents' | 'lto_max_months'>;

/** Integer USD rounded down; flags when cents were dropped. */
function usd(cents: number | null, round: { dropped: boolean }): string {
  if (cents === null) return '';
  if (cents % 100 !== 0) round.dropped = true;
  return String(Math.floor(cents / 100));
}

export function afternicRow(d: ExportDomain): { row: { cells: string[] } | { skip: string }; warnings: string[] } {
  if (!d.listing_mode) return { row: { skip: 'NOT_LISTED' }, warnings: [] };
  const round = { dropped: false };
  const min = usd(d.min_offer_cents, round);
  if (min === '' || Number(min) < 20) return { row: { skip: 'MIN_OFFER_BELOW_20' }, warnings: [`${d.domain}:MIN_OFFER_BELOW_20`] };
  const warnings: string[] = [];
  let name = d.domain;
  if (d.display_name !== null) {
    if (isValidDisplayName(d.domain, d.display_name)) name = d.display_name;
    else warnings.push(`DISPLAY_NAME_IGNORED:${d.domain}`);
  }
  let cells: string[];
  if (d.listing_mode === 'bin') {
    const bin = usd(d.bin_cents, round);
    cells = [name, bin, bin, bin, 'N', '', 'Buy It Now', 'Y', 'N', 'N', 'N'];
  } else if (d.listing_mode === 'offer') {
    cells = [name, '0', usd(d.floor_cents, round), min, 'N', '', 'Custom Lander', 'N', 'N', 'Y', 'N'];
  } else {
    const lto = d.lto_max_months !== null;
    cells = [name, usd(d.bin_cents, round), usd(d.floor_cents, round), min, lto ? 'Y' : 'N', lto ? String(d.lto_max_months) : '', 'Custom Lander', 'Y', lto ? 'Y' : 'N', 'Y', 'N'];
  }
  return { row: { cells }, warnings: round.dropped ? [...warnings, `${d.domain}:AFTERNIC_ROUNDS_DOWN`] : warnings };
}

const noPlaceholder = (v: string) => !(v.startsWith('<') && v.endsWith('>'));
const unique = (a: string[]) => new Set(a).size === a.length;
const SedoTemplateSchema = z.object({
  headers: z.array(z.string().min(1).refine(noPlaceholder, 'placeholder header')).min(1),
  map: z.object({
    domain: z.string(), selling_option: z.string(), for_sale: z.string(), price: z.string(),
    min_price: z.string(), currency: z.string(), action: z.string(),
  }),
  values: z.object({
    buy_now: z.string(), make_offer: z.string(), for_sale_yes: z.string(), usd: z.string(), action_add: z.string(),
  }),
})
  .refine((t) => unique(t.headers), 'headers must be unique')
  .refine((t) => unique(Object.values(t.map)), 'map targets must be unique')
  .refine((t) => Object.values(t.map).every((h) => t.headers.includes(h)), 'every mapped header must be in headers')
  .refine((t) => Object.values(t.values).every((v) => v.length > 0 && noPlaceholder(v)), 'values must be set (no <placeholders>)');
export type SedoTemplate = z.infer<typeof SedoTemplateSchema>;

export class SedoTemplateInvalid extends Error {}

export async function loadSedoTemplate(path: string): Promise<SedoTemplate | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new SedoTemplateInvalid(`not valid JSON: ${(e as Error).message}`);
  }
  const parsed = SedoTemplateSchema.safeParse(json);
  if (!parsed.success) throw new SedoTemplateInvalid(parsed.error.issues.map((i) => i.message).join('; '));
  return parsed.data;
}

export function sedoRow(d: ExportDomain, t: SedoTemplate, hybridAs: 'buy_now' | 'make_offer'): string[] {
  const round = { dropped: false };
  const fixed = d.listing_mode === 'hybrid' && hybridAs === 'buy_now';
  const fields: Record<keyof SedoTemplate['map'], string> = {
    domain: d.domain,
    selling_option: fixed ? t.values.buy_now : t.values.make_offer,
    for_sale: t.values.for_sale_yes,
    price: d.listing_mode === 'offer' ? '' : usd(d.bin_cents, round),
    min_price: fixed ? '' : usd(d.listing_mode === 'bin' ? d.bin_cents : d.min_offer_cents, round),
    currency: t.values.usd,
    action: t.values.action_add,
  };
  const byHeader = new Map(Object.entries(t.map).map(([k, h]) => [h, fields[k as keyof typeof fields]]));
  return t.headers.map((h) => byHeader.get(h) ?? '');
}

const needsQuote = /[",\r\n]/;
export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => (needsQuote.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n') + '\r\n';
}

const EXPORT_COLS = ['domain', 'display_name', 'listing_mode', 'bin_cents', 'floor_cents', 'min_offer_cents', 'lto_max_months'] as const;
const SAFE_DOMAIN = /^[a-z0-9.-]+$/;

/** True when Sedo's integer-USD cells drop cents for this domain. */
function sedoDropsCents(d: ExportDomain, hybridAs: 'buy_now' | 'make_offer'): boolean {
  const fixed = d.listing_mode === 'hybrid' && hybridAs === 'buy_now';
  const priceCents = d.listing_mode === 'offer' ? null : d.bin_cents;
  const minCents = fixed ? null : d.listing_mode === 'bin' ? d.bin_cents : d.min_offer_cents;
  return [priceCents, minCents].some((c) => c !== null && c % 100 !== 0);
}

export interface ExportResult {
  csv: string; filename: string; exportId: string; pendingChanges: number; manualDelist: string[]; warnings: string[];
}

export class ExportService {
  constructor(private readonly deps: { db: Kysely<Database>; config: Config; now: () => number; lockTimeoutMs?: number }) {}

  /**
   * One repeatable-read transaction: read pending / manual-delist / listed rows and insert the snapshot (the only write),
   * so a /list commit cannot fall between the read and the insert. `at` is the app clock taken before any read.
   */
  private async snapshot(
    venue: Venue, changedOnly: boolean,
    build: (listed: ExportDomain[], warnings: string[], settings: { sedo_hybrid_as: 'buy_now' | 'make_offer' }) => { csv: string; exported: string[] },
  ): Promise<ExportResult> {
    const fileAt = new Date(this.deps.now());
    const exportId = `exp_${randomUUID()}`;
    const warnings: string[] = [];
    const out = await this.deps.db.transaction().setIsolationLevel('repeatable read').execute(async (trx) => {
      const settings = await trx.selectFrom('settings').select('sedo_hybrid_as').executeTakeFirstOrThrow();
      const pending = await pendingDomains(trx, venue);
      const gone = await manualDelist(trx, venue);
      let q = trx.selectFrom('domains').select(EXPORT_COLS).where('status', '=', 'listed').orderBy('domain');
      if (changedOnly) q = q.where('domain', 'in', pending.length > 0 ? pending : ['']);
      const all = await q.execute();
      const listed = all.filter((d, i) => {
        if (SAFE_DOMAIN.test(d.domain)) return true;
        warnings.push(`row:${i}:DOMAIN_NOT_ASCII`);
        return false;
      });
      const delist = gone.filter((dom, i) => {
        if (SAFE_DOMAIN.test(dom)) return true;
        warnings.push(`delist:${i}:DOMAIN_NOT_ASCII`);
        return false;
      });
      const built = build(listed, warnings, settings);
      await trx.insertInto('export_runs').values({
        marketplace: venue, at: fileAt, domains: built.exported, export_id: exportId, changed_only: changedOnly, delist,
      }).execute();
      if (built.exported.length > 0) {
        const seen = await trx.selectFrom('domains').select(['domain', 'listing_changed_at']).where('domain', 'in', built.exported).execute();
        await trx.insertInto('export_run_domains').values(seen.map((x) => ({ export_id: exportId, domain: x.domain, listing_changed_at: x.listing_changed_at }))).execute();
      }
      return { csv: built.csv, pendingChanges: pending.length, manualDelist: delist };
    });
    const day = jerusalemDate(fileAt);
    return { csv: out.csv, filename: `${venue}-${day}.csv`, exportId, pendingChanges: out.pendingChanges, manualDelist: out.manualDelist, warnings };
  }

  afternic(changedOnly = false): Promise<ExportResult> {
    return this.snapshot('afternic', changedOnly, (listed, warnings) => {
      const rows: string[][] = [[...AFTERNIC_HEADER]];
      const exported: string[] = [];
      for (const d of listed) {
        const r = afternicRow(d);
        warnings.push(...r.warnings);
        if ('cells' in r.row) {
          rows.push(r.row.cells);
          exported.push(d.domain);
        }
      }
      return { csv: toCsv(rows), exported };
    });
  }

  /** null when there is no Sedo template (nothing is written). */
  async sedo(changedOnly = false): Promise<ExportResult | null> {
    const t = await loadSedoTemplate(this.deps.config.sedoTemplatePath);
    if (!t) return null;
    return this.snapshot('sedo', changedOnly, (listed, warnings, s) => {
      const rows: string[][] = [t.headers];
      const exported: string[] = [];
      for (const d of listed) {
        if (d.display_name !== null && !isValidDisplayName(d.domain, d.display_name)) warnings.push(`DISPLAY_NAME_IGNORED:${d.domain}`); // the Sedo row always uses the lowercase domain
        if (sedoDropsCents(d, s.sedo_hybrid_as)) warnings.push(`${d.domain}:SEDO_ROUNDS_DOWN`);
        rows.push(sedoRow(d, t, s.sedo_hybrid_as));
        exported.push(d.domain);
      }
      return { csv: toCsv(rows), exported };
    });
  }

  /** POST /export/{venue}/uploaded: record a confirmed upload; for Afternic also clear the pending flag (R1). */
  async confirm(venue: Venue, body: { export_id: string; approval_ref?: { text?: unknown; approved_at?: unknown } | null; uploaded_at?: unknown; note?: string | null }, ctx: { auditId: string }) {
    const { db } = this.deps;
    const settings = await db.selectFrom('settings').select('approval_max_age_hours').executeTakeFirstOrThrow();
    const now = new Date(this.deps.now());
    let approvalText: string | null = null;
    let uploadedAt = now;
    if (body.approval_ref) {
      const a = checkTimedApproval(body.approval_ref, now, settings.approval_max_age_hours);
      if (!a.ok) throw new AppError(422, a.code, a.reason);
      approvalText = String(body.approval_ref.text).trim();
      uploadedAt = a.approvedAt;
    } else if (body.uploaded_at != null) {
      if (typeof body.uploaded_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.test(body.uploaded_at)
        || Number.isNaN(new Date(body.uploaded_at).getTime())) {
        throw new AppError(422, 'UPLOADED_AT_INVALID', 'uploaded_at must be ISO 8601 with a timezone offset');
      }
      uploadedAt = new Date(body.uploaded_at);
      if (uploadedAt.getTime() > now.getTime() + 60_000) throw new AppError(422, 'UPLOADED_AT_INVALID', 'uploaded_at is in the future');
    }
    if (body.note != null && body.note.includes('@')) throw new AppError(422, 'NO_PII', "note must not contain an email address or '@'");
    const run = await db.selectFrom('export_runs').selectAll().where('export_id', '=', body.export_id).executeTakeFirst();
    if (!run || run.marketplace !== venue) throw new AppError(404, 'EXPORT_NOT_FOUND', 'No such export for this venue');
    if (uploadedAt.getTime() < run.at.getTime() - 60_000) {
      throw new AppError(422, approvalText ? 'APPROVAL_INVALID' : 'UPLOADED_AT_INVALID', approvalText ? 'the upload approval predates the file' : 'uploaded_at predates the file');
    }
    const already = () => new AppError(409, 'EXPORT_ALREADY_CONFIRMED', 'This export was already confirmed as uploaded');
    if (await db.selectFrom('export_uploads').select('id').where('export_id', '=', run.export_id).executeTakeFirst()) throw already();
    // Clears first, the upload record last: a failed clear leaves no upload, so a retry re-runs cleanly.
    if (venue === 'afternic') {
      const recorded = await db.selectFrom('export_run_domains').select(['domain', 'listing_changed_at']).where('export_id', '=', run.export_id).orderBy('domain').execute();
      for (const rd of recorded) {
        await withDomainLock(db, rd.domain, async (conn) => {
          await conn.updateTable('domains').set({ export_pending_since: null })
            .where('domain', '=', rd.domain)
            .where((eb) => eb.or([eb('listing_changed_at', 'is', null), ...(rd.listing_changed_at ? [eb('listing_changed_at', '<=', rd.listing_changed_at)] : [])]))
            .execute();
        }, { timeoutMs: this.deps.lockTimeoutMs });
      }
    }
    try {
      await db.insertInto('export_uploads').values({
        venue, export_id: run.export_id, domains: run.domains, uploaded_at: uploadedAt,
        approval_text: approvalText, note: body.note?.trim() || null, audit_id: ctx.auditId,
      }).execute();
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw already();
      throw e;
    }
    const pending = await pendingDomains(db, venue);
    const inFile = new Set(run.domains);
    return {
      venue, export_id: run.export_id, domains: run.domains.length, uploaded_at: uploadedAt.toISOString(),
      pending_after: pending.length, still_pending: pending.filter((d) => inFile.has(d)),
    };
  }
}
