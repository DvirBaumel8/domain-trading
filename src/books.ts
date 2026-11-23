// The read routes over data/state.json: /portfolio, /ledger, /report.
import type { FastifyInstance } from 'fastify';
import { pair } from './core/money.js';
import { normalizeDomain } from './domain-name.js';
import { AppError } from './http/errors.js';
import { MAX_DOMAINS, type Domain, type LedgerEntry, type State } from './state.js';

const sum = (rows: readonly LedgerEntry[]): number => rows.reduce((n, r) => n + r.amount_cents, 0);

function domainView(s: State, d: Domain) {
  const rows = s.ledger.filter((r) => r.domain === d.domain);
  return {
    ...d,
    buy_date: rows.find((r) => r.type === 'purchase')!.date,
    renewals_used: rows.filter((r) => r.type === 'renewal').length,
    // an adjustment belongs to the cost side: it corrects what a name cost
    ...pair('cost', -sum(rows.filter((r) => r.type !== 'sale'))),
    ...pair('sold_for', rows.some((r) => r.type === 'sale') ? sum(rows.filter((r) => r.type === 'sale')) : null),
  };
}

const ledgerView = (r: LedgerEntry) => ({ ...r, ...pair('amount', r.amount_cents) });

export function registerBooks(app: FastifyInstance, s: State): void {
  app.get('/portfolio', async () => ({ domains: s.domains.map((d) => domainView(s, d)) }));
  app.get<{ Params: { domain: string } }>('/portfolio/:domain', async (req) => {
    const name = normalizeDomain(req.params.domain);
    const d = s.domains.find((x) => x.domain === name);
    if (!d) throw new AppError(404, 'DOMAIN_NOT_FOUND', `${name} is not in the portfolio`);
    return { ...domainView(s, d), ledger: s.ledger.filter((r) => r.domain === name).map(ledgerView) };
  });
  app.get('/ledger', async () => ({ entries: s.ledger.map(ledgerView), ...pair('total', sum(s.ledger)) }));
  app.get('/report', async () => {
    const sales = sum(s.ledger.filter((r) => r.type === 'sale'));
    return {
      domains_owned: s.domains.filter((d) => d.status === 'owned').length,
      domains_sold: s.domains.filter((d) => d.status === 'sold').length,
      max_domains: MAX_DOMAINS,
      ...pair('spent', sales - sum(s.ledger)),
      ...pair('sales', sales),
      ...pair('net', sum(s.ledger)),
    };
  });
}
