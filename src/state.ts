// The whole state of the company: data/state.json (the domains owned and the money spent). The app only reads it. A change is a git commit;
// CI runs `npm run check-state` on it and Render deploys only after CI passes, so a file that breaks a rule here never goes live.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { isRealDate } from './core/dates.js';
import { isValidDisplayName, normalizeDomain } from './domain-name.js';

/** Founder rule 2: 40 domains. Founder rule 5: $250 a name. They change only by a commit, never through the API. */
export const MAX_DOMAINS = 40;
export const MAX_PURCHASE_CENTS = 25_000;
/** Founder rule 1: Dvir's approval is at most 72 hours old at the purchase. */
const APPROVAL_MAX_AGE_DAYS = 3;
/** Founder rule 5: never Cloudflare, never a backorder or catch service. */
const REFUSED_REGISTRARS: readonly string[] = ['cloudflare', 'namejet', 'snapnames', 'dropcatch'];

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDate, 'not a calendar date');
const domainName = z.string().refine((d) => { try { return normalizeDomain(d) === d; } catch { return false; } }, 'not a lowercase .com name');

// strict: a field that is not listed here (a floor, a walk-away, an approval text) is refused, because this file is public
const DomainRow = z.strictObject({
  domain: domainName,
  display_name: z.string(),
  deal_id: z.string().regex(/^D-\d{3,}$/),
  registrar: z.string().regex(/^[a-z0-9]+$/),
  expiry_date: day,
  status: z.enum(['owned', 'sold', 'dropped']),
});
const LedgerRow = z.strictObject({
  id: z.int().positive(),
  date: day,
  /** `adjustment` corrects an earlier row: rows are never edited. */
  type: z.enum(['purchase', 'renewal', 'cost', 'sale', 'adjustment']),
  domain: domainName.nullable(),
  /** Negative = money out. */
  amount_cents: z.int(),
  note: z.string().min(1).max(200),
  approval: z.strictObject({ approved_on: day, ref: z.string().min(1).max(200) }).nullable(),
});
const StateSchema = z.strictObject({ domains: z.array(DomainRow), ledger: z.array(LedgerRow) });

export type State = z.infer<typeof StateSchema>;
export type Domain = State['domains'][number];
export type LedgerEntry = State['ledger'][number];

const daysBetween = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / 86_400_000;
const repeated = (xs: string[]): string[] => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];

/** Every broken rule, in plain words. Empty = fine. */
export function problems(s: State): string[] {
  const out: string[] = [];
  const of = (domain: string, type: LedgerEntry['type']) => s.ledger.filter((r) => r.domain === domain && r.type === type);
  for (const d of repeated(s.domains.map((x) => x.domain))) out.push(`${d} is listed twice`);
  for (const d of repeated(s.domains.map((x) => x.deal_id))) out.push(`deal ${d} is used twice`);

  const held = s.domains.filter((d) => d.status === 'owned').length;
  if (held > MAX_DOMAINS) out.push(`${held} domains are owned; the cap is ${MAX_DOMAINS}`);
  for (const d of s.domains) {
    if (!isValidDisplayName(d.domain, d.display_name)) out.push(`${d.domain}: the display name must be the same name`);
    if (REFUSED_REGISTRARS.includes(d.registrar)) out.push(`${d.domain}: ${d.registrar} is never used`);
    if (of(d.domain, 'purchase').length !== 1) out.push(`${d.domain} needs exactly one purchase row`);
    if (of(d.domain, 'renewal').length > 1) out.push(`${d.domain} was renewed more than once`);
    if (of(d.domain, 'sale').length !== (d.status === 'sold' ? 1 : 0)) out.push(`${d.domain}: a sold domain has one sale row, any other has none`);
  }

  const known = new Set(s.domains.map((d) => d.domain));
  s.ledger.forEach((r, i) => {
    const at = `ledger row ${r.id}`;
    if (r.id !== i + 1) out.push(`${at}: ids run 1, 2, 3 in order`);
    if (r.domain !== null && !known.has(r.domain)) out.push(`${at}: ${r.domain} is not a listed domain`);
    if (r.domain === null && ['purchase', 'renewal', 'sale'].includes(r.type)) out.push(`${at}: a ${r.type} names its domain`);
    if (r.amount_cents === 0 || (r.type !== 'adjustment' && r.amount_cents > 0 !== (r.type === 'sale'))) out.push(`${at}: a sale is money in, a purchase, renewal or cost is money out`);
    if (['purchase', 'renewal', 'sale'].includes(r.type) && !r.approval) out.push(`${at}: a ${r.type} needs Dvir's approval`);
    if (r.type === 'purchase') {
      if (-r.amount_cents > MAX_PURCHASE_CENTS) out.push(`${at}: over the $${MAX_PURCHASE_CENTS / 100} cap for one name`);
      const age = r.approval ? daysBetween(r.approval.approved_on, r.date) : 0;
      if (age < 0 || age > APPROVAL_MAX_AGE_DAYS) out.push(`${at}: the approval must be from the ${APPROVAL_MAX_AGE_DAYS} days before the purchase`);
    }
  });
  return out;
}

/** What a newer version changed that may never change. Empty = it only adds. */
export function rewrites(before: State, after: State): string[] {
  const out: string[] = [];
  for (const [i, r] of before.ledger.entries()) {
    if (JSON.stringify(after.ledger[i]) !== JSON.stringify(r)) out.push(`ledger row ${r.id} was changed or removed (add an adjustment row instead)`);
  }
  for (const d of before.domains) {
    const now = after.domains.find((x) => x.domain === d.domain);
    if (!now) out.push(`${d.domain} was removed (set its status instead)`);
    else if (now.deal_id !== d.deal_id) out.push(`${d.domain}: the deal id was changed`);
  }
  return out;
}

export function parseState(json: string): State {
  const parsed = StateSchema.safeParse(JSON.parse(json));
  if (!parsed.success) throw new Error(`data/state.json: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const bad = problems(parsed.data);
  if (bad.length > 0) throw new Error(`data/state.json: ${bad.join('; ')}`);
  return parsed.data;
}

export const loadState = (): State => parseState(readFileSync(new URL('../data/state.json', import.meta.url), 'utf8'));
