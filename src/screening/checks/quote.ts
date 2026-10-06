// G9 quote (CAP-17): the cheapest first year + one renewal from the live registrar quotes (the check service, 60 s cache, never a
// create call, never a top-up), else a fresh manual quote. A missing renewal is UNKNOWN, never 0 (CK-7); never Cloudflare.
import { formatUsd } from '../../money.js';
import { outcome, type Check } from '../types.js';

const DAY_MS = 86_400_000;
const isCloudflare = (r: string) => r.toLowerCase().includes('cloudflare');

export const quoteCheck: Check = {
  id: 'quote',
  gate: 'G9',
  ruleIds: ['CAP-17', 'CK-7'],
  lists: [],
  async run(ctx) {
    let live: Awaited<ReturnType<typeof ctx.deps.checkService.check>> | null = null;
    try {
      live = await ctx.deps.checkService.check(ctx.item.domain);
    } catch {
      live = null; // an adapter error is a missing quote, not a crash
    }
    const w = live?.winner;
    if (live && w && !isCloudflare(w.registrar) && w.firstYearCents !== null && w.renewalCents !== null && w.twoYearCents !== null) {
      return outcome('PASS', null, null, {
        registrar: w.registrar, first_year_cents: w.firstYearCents, first_year: formatUsd(w.firstYearCents),
        renewal_cents: w.renewalCents, renewal: formatUsd(w.renewalCents), two_year_cents: w.twoYearCents, two_year: formatUsd(w.twoYearCents),
        registrar_ft_capable: w.capabilities.afternicFastTransfer, quoted_at: live.checkedAt.toISOString(), source: 'live',
      }, { dataAsOf: live.checkedAt, upstreamCalls: live.quotes.length });
    }
    const since = new Date(ctx.now() - ctx.settings.quote.manual_max_age_days * DAY_MS);
    const m = await ctx.db.selectFrom('manual_quotes').selectAll().where('domain', '=', ctx.item.domain).where('observed_at', '>=', since)
      .orderBy('observed_at', 'desc').orderBy('id', 'desc').execute();
    const row = m.find((q) => !isCloudflare(q.registrar) && q.renewal_cents > 0);
    if (row) {
      const two = row.first_year_cents === null ? null : row.first_year_cents + row.renewal_cents;
      return outcome('PASS', null, null, {
        registrar: row.registrar, first_year_cents: row.first_year_cents, first_year: row.first_year_cents === null ? null : formatUsd(row.first_year_cents),
        renewal_cents: row.renewal_cents, renewal: formatUsd(row.renewal_cents), two_year_cents: two, two_year: two === null ? null : formatUsd(two),
        registrar_ft_capable: null, quoted_at: row.observed_at.toISOString(), source: 'manual', source_url: row.source_url, source_note: row.source_note,
      }, { dataAsOf: row.observed_at });
    }
    return outcome('UNKNOWN', 'NO_QUOTE', 'No registrar quoted a first year and a renewal, and no fresh manual quote exists', {
      registrar: null, first_year_cents: null, renewal_cents: null, two_year_cents: null, source: null,
    });
  },
};
