// G9 quote (CAP-17): the cheapest first year + one renewal from the live registrar quotes (the check service, 60 s cache, never a
// create call, never a top-up), else a fresh manual quote for a registrar that cannot be machine-quoted. A missing renewal is
// UNKNOWN, never 0 (CK-7); never Cloudflare. A live adapter error is SOURCE_ERROR, never a reason to fall back to a manual quote.
import { formatUsd } from '../../core/money.js';
import { pickWinner } from '../../services/selection.js';
import type { SelectionValuesT } from '../settings.js';
import { outcome, type Check } from '../types.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const isCloudflare = (r: string) => r.toLowerCase().includes('cloudflare');

/**
 * A quote result is too old to use: a live one by `quote.max_age_hours` from its `quoted_at`, a manual one by
 * `quote.manual_max_age_days`. Also applied to a result reused from the cache, judged by its original `quoted_at`.
 */
export function quoteIsStale(fields: Record<string, unknown>, q: SelectionValuesT['quote'], now: number): boolean {
  const at = typeof fields.quoted_at === 'string' ? Date.parse(fields.quoted_at) : NaN;
  if (Number.isNaN(at)) return true;
  const limit = fields.quote_source === 'manual' ? q.manual_max_age_days * DAY_MS : q.max_age_hours * HOUR_MS;
  return now - at > limit;
}

export const quoteCheck: Check = {
  id: 'quote',
  gate: 'G9',
  ruleIds: ['CAP-17', 'CK-7'],
  lists: [],
  async run(ctx) {
    const none = { registrar: null, first_year_cents: null, renewal_cents: null, two_year_cents: null, quote_source: null, fallback_reason: null };
    let live: Awaited<ReturnType<typeof ctx.deps.checkService.check>>;
    try {
      live = await ctx.deps.checkService.check(ctx.item.domain);
    } catch (e) {
      return outcome('UNKNOWN', 'SOURCE_ERROR', `The registrar quote failed: ${String((e as Error).message ?? e).slice(0, 120)}`, none);
    }
    // A Cloudflare winner is skipped in favour of the next live quote (founder rule 5).
    const w = live.availability === 'available' ? pickWinner(live.quotes.filter((q) => !isCloudflare(q.registrar))) : null;
    if (w && w.firstYearCents !== null && w.renewalCents !== null && w.twoYearCents !== null) {
      const fields = {
        registrar: w.registrar, first_year_cents: w.firstYearCents, first_year: formatUsd(w.firstYearCents),
        renewal_cents: w.renewalCents, renewal: formatUsd(w.renewalCents), two_year_cents: w.twoYearCents, two_year: formatUsd(w.twoYearCents),
        registrar_ft_capable: w.capabilities.afternicFastTransfer, quoted_at: live.checkedAt.toISOString(), quote_source: 'live', fallback_reason: null,
      };
      if (quoteIsStale(fields, ctx.settings.quote, ctx.now())) return outcome('UNKNOWN', 'STALE_DATA', 'The live quote is older than quote.max_age_hours', fields, { dataAsOf: live.checkedAt });
      return outcome('PASS', null, null, fields, { dataAsOf: live.checkedAt, upstreamCalls: live.quotes.length });
    }
    // An adapter that should have quoted and failed is an error, not a missing quote.
    const failed = live.quotes.find((q) => q.exclusionReason === 'ADAPTER_ERROR');
    if (failed) return outcome('UNKNOWN', 'SOURCE_ERROR', `${failed.registrar} could not quote (${failed.errorCode ?? 'error'}); a manual quote is not a substitute`, none, { upstreamCalls: live.quotes.length });

    const since = new Date(ctx.now() - ctx.settings.quote.manual_max_age_days * DAY_MS);
    const m = await ctx.db.selectFrom('manual_quotes').selectAll().where('domain', '=', ctx.item.domain).where('observed_at', '>=', since)
      .orderBy('observed_at', 'desc').orderBy('id', 'desc').execute();
    const machine = new Map(live.quotes.map((q) => [q.registrar, q.capabilities.canQuote]));
    // Only a registrar with no adapter, or a management-only one (GoDaddy), may be quoted by hand.
    const row = m.find((q) => !isCloudflare(q.registrar) && q.renewal_cents > 0 && machine.get(q.registrar) !== true);
    if (row) {
      const two = row.first_year_cents === null ? null : row.first_year_cents + row.renewal_cents;
      return outcome('PASS', null, null, {
        registrar: row.registrar, first_year_cents: row.first_year_cents, first_year: row.first_year_cents === null ? null : formatUsd(row.first_year_cents),
        renewal_cents: row.renewal_cents, renewal: formatUsd(row.renewal_cents), two_year_cents: two, two_year: two === null ? null : formatUsd(two),
        registrar_ft_capable: null, quoted_at: row.observed_at.toISOString(), quote_source: 'manual',
        fallback_reason: machine.has(row.registrar) ? 'REGISTRAR_NOT_MACHINE_QUOTABLE' : 'NO_ADAPTER', source_url: row.source_url, source_note: row.source_note,
      }, { dataAsOf: row.observed_at });
    }
    return outcome('UNKNOWN', 'NO_QUOTE', 'No registrar quoted a first year and a renewal, and no fresh manual quote exists for a registrar that cannot be machine-quoted', none);
  },
};
