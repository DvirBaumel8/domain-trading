// v5.58.0 (CR-079): the daily missing-name check. Compares the three sources DOM keeps (registrar presence and registry state, the venue records, the ledger) and raises
// the ownership warnings. Pure reads: the daily step `ownershipCheck` and GET /report both call it (through buildWarnings), so they never disagree.
import { sql, type Kysely } from 'kysely';
import { toJerusalemIso } from '../../../core/dates.js';
import type { Database, DomainRow } from '../../../db/types.js';

type Add = (code: string, level: 'info' | 'warn' | 'error', message: string, domain?: string, details?: Record<string, unknown>) => void;

/** The codes the ownership check covers: the four new ones and the three existing ones it keeps (R-3). */
export const OWNERSHIP_CODES = ['DOMAIN_LEFT_ACCOUNT', 'REGISTRY_MISMATCH', 'HOLD_STALE', 'LISTING_RECORD_MISSING', 'LISTING_UNAPPROVED', 'OBSERVED_UNCONFIRMED', 'RECEIPT_POINTER_MISSING'] as const;

const LIVE = ['owned', 'listed', 'delisted'];

export async function ownershipWarnings(db: Kysely<Database>, domains: DomainRow[], add: Add): Promise<void> {
  const live = domains.filter((d) => LIVE.includes(d.status));
  if (live.length === 0) return;
  const names = live.map((d) => d.domain);
  const ids = live.map((d) => d.id);

  // latest record per venue: ours_confirmed (listed unless a removal) and any provenance (observed when the newest is a public sighting)
  const rec = await sql<{ domain: string; venue: string; kind: 'ours' | 'any'; delisted: boolean; provenance: string; listed_at: Date; audit_id: string | null; approval_source: string | null }>`
    select domain, venue, 'ours' as kind, delisted, provenance, listed_at, audit_id, approval_source from
      (select distinct on (domain, venue) * from venue_listings where provenance = 'ours_confirmed' and domain = any(${names}) order by domain, venue, id desc) o
    union all
    select domain, venue, 'any' as kind, delisted, provenance, listed_at, audit_id, approval_source from
      (select distinct on (domain, venue) * from venue_listings where domain = any(${names}) order by domain, venue, id desc) a`.execute(db);
  const ours = new Map<string, typeof rec.rows>();
  const latest = new Map<string, typeof rec.rows>();
  for (const r of rec.rows) {
    const m = r.kind === 'ours' ? ours : latest;
    m.set(r.domain, [...(m.get(r.domain) ?? []), r]);
  }
  const approved = new Set((await sql<{ domain_id: number }>`select distinct domain_id from listing_history where approval_text is not null and domain_id = any(${ids})`.execute(db)).rows.map((r) => Number(r.domain_id)));
  const sold = new Set((await sql<{ domain_id: number }>`select distinct domain_id from sales where domain_id = any(${ids})`.execute(db)).rows.map((r) => Number(r.domain_id)));
  const uploaded = new Set((await sql<{ domain: string; venue: string }>`
    select distinct n.domain, u.venue from export_uploads u join export_runs r on r.export_id = u.export_id, unnest(r.domains) as n(domain) where n.domain = any(${names})`.execute(db)).rows.map((r) => `${r.domain}|${r.venue}`));
  const reg = await sql<{ domain_id: number; receipt_ref: string | null; deal_id: string | null }>`
    select distinct on (domain_id) domain_id, receipt_ref, deal_id from ledger_entries where type = 'registration' and domain_id = any(${ids}) order by domain_id, id`.execute(db);
  const regOf = new Map(reg.rows.map((r) => [Number(r.domain_id), r]));

  for (const d of live) {
    const mine = (ours.get(d.domain) ?? []).filter((r) => !r.delisted);
    const listedVenues = mine.map((r) => r.venue).sort();
    if (d.status === 'listed' && !listedVenues.some((v) => v === 'afternic' || v === 'sedo')) {
      add('LISTING_RECORD_MISSING', 'warn', `${d.domain} is listed but no Afternic or Sedo listing is recorded as ours (record it with POST /listings/${d.domain}/venue, or the export upload).`, d.domain, { domain: d.domain, status: d.status, listed_venues: listedVenues });
    }
    for (const r of mine) {
      if (sold.has(d.id) || approved.has(d.id) || r.audit_id !== null || r.approval_source === 'seed_cr076' || uploaded.has(`${d.domain}|${r.venue}`)) continue;
      add('LISTING_UNAPPROVED', 'warn', `${d.domain}: a ${r.venue} listing is recorded as ours with no listing approval, no audited venue record and no confirmed upload behind it.`, d.domain, {
        domain: d.domain, venue: r.venue, listed_by_hand_at: toJerusalemIso(r.listed_at), export_confirmed_at: null,
      });
    }
    const listedSet = new Set(listedVenues);
    for (const r of latest.get(d.domain) ?? []) {
      if (r.provenance === 'observed_public' && !listedSet.has(r.venue)) {
        add('OBSERVED_UNCONFIRMED', 'info', `${d.domain} was seen on ${r.venue} (public page); whether the listing is ours is not confirmed.`, d.domain, { domain: d.domain, venue: r.venue });
      }
    }
    const g = regOf.get(d.id);
    if (!g || g.receipt_ref === null || g.receipt_ref.trim() === '') {
      add('RECEIPT_POINTER_MISSING', 'warn', `${d.domain} has ${g ? 'a registration ledger row with no receipt_ref' : 'no registration ledger row'}.`, d.domain, { domain: d.domain, ...(g?.deal_id ? { deal_id: g.deal_id } : d.deal_id ? { deal_id: d.deal_id } : {}) });
    }
  }
}
