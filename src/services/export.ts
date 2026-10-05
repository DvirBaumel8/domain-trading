import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sql, type Kysely } from 'kysely';
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

export class ExportService {
  constructor(private readonly deps: { db: Kysely<Database>; config: Config; now: () => number }) {}

  /** Listed domains safe for headers/rows; unsafe ones become index-only warnings (no raw value). */
  private async listed(warnings: string[]): Promise<ExportDomain[]> {
    const all = await this.deps.db.selectFrom('domains').select(EXPORT_COLS).where('status', '=', 'listed').orderBy('domain').execute();
    return all.filter((d, i) => {
      if (SAFE_DOMAIN.test(d.domain)) return true;
      warnings.push(`${i}:DOMAIN_NOT_ASCII`);
      return false;
    });
  }

  async afternic(): Promise<{ csv: string; filename: string; delist: string[]; warnings: string[] }> {
    const { db } = this.deps;
    const rows: string[][] = [[...AFTERNIC_HEADER]];
    const warnings: string[] = [];
    const exported: string[] = [];
    for (const d of await this.listed(warnings)) {
      const r = afternicRow(d);
      warnings.push(...r.warnings);
      if ('cells' in r.row) {
        rows.push(r.row.cells);
        exported.push(d.domain);
      }
    }
    const gone = await sql<{ domain: string }>`
      select d.domain from domains d
      where d.status in ('sold', 'dropped')
        and exists (select 1 from export_runs r where r.marketplace = 'afternic' and d.domain = any(r.domains))
      order by d.domain`.execute(db);
    const delist = gone.rows.map((r) => r.domain).filter((dom, i) => {
      if (SAFE_DOMAIN.test(dom)) return true;
      warnings.push(`${i}:DOMAIN_NOT_ASCII`);
      return false;
    });
    // Last DB step.
    await db.insertInto('export_runs').values({ marketplace: 'afternic', domains: exported, export_id: `exp_${randomUUID()}` }).execute();
    return { csv: toCsv(rows), filename: `afternic-${jerusalemDate(new Date(this.deps.now()))}.csv`, delist, warnings };
  }

  async sedo(): Promise<{ csv: string; filename: string; warnings: string[] } | null> {
    const t = await loadSedoTemplate(this.deps.config.sedoTemplatePath);
    if (!t) return null;
    const s = await this.deps.db.selectFrom('settings').select('sedo_hybrid_as').executeTakeFirstOrThrow();
    const warnings: string[] = [];
    const rows: string[][] = [t.headers];
    const exported: string[] = [];
    for (const d of await this.listed(warnings)) {
      if (d.display_name !== null && !isValidDisplayName(d.domain, d.display_name)) warnings.push(`DISPLAY_NAME_IGNORED:${d.domain}`); // the Sedo row always uses the lowercase domain
      if (sedoDropsCents(d, s.sedo_hybrid_as)) warnings.push(`${d.domain}:SEDO_ROUNDS_DOWN`);
      rows.push(sedoRow(d, t, s.sedo_hybrid_as));
      exported.push(d.domain);
    }
    await this.deps.db.insertInto('export_runs').values({ marketplace: 'sedo', domains: exported, export_id: `exp_${randomUUID()}` }).execute();
    return { csv: toCsv(rows), filename: `sedo-${jerusalemDate(new Date(this.deps.now()))}.csv`, warnings };
  }
}
