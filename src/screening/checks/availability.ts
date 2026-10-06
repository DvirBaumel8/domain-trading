// G2 availability (CAP-03, S1): the .com registry's RDAP says whether the name is registered. 404 = available; 200 with a domain
// object = registered; anything else is UNKNOWN with the reason, never "available".
import { lookupCached, sharedPacer } from '../rdap-batch.js';
import { outcome, type Check } from '../types.js';

export const availabilityCheck: Check = {
  id: 'availability',
  gate: 'G2',
  ruleIds: ['S1'],
  lists: [],
  async run(ctx) {
    const checkedAt = new Date(ctx.now()).toISOString();
    const base = { availability: 'unknown', checked_at: checkedAt };
    if (!ctx.settings.sources.rdap_com) return outcome('UNKNOWN', 'SOURCE_DISABLED', 'The .com RDAP source is switched off (sources.rdap_com)', base);
    const r = await lookupCached(ctx.db, ctx.deps, ctx.item.domain, {
      maxAgeHours: ctx.settings.freshness_hours.availability ?? 0, evidenceMaxBytes: ctx.settings.evidence.max_text_bytes,
      pace: sharedPacer(ctx), now: ctx.now,
    });
    const extra = { dataAsOf: r.retrievedAt, evidenceIds: r.evidenceId === null ? [] : [r.evidenceId], upstreamCalls: r.cached ? 0 : 1 };
    if (r.outcome === 'not_registered') return outcome('PASS', null, null, { availability: 'available', checked_at: checkedAt, http_status: r.httpStatus }, extra);
    if (r.outcome === 'registered') {
      const f = r.facts;
      return outcome('FAIL', 'REGISTERED', `${ctx.item.domain} is registered${f?.registrar ? ` (registrar ${f.registrar})` : ''}`, {
        availability: 'registered', checked_at: checkedAt, registrar: f?.registrar ?? null, created_at: f?.created_at ?? null, expires_at: f?.expires_at ?? null,
        updated_at: f?.updated_at ?? null, registry_statuses: f?.statuses ?? [], nameservers: f?.nameservers ?? [],
      }, extra);
    }
    const code = r.reasonCode ?? 'SOURCE_ERROR';
    return outcome('UNKNOWN', code, `The registry did not answer usefully (${code}${r.httpStatus ? `, HTTP ${r.httpStatus}` : ''})`, { ...base, http_status: r.httpStatus }, extra);
  },
};
