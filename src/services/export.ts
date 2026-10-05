import { readFile } from 'node:fs/promises';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Config } from '../config.js';
import { jerusalemDate } from '../dates.js';
import type { Database, DomainRow } from '../db/types.js';

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
  const name = d.display_name ?? d.domain;
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
  return { row: { cells }, warnings: round.dropped ? [`${d.domain}:AFTERNIC_ROUNDS_DOWN`] : [] };
}

const SedoTemplateSchema = z.object({
  headers: z.array(z.string().min(1)).min(1),
  map: z.object({
    domain: z.string(), selling_option: z.string(), for_sale: z.string(), price: z.string(),
    min_price: z.string(), currency: z.string(), action: z.string(),
  }),
  values: z.object({ buy_now: z.string(), make_offer: z.string(), for_sale_yes: z.string(), usd: z.string(), action_add: z.string() }),
}).refine((t) => Object.values(t.map).every((h) => t.headers.includes(h)), 'every mapped header must be in headers');
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
  const parsed = SedoTemplateSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new SedoTemplateInvalid(parsed.error.issues.map((i) => i.message).join('; '));
  return parsed.data;
}

export function sedoRow(d: ExportDomain, t: SedoTemplate, hybridAs: 'buy_now' | 'make_offer'): string[] {
  const round = { dropped: false };
  const fixed = d.listing_mode === 'bin' || (d.listing_mode === 'hybrid' && hybridAs === 'buy_now');
  const fields: Record<keyof SedoTemplate['map'], string> = {
    domain: d.domain,
    selling_option: fixed ? t.values.buy_now : t.values.make_offer,
    for_sale: t.values.for_sale_yes,
    price: d.listing_mode === 'offer' ? '' : usd(d.bin_cents, round),
    min_price: fixed ? '' : usd(d.min_offer_cents, round),
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

export class ExportService {
  constructor(private readonly deps: { db: Kysely<Database>; config: Config; now: () => number }) {}

  private async listed(): Promise<ExportDomain[]> {
    return this.deps.db.selectFrom('domains').select(EXPORT_COLS).where('status', '=', 'listed').orderBy('domain').execute();
  }

  async afternic(): Promise<{ csv: string; filename: string; delist: string[]; warnings: string[] }> {
    const { db } = this.deps;
    const rows: string[][] = [[...AFTERNIC_HEADER]];
    const warnings: string[] = [];
    const exported: string[] = [];
    for (const d of await this.listed()) {
      const r = afternicRow(d);
      warnings.push(...r.warnings);
      if ('cells' in r.row) {
        rows.push(r.row.cells);
        exported.push(d.domain);
      }
    }
    const last = await db.selectFrom('export_runs').select('at').where('marketplace', '=', 'afternic').orderBy('at', 'desc').executeTakeFirst();
    let q = db.selectFrom('domains').select('domain').where('status', 'in', ['sold', 'dropped']).where('delisted_at', 'is not', null);
    if (last) q = q.where('delisted_at', '>', last.at);
    const delist = (await q.orderBy('domain').execute()).map((r) => r.domain);
    await db.insertInto('export_runs').values({ marketplace: 'afternic', domains: exported }).execute();
    return { csv: toCsv(rows), filename: `afternic-${jerusalemDate(new Date(this.deps.now()))}.csv`, delist, warnings };
  }

  async sedo(): Promise<{ csv: string; filename: string; warnings: string[] } | null> {
    const t = await loadSedoTemplate(this.deps.config.sedoTemplatePath);
    if (!t) return null;
    const s = await this.deps.db.selectFrom('settings').select('sedo_hybrid_as').executeTakeFirstOrThrow();
    const rows: string[][] = [t.headers];
    for (const d of await this.listed()) rows.push(sedoRow(d, t, s.sedo_hybrid_as));
    await this.deps.db.insertInto('export_runs').values({ marketplace: 'sedo', domains: rows.slice(1).map((r) => r[t.headers.indexOf(t.map.domain)]!) }).execute();
    return { csv: toCsv(rows), filename: `sedo-${jerusalemDate(new Date(this.deps.now()))}.csv`, warnings: [] };
  }
}
