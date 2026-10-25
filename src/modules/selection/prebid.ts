// v5.39.0 (CR-077): the automatic safety checks of a name that is ALREADY REGISTERED and about to be bid on at an auction (GoDaddy, Dynadot). Reuses the screening code:
// the name rules (SPELL-1, BRAND-1, BIGCO-1, TM_KILL: closeoutNameChecker), TYPO-1, SURBL-1, Google Web Risk (when the key is set), the RDAP status flags of the name,
// and the same name on the other endings (probeLookalike: RDAP + home page). It never checks availability, price or a registrar quote, and it writes no screening row
// (only the RDAP cache and the lookup log, as every lookup does). What cannot be automated (a business with exactly this name, the archive history) is reported as manual.
// The route, the stored answer and the bid plan are in the ops module (`ops/api/auctions.ts`).
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { normalizeDomain } from '../../domain-name.js';
import { currentLists } from './lists.js';
import { closeoutNameChecker } from './closeout-name.js';
import { companiesCheck } from './checks/companies.js';
import { probeLookalike } from './checks/lookalikes.js';
import { surblCheck } from './checks/surbl.js';
import { typoCheck } from './checks/typo.js';
import { sharedPacer, sharedRobots } from './sellers.js';
import { activeSelectionSettings } from './settings.js';
import type { CheckContext, CheckOutcome, ScreeningDeps } from './types.js';
import { webRiskLookup } from './web-risk.js';

export const PREBID_ENDINGS = ['net', 'org', 'co', 'io', 'ai'] as const;
export type PrebidEnding = (typeof PREBID_ENDINGS)[number];
export type PrebidResult = 'PASS' | 'FLAG' | 'FAIL' | 'SKIP';
export interface PrebidCheck { id: string; result: PrebidResult; reason: string | null; evidence: Record<string, unknown> }
export interface EndingState { registered: boolean | null; in_use: boolean | null; reason_code: string | null }
export interface PrebidOutput { checks: PrebidCheck[]; endings: Record<PrebidEnding, EndingState> }

/** RDAP status values that mean a name is held or on its way out of the registry; each one is a FLAG for a human to read, never a silent pass. */
const RDAP_FLAG_STATUSES: readonly [string, RegExp][] = [
  ['clientHold', /^clienthold$/], ['serverHold', /^serverhold$/], ['redemptionPeriod', /^redemptionperiod$/], ['pendingDelete', /^pendingdelete$/],
];
const squash = (s: string): string => s.replace(/[^a-zA-Z]/g, '').toLowerCase();

async function currentTerms(db: Kysely<Database>, table: 'tm_kills' | 'bigco_names'): Promise<string[]> {
  const col = table === 'tm_kills' ? 'term' : 'name';
  const rows = await (db.selectFrom(table as 'tm_kills') as never as { select(c: string[]): { execute(): Promise<Record<string, unknown>[]> } }).select(['id', col, 'supersedes']).execute();
  const replaced = new Set(rows.map((r) => r.supersedes).filter((x) => x !== null).map(Number));
  return rows.filter((r) => !replaced.has(Number(r.id))).map((r) => String(r[col]));
}

/** An automatic result as a pre-bid check: UNKNOWN is never clean (FLAG) unless the source is switched off by design (SKIP). */
function fromOutcome(id: string, o: CheckOutcome): PrebidCheck {
  const evidence = { status: o.status, reason_code: o.reasonCode, ...o.fields };
  if (o.status === 'PASS' || o.status === 'PASS_WITH_NOTE') return { id, result: 'PASS', reason: o.reason, evidence };
  if (o.status === 'FAIL') return { id, result: 'FAIL', reason: o.reason ?? o.reasonCode, evidence };
  if (o.status === 'FLAG') return { id, result: 'FLAG', reason: o.reason ?? o.reasonCode, evidence };
  if (o.status === 'UNKNOWN' && o.reasonCode === 'SOURCE_DISABLED') return { id, result: 'SKIP', reason: o.reason, evidence };
  return { id, result: 'FLAG', reason: `could not be checked (${o.reasonCode ?? o.status}): ${o.reason ?? 'no answer'}`, evidence };
}

export function verdictOf(checks: readonly PrebidCheck[]): 'pass' | 'flag' | 'fail' {
  if (checks.some((c) => c.result === 'FAIL')) return 'fail';
  if (checks.some((c) => c.result === 'FLAG')) return 'flag';
  return 'pass';
}

/** Runs the automatic pre-bid checks for one registered .com name. Never throws for an upstream failure: that check is a FLAG with the reason. */
export async function runPrebidChecks(db: Kysely<Database>, deps: ScreeningDeps, rawDomain: string, now: () => number, budgetMs = 90_000): Promise<PrebidOutput> {
  const domain = normalizeDomain(rawDomain);
  const sld = domain.replace(/\.com$/, '');
  const values = (await activeSelectionSettings(db)).values;
  const lists = await currentLists(db, ['sig_parked', 'sig_forsale']);
  const shared = new Map<string, unknown>([['surbl_no_evidence', true]]);
  const ctx = {
    db, run: { id: 'prebid', mode: 'live', backtest: false, buyHold: false, trancheId: null, createdAt: new Date(now()) },
    item: { idx: 0, domain, lane: 'S7', leads_ab: 0 }, settings: values, settingsLabel: 'prebid',
    latest: () => undefined, ahead: () => [], lists, lexicon: { types: new Map(), versions: {} }, deps, now, deadline: now() + budgetMs, shared,
  } as unknown as CheckContext;
  const checks: PrebidCheck[] = [];

  // 1. name rules: the first failing rule is reported, the later ones are not evaluated
  const names = await closeoutNameChecker(db, { bigcoNames: await currentTerms(db, 'bigco_names'), tmKills: await currentTerms(db, 'tm_kills') });
  const nv = names.check(domain);
  const order = ['SPELL-1', 'BRAND-1', 'BIGCO-1', 'TM_KILL'] as const;
  const what: Record<(typeof order)[number], string> = {
    'SPELL-1': 'the name does not pass the spelling and form rule (digit, hyphen, no recognisable words, too long)',
    'BRAND-1': 'the name contains a brand on the brand list',
    'BIGCO-1': 'the name is or contains a big company name',
    'TM_KILL': 'the name contains a trademark kill term',
  };
  let failed = false;
  for (const id of order) {
    if (failed) checks.push({ id, result: 'SKIP', reason: 'not evaluated: an earlier name rule already failed', evidence: {} });
    else if (nv.code === id) { failed = true; checks.push({ id, result: 'FAIL', reason: what[id], evidence: { words: nv.words, settings: names.settings } }); }
    else checks.push({ id, result: 'PASS', reason: null, evidence: { words: nv.words, settings: names.settings } });
  }

  // 2. typo, SURBL, Web Risk
  checks.push(fromOutcome('TYPO-1', await typoCheck.run(ctx)));
  checks.push(fromOutcome('SURBL-1', await surblCheck.run(ctx)));
  if (deps.webRiskApiKey) {
    const w = await webRiskLookup({ db, fetch: deps.fetch, apiKey: deps.webRiskApiKey, now }, domain);
    if (w.kind === 'match') checks.push({ id: 'WEB-RISK-1', result: 'FAIL', reason: `Google Web Risk lists ${domain}: ${w.threatTypes.join(', ')}`, evidence: { threat_types: w.threatTypes, expire_time: w.expireTime } });
    else if (w.kind === 'clean') checks.push({ id: 'WEB-RISK-1', result: 'PASS', reason: null, evidence: { threat_types: [] } });
    else checks.push({ id: 'WEB-RISK-1', result: 'FLAG', reason: `Web Risk could not be read (${w.reason})`, evidence: { reason_code: w.reason } });
  } else checks.push({ id: 'WEB-RISK-1', result: 'SKIP', reason: 'no Google Web Risk key is configured', evidence: {} });

  // 3. RDAP status of the name itself
  const r = await deps.rdapLookup(domain);
  if (r.outcome === 'registered' && r.facts) {
    const hit = RDAP_FLAG_STATUSES.filter(([, re]) => r.facts!.statuses.some((s) => re.test(squash(s)))).map(([n]) => n);
    const ev = { registered: true, registrar: r.facts.registrar, created_at: r.facts.created_at, expires_at: r.facts.expires_at, statuses: r.facts.statuses, flagged_statuses: hit };
    checks.push(hit.length > 0
      ? { id: 'RDAP_STATUS', result: 'FLAG', reason: `registry status ${hit.join(', ')}: read what it means for this auction before bidding`, evidence: ev }
      : { id: 'RDAP_STATUS', result: 'PASS', reason: null, evidence: ev });
  } else if (r.outcome === 'not_registered') {
    checks.push({ id: 'RDAP_STATUS', result: 'FLAG', reason: 'the registry says the name is not registered: an auction name should be registered', evidence: { registered: false } });
  } else checks.push({ id: 'RDAP_STATUS', result: 'FLAG', reason: `RDAP could not be read (${r.reasonCode ?? 'SOURCE_ERROR'})`, evidence: { registered: null, reason_code: r.reasonCode } });

  // 4. the same name on the other endings (RDAP + home page, the lookalike probe)
  const endings = {} as Record<PrebidEnding, EndingState>;
  const l = lists.sig_parked && lists.sig_forsale ? { parked: lists.sig_parked.terms, forsale: lists.sig_forsale.terms } : null;
  const maxAgeHours = values.freshness_hours.lookalikes ?? values.freshness_hours.ext_dates ?? 0;
  const pace = sharedPacer(ctx);
  const robots = sharedRobots(ctx);
  for (const tld of PREBID_ENDINGS) {
    const p = await probeLookalike(ctx, { domain: `${sld}.${tld}`, kind: 'ending' }, { maxAgeHours, lists: l, pace, robots });
    endings[tld] = { registered: p.item.registered, in_use: p.item.in_use, reason_code: p.item.reason_code };
  }
  const inUse = PREBID_ENDINGS.filter((t) => endings[t].in_use === true);
  const unknown = PREBID_ENDINGS.filter((t) => endings[t].registered === null);
  const same = { endings, in_use: inUse, unknown };
  if (inUse.length > 0) checks.push({ id: 'SAME_NAME_ENDINGS', result: 'FLAG', reason: `the same name is in use on ${inUse.map((t) => `.${t}`).join(', ')}: either demand proof or a collision, read the sites`, evidence: same });
  else if (unknown.length === PREBID_ENDINGS.length) checks.push({ id: 'SAME_NAME_ENDINGS', result: 'FLAG', reason: 'no other ending could be checked', evidence: same });
  else checks.push({ id: 'SAME_NAME_ENDINGS', result: 'PASS', reason: null, evidence: same });

  // 5. UK company names (informs; a match is a FLAG)
  const c = await companiesCheck.run(ctx);
  const comp = fromOutcome('UK_COMPANY', c);
  const n = (c.fields as { companies?: { uk_matches_n?: number | null } }).companies?.uk_matches_n;
  checks.push(c.status === 'PASS' && typeof n === 'number' && n > 0 ? { ...comp, result: 'FLAG', reason: `${n} UK compan${n === 1 ? 'y' : 'ies'} with all the words of this name in the title` } : comp);

  return { checks, endings };
}
