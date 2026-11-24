// The money rules for one candidate (CR-117): GET /budget. It reads and calculates; nothing here buys.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pair } from './core/money.js';
import { AppError } from './http/errors.js';
import { closeoutSpentCents, MAX_CLOSEOUT_CENTS, MAX_DOMAINS, MAX_PURCHASE_CENTS, MAX_SPENT_CENTS, SOURCES, spentCents, type Source, type State } from './state.js';

/** What one name would cost: the year-1 total, and one renewal kept for year 2. */
export interface Cost { allInCents: number; renewalCents: number | null; source: Source }
export interface Budget {
  status: 'within' | 'over' | 'unknown';
  over: string[];
  unknown: string[];
  spentCents: number; reserveCents: number; openBidsCents: number; committedCents: number; closeoutCents: number; slots: number;
}

/** One renewal for every owned name that may still be renewed. A name whose price we do not know is listed, never counted as zero. */
export function ownedReserve(s: State): { cents: number; unknown: string[] } {
  const names = s.domains.filter((d) => d.status === 'owned' && !d.do_not_renew_since && !s.ledger.some((r) => r.domain === d.domain && r.type === 'renewal'));
  return { cents: names.reduce((n, d) => n + (d.renewal_cents ?? 0), 0), unknown: names.filter((d) => d.renewal_cents === undefined).map((d) => d.domain) };
}

/** `open` = every open bid at its maximum, null = not known. Over on the known part alone is "over"; anything unknown otherwise is "unknown", never "within". */
export function budget(s: State, c: Cost, open: readonly Cost[] | null): Budget {
  const reserve = ownedReserve(s);
  const bids = open ?? [];
  const sum = (xs: readonly Cost[], f: (x: Cost) => number) => xs.reduce((n, x) => n + f(x), 0);
  const all = [...bids, c];
  const spent = spentCents(s);
  const openCents = sum(bids, (x) => x.allInCents);
  const reserveCents = reserve.cents + sum(all, (x) => x.renewalCents ?? 0);
  const committed = spent + reserveCents + openCents + c.allInCents;
  const closeout = closeoutSpentCents(s) + sum(all.filter((x) => x.source === 'closeout'), (x) => x.allInCents);
  const slots = s.domains.filter((d) => d.status === 'owned').length + all.length;

  const over: string[] = [];
  if (committed > MAX_SPENT_CENTS) over.push('total');
  if (c.allInCents > MAX_PURCHASE_CENTS) over.push('per_name');
  if (slots > MAX_DOMAINS) over.push('slots');
  if (c.source === 'closeout' && closeout > MAX_CLOSEOUT_CENTS) over.push('closeout_pilot');
  const unknown = [
    ...(open === null ? ['open_bids'] : []),
    ...(all.some((x) => x.renewalCents === null) ? ['renewal_price'] : []),
    ...reserve.unknown.map((d) => `renewal_price:${d}`),
  ];
  return { status: over.length > 0 ? 'over' : unknown.length > 0 ? 'unknown' : 'within', over, unknown, spentCents: spent, reserveCents, openBidsCents: openCents, committedCents: committed, closeoutCents: closeout, slots };
}

const cents = z.string().regex(/^\d{1,7}$/).transform(Number);
const Query = z.object({ price_cents: cents, fee_cents: cents, renewal_cents: cents, source: z.enum(SOURCES), open_bids: z.string() });
const HINT = 'price_cents, fee_cents, renewal_cents, source and open_bids are required; open_bids is "none", "unknown" or a list of all_in_cents:renewal_cents:source separated by commas';

function openBids(text: string): Cost[] | null {
  if (text === 'none') return [];
  if (text === 'unknown') return null;
  return text.split(',').map((part) => {
    const [a, r, source, ...rest] = part.trim().split(':');
    const parsed = z.object({ allInCents: cents, renewalCents: cents, source: z.enum(SOURCES) }).safeParse({ allInCents: a, renewalCents: r, source });
    if (!parsed.success || rest.length > 0) throw new AppError(400, 'VALIDATION_ERROR', HINT);
    return parsed.data;
  });
}

export function registerBudget(app: FastifyInstance, s: State): void {
  app.get('/budget', async (req) => {
    const q = Query.safeParse(req.query);
    if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', HINT);
    const allInCents = q.data.price_cents + q.data.renewal_cents + q.data.fee_cents;
    const b = budget(s, { allInCents, renewalCents: q.data.renewal_cents, source: q.data.source }, openBids(q.data.open_bids));
    return {
      status: b.status, over: b.over, unknown: b.unknown,
      ...pair('all_in', allInCents), ...pair('spent', b.spentCents), ...pair('year2_reserve', b.reserveCents), ...pair('open_bids', b.openBidsCents),
      ...pair('committed', b.committedCents), ...pair('max_total', MAX_SPENT_CENTS), ...pair('max_per_name', MAX_PURCHASE_CENTS),
      ...pair('closeout_pilot', b.closeoutCents), ...pair('max_closeout_pilot', MAX_CLOSEOUT_CENTS), slots: b.slots, max_slots: MAX_DOMAINS,
    };
  });
}
