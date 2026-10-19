// v5.18.0 (CR-068): POST /visits/forward/{domain}. Points a listed name's Porkbun URL forward at the counting redirect (`<public base>/r/<domain>` on the
// api-proxy Worker, which 302s on to the Afternic page and counts the hit), or back to the Afternic page (revert). Only the root and www forwards are touched.
// Nothing else at the registrar changes (no nameserver, no DNS record, no price). The state is kept in visit_forwards.
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { AppError } from '../../http/errors.js';
import { RegistrarError, type RegistrarAdapter, type UrlForward } from '../registrars/index.js';
import { onAfternicNs } from './store.js';
import { DEFAULT_PUBLIC_BASE_URL } from '../../config.js';

export const afternicTarget = (domain: string): string => `https://www.afternic.com/domain/${domain}`;

export interface ForwardView { subdomain: string; location: string; type: string; include_path: boolean; wildcard: boolean }
const view = (f: Pick<UrlForward, 'subdomain' | 'location' | 'type' | 'includePath' | 'wildcard'>): ForwardView => ({ subdomain: f.subdomain, location: f.location, type: f.type, include_path: f.includePath, wildcard: f.wildcard });

export interface ForwardResult { domain: string; before: ForwardView[]; after: ForwardView[]; dry_run: boolean; revert: boolean }

export async function setForward(deps: { db: Kysely<Database>; adapters: RegistrarAdapter[]; publicBaseUrl: string; now: () => number; nsLookup?: (d: string) => Promise<string[] | null> }, o: {
  domain: string; revert: boolean; dryRun: boolean;
}): Promise<ForwardResult> {
  const { db } = deps;
  // v5.19.0 (Dvir, 19 Oct 2026): no approval line; CR-068 was approved as a whole. A sent approval_ref is accepted and ignored.

  const row = await db.selectFrom('domains').select(['status', 'registrar', 'lander', 'lander_ns']).where('domain', '=', o.domain).executeTakeFirst();
  if (!row) throw new AppError(404, 'DOMAIN_NOT_FOUND', 'Domain not found');
  if (row.status !== 'listed') throw new AppError(422, 'FORWARD_NOT_ALLOWED', `${o.domain} is not listed`, { reason: 'not_listed', status: row.status });
  if (row.registrar !== 'porkbun') throw new AppError(422, 'FORWARD_NOT_ALLOWED', 'URL forwards are set only at Porkbun', { reason: 'registrar', registrar: row.registrar });
  // BUG-045: the live nameservers decide (also on dry_run); the stored lander_ns only when the lookup fails.
  const liveNs = deps.nsLookup ? await deps.nsLookup(o.domain).catch(() => null) : null;
  if (onAfternicNs(row, liveNs)) throw new AppError(422, 'FORWARD_NOT_ALLOWED', 'The name is on Afternic nameservers: Afternic serves its page, a registrar forward would not be used', { reason: 'afternic_ns' });

  const counting = `${deps.publicBaseUrl.replace(/\/+$/, '')}/r/${o.domain}`;
  if (!o.revert && (deps.publicBaseUrl === DEFAULT_PUBLIC_BASE_URL || deps.publicBaseUrl.trim() === '')) {
    throw new AppError(422, 'PUBLIC_BASE_URL_UNSET', 'PUBLIC_BASE_URL is not set to the public (api-proxy) URL, so the counting redirect address is unknown');
  }
  const target = o.revert ? afternicTarget(o.domain) : counting;

  const adapter = deps.adapters.find((x) => x.name === 'porkbun');
  if (!adapter?.getUrlForwards || !adapter.addUrlForward || !adapter.deleteUrlForward) throw new AppError(503, 'REGISTRAR_UNAVAILABLE', 'The Porkbun adapter is not configured');

  const registrarCall = async <T>(fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (e) {
      if (e instanceof RegistrarError) throw new AppError(502, 'REGISTRAR_ERROR', `Porkbun refused the forward call (${e.code})`, { registrar: 'porkbun', registrar_code: e.code });
      throw e;
    }
  };

  const current = await registrarCall(() => adapter.getUrlForwards!(o.domain));
  const ours = current.filter((f) => f.subdomain === '' || f.subdomain === 'www');
  // Root always; www too when the name had a www forward. Wildcard like the old root forward (default yes); the path is never appended.
  const wildcard = (ours.find((f) => f.subdomain === '') ?? ours[0])?.wildcard ?? true;
  const subs = ['', ...(ours.some((f) => f.subdomain === 'www') ? ['www'] : [])];
  const planned: ForwardView[] = subs.map((s) => ({ subdomain: s, location: target, type: 'temporary', include_path: false, wildcard }));
  const result: ForwardResult = { domain: o.domain, before: ours.map(view), after: planned, dry_run: o.dryRun, revert: o.revert };
  if (o.dryRun) return result;

  for (const f of ours) await registrarCall(() => adapter.deleteUrlForward!(o.domain, f.id));
  for (const p of planned) await registrarCall(() => adapter.addUrlForward!(o.domain, { subdomain: p.subdomain, location: target, temporary: true, includePath: false, wildcard }));
  const now = new Date(deps.now());
  await db.insertInto('visit_forwards')
    .values({ domain: o.domain, target, before_forwards: JSON.stringify(result.before), set_at: now, reverted_at: o.revert ? now : null })
    .onConflict((oc) => oc.column('domain').doUpdateSet({ target, before_forwards: JSON.stringify(result.before), set_at: now, reverted_at: o.revert ? now : null }))
    .execute();
  return result;
}
