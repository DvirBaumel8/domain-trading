// Daily step `listingSync` (v4.0.0; CR-049 items 1 and 4). After the price job it makes Spaceship SellerHub show what the plan says: for every listed name
// binPrice = the plan's BIN and minPrice = the PUBLIC min offer (never the floor or the walk-away, founder rule 4); a listing of a name that is delisted, dropped or sold is deleted.
// The SellerHub sold report is read: a sale there raises DELIST_NEEDED for Afternic and Sedo (/report). Names SellerHub holds that are not ours are never touched.
// Disabled cleanly (skipped) when the key pair is absent. The price job itself never calls a marketplace.
import type { Kysely } from 'kysely';
import { scrubSecrets } from '../../../core/redact.js';
import { trySessionLock } from '../../../core/locks.js';
import type { Database } from '../../../db/types.js';
import { centsOfAmount, SellerHubClient, SellerHubError, type SellerHubItem } from '../sellerhub.js';

export interface ListingSyncSummary {
  skipped: boolean; reason?: string; created: string[]; updated: string[]; deleted: string[]; sold_seen: string[]; failed: { domain: string; reason: string }[];
}

export class ListingSyncJob {
  constructor(private readonly deps: { db: Kysely<Database>; client: SellerHubClient | null; now: () => number; secretValues?: string[]; log?: { warn(o: object, m: string): void } }) {}

  async runOnce(): Promise<ListingSyncSummary> {
    const out: ListingSyncSummary = { skipped: false, created: [], updated: [], deleted: [], sold_seen: [], failed: [] };
    const { client, db } = this.deps;
    if (!client) return { ...out, skipped: true, reason: 'SellerHub keys not configured' };
    const lock = await trySessionLock(db, 'job:listing-sync');
    if (!lock) return { ...out, skipped: true, reason: 'another listing sync is running' };
    try {
      let remote: SellerHubItem[];
      try { remote = await client.list(); } catch (e) { return { ...out, failed: [{ domain: '*', reason: this.clean(e) }] }; }
      const remoteBy = new Map(remote.map((r) => [(r.unicodeName ?? r.name).toLowerCase(), r]));
      const doms = await db.selectFrom('domains').select(['domain', 'status', 'listing_mode', 'bin_cents', 'min_offer_cents']).where('status', '!=', 'pending_purchase').orderBy('domain').execute();
      const ours = new Map(doms.map((d) => [d.domain, d]));

      // 1. what the plan says, for every listed name
      for (const d of doms.filter((x) => x.status === 'listed' && (x.bin_cents !== null || x.min_offer_cents !== null))) {
        const want = { binCents: d.listing_mode === 'offer' ? null : d.bin_cents, minCents: d.listing_mode === 'bin' ? null : d.min_offer_cents };
        if (want.binCents === null && want.minCents === null) continue;
        const r = remoteBy.get(d.domain);
        try {
          if (!r) {
            await client.create(d.domain, want);
            await this.log(d.domain, 'create', want.binCents, want.minCents, 201);
            out.created.push(d.domain);
          } else if (!same(r, want)) {
            await client.update(d.domain, want);
            await this.log(d.domain, 'update', want.binCents, want.minCents, 200);
            out.updated.push(d.domain);
          }
        } catch (e) {
          out.failed.push({ domain: d.domain, reason: this.clean(e) });
          await this.log(d.domain, 'error', want.binCents, want.minCents, e instanceof SellerHubError ? e.status : null, this.clean(e));
        }
      }
      // 2. our names that must not be on sale any more
      for (const [name, r] of remoteBy) {
        const d = ours.get(name);
        if (!d || d.status === 'listed') continue;
        if (r.status && /sold|removed|deleted/i.test(r.status)) continue;
        await this.remove(name, out);
      }
      // 3. sales made at SellerHub
      try {
        for (const s of await client.sold()) {
          const name = (s.unicodeName ?? s.name).toLowerCase();
          const d = ours.get(name);
          if (!d || d.status === 'sold' || d.status === 'dropped') continue;
          const last = await db.selectFrom('listing_sync_log').select('detail').where('domain', '=', name).where('action', '=', 'sold_seen').orderBy('id', 'desc').limit(1).executeTakeFirst();
          if (last?.detail === (s.saleDateTime ?? '')) continue;
          await this.log(name, 'sold_seen', null, null, 200, s.saleDateTime ?? '');
          out.sold_seen.push(name);
          if (remoteBy.has(name) && !out.deleted.includes(name)) await this.remove(name, out);
        }
      } catch (e) {
        out.failed.push({ domain: '*', reason: this.clean(e) });
      }
      return out;
    } finally {
      await lock.release();
    }
  }

  /** v4.0.0 (CR-049 item 4): delist one name at SellerHub right away (called after /sold). Best effort; a 404 is fine; errors are logged, never thrown. */
  async delist(domain: string): Promise<{ done: boolean }> {
    if (!this.deps.client) return { done: false };
    const out: ListingSyncSummary = { skipped: false, created: [], updated: [], deleted: [], sold_seen: [], failed: [] };
    await this.remove(domain, out);
    return { done: out.deleted.length > 0 };
  }

  private async remove(name: string, out: ListingSyncSummary): Promise<void> {
    try {
      await this.deps.client!.remove(name);
      await this.log(name, 'delete', null, null, 204);
      out.deleted.push(name);
    } catch (e) {
      if (e instanceof SellerHubError && e.status === 404) return;
      out.failed.push({ domain: name, reason: this.clean(e) });
      await this.log(name, 'error', null, null, e instanceof SellerHubError ? e.status : null, this.clean(e));
    }
  }

  private async log(domain: string, action: 'create' | 'update' | 'delete' | 'sold_seen' | 'error', bin: number | null, min: number | null, status: number | null, detail: string | null = null): Promise<void> {
    await this.deps.db.insertInto('listing_sync_log').values({ domain, venue: 'sellerhub', action, bin_cents: bin, min_offer_cents: min, http_status: status, detail, at: new Date(this.deps.now()) }).execute();
  }

  private clean(e: unknown): string {
    const m = scrubSecrets(e instanceof Error ? e.message : String(e), this.deps.secretValues ?? []);
    return m.length > 200 ? `${m.slice(0, 200)}...` : m;
  }
}

function same(r: SellerHubItem, w: { binCents: number | null; minCents: number | null }): boolean {
  const bin = r.binPriceEnabled === false ? null : centsOfAmount(r.binPrice?.amount);
  const min = r.minPriceEnabled === false ? null : centsOfAmount(r.minPrice?.amount);
  return bin === w.binCents && min === w.minCents;
}
