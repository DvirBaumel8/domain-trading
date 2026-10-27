// v3.3.0 (CR-023 F): GET /openapi.json, an OpenAPI 3.1 description of every route. The routes come from Fastify itself (an onRoute hook that is
// installed before any route is registered), so the document can never list a route that does not exist or miss one that does. A route may carry
// `config: { openapiBody: <zod schema> }`; the request body's JSON schema is then made from that schema (z.toJSONSchema).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DATA_ROUTES, DATA_PREFIX, INTAKE_ROUTES, JOB_PATH, PUBLIC_PATHS, VISITS_HIT_ROUTE } from './auth.js';
import { isMutating } from './methods.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** The zod schema of the JSON request body, for GET /openapi.json. */
    openapiBody?: z.ZodType;
    /** v3.4.0 (CR-024 F-2): the route takes no request body (the document says `x-no-body: true`). */
    openapiNoBody?: boolean;
    /** v3.4.0 (CR-024 F-3): the success status the route answers, when it is not 200. */
    openapiStatus?: 200 | 201 | 202;
  }
}

const OPENAPI_PATH = '/openapi.json';

interface Entry { method: string; url: string; body?: z.ZodType; noBody?: boolean; status?: number }

/** One line per route: what it does. Keyed `METHOD /fastify/path`. A route with no line here fails the test that keeps the document complete. */
const SUMMARIES: Record<string, string> = {
  'GET /health/ping': 'Liveness (public, no database)',
  'GET /health': 'Service health: version, database, jobs',
  'GET /check': 'Price and availability check of a name across registrars',
  'POST /portfolio/import': 'Import an S8 (Line 2) aftermarket name Dvir bought on a registrar website (needs approval_ref; price cap and S8 slots); dry_run supported',
  'POST /buy': 'Buy a name (needs Dvir\'s approval_ref and a complete screening pack); dry_run supported',
  'GET /pricing/preview': 'Preview the sell plan of a price',
  'POST /list/{domain}': 'List an owned name (mode, price, lander)',
  'POST /listings/{domain}/venue': 'Record a listing made by hand on Afternic or Sedo (or its removal), as shown there',
  'GET /export/afternic.csv': 'Afternic full-file export',
  'GET /export/sedo.csv': 'Sedo full-file export',
  'POST /listings/{domain}/observed': 'Log a venue listing seen on a public page (observed_public: venue, price_usd, url, seen_at; dry_run supported). Never changes the listing, price, export or listed_venues; a provenance key is 422',
  'POST /portfolio/{domain}/display-name': 'Set the capitalised name used in the marketplace files (same letters only, else 422 DISPLAY_NAME_MISMATCH); takes effect in the next export',
  'POST /export/afternic/push': 'Update Afternic to the plan through its API',
  'POST /export/{venue}/uploaded': 'Confirm a marketplace file was uploaded',
  'POST /offers': 'Log an offer',
  'POST /offers/{id}/outcome': 'Record the outcome of an offer',
  'GET /offers': 'List logged offers',
  'GET /report/offers': 'Offer statistics report',
  'POST /sold/{domain}': 'Record a sale (with evidence)',
  'GET /report': 'Spend, sales, ROI, dates and warnings',
  'GET /report/pricing-review': 'Pricing review report',
  'GET /portfolio': 'The domains in the portfolio',
  'GET /portfolio/{domain}': 'One domain with its plan and history',
  'GET /portfolio/outcomes': 'One row per bought name from idea to outcome: lane, card, views, leads, offers, sale or drop, days held',
  'GET /portfolio/outcomes/monthly': 'The month: names with interest against none by card feature, passed against borderline, venue against venue',
  'GET /portfolio/outcomes/quarterly': 'Renewal cost against sales per quarter',
  'POST /portfolio/{domain}/renewal-price': 'Record a renewal price with its source and date (not a money action; WRITE or bots)',
  'POST /tokens/bots/rotate': 'Rotate the shared bots token: a new value is returned once, the old one works 10 more minutes (WRITE or bots)',
  'POST /portfolio/{domain}/horizon': 'Set a name to evergreen, trend or regulation (Dvir\'s approval_ref); trend and regulation drop at the first expiry',
  'POST /portfolio/{domain}/stats': 'Log a month of views, leads, inquiries and offers for a name and venue (append-only)',
  'POST /outreach/emails': 'Log an email sent about a name (recipient company domain only); the 6th for one name is refused',
  'GET /outreach/emails/summary': 'Replies and sales per 100 emails, per name',
  'POST /patterns/sales': 'Upload recent sales as CSV (domain, price_usd, date, venue)',
  'GET /patterns/latest': 'Clusters of the latest sales upload by word count, structure, length band and topic tokens',
  'POST /lessons': 'Store scout lessons (one or up to 200); a lesson on the same sector, rule and name merges into the existing one',
  'GET /lessons': 'Scout lessons, newest first (filters: sector, since, rule, q, limit)',
  'GET /lessons/check': 'Scout lessons naming one domain',
  'GET /lessons/report': 'Monthly lessons report per sector: top rules, examples, recurring rules (JSON or format=md)',
  'PATCH /lessons/{id}': 'Edit a lesson: recheck_if, superseded_by or lesson text',
  'POST /data/rdap': 'Load RDAP answers (candidate pool only); WRITE or data token, dry_run supported, counts accepted, duplicate, rejected',
  'GET /data/rdap': 'Read RDAP answers (candidate pool only) (filters host, since, limit)',
  'POST /data/live-checks': 'Load live and Common Crawl checks; WRITE or data token, dry_run supported, counts accepted, duplicate, rejected',
  'GET /data/live-checks': 'Read live and Common Crawl checks (filters host, since, limit)',
  'POST /data/tm-kills': 'Load trademark kill terms (append-only); WRITE or data token, dry_run supported, counts accepted, duplicate, rejected',
  'GET /data/tm-kills': 'Read trademark kill terms (append-only) (filters host, since, limit)',
  'POST /data/bigco-names': 'Load big-company names (append-only); WRITE or data token, dry_run supported, counts accepted, duplicate, rejected',
  'GET /data/bigco-names': 'Read big-company names (append-only) (filters host, since, limit)',
  'POST /data/sales': 'Report sales (add-only): name, venue, sale_price_cents, sale_date, source, tier (A-D); bots, WRITE or data token, dry_run supported; a changed price for a stored row is 409 APPEND_ONLY, a NameBio source or a missing tier is 422',
  'PUT /data/sales': 'Not allowed: sale reports are add-only (405 APPEND_ONLY)',
  'PATCH /data/sales': 'Not allowed: sale reports are add-only (405 APPEND_ONLY)',
  'DELETE /data/sales': 'Not allowed: sale reports are add-only (405 APPEND_ONLY)',
  'PUT /data/sales/{id}': 'Not allowed: sale reports are add-only (405 APPEND_ONLY)',
  'PATCH /data/sales/{id}': 'Not allowed: sale reports are add-only (405 APPEND_ONLY)',
  'DELETE /data/sales/{id}': 'Not allowed: sale reports are add-only (405 APPEND_ONLY)',
  'POST /pickproof/{date}/picks': 'Pick-proof: the Buyer submits its picks (arm A) for pick day D from the frozen pool, before the deadline (16:00 UTC of D); replaces the earlier list until sealed (409 PICKPROOF_SEALED after; 422 NOT_IN_POOL)',
  'GET /pickproof/{date}/manifest': 'Pick-proof seal of day D: pool sha256, seed, k, each arm count and sha256, recipe hashes; the first call at or after the deadline seals the day',
  'GET /pickproof/{date}/pool': 'Frozen pick-proof pool rows of a day, to check pool_sha256 (410 PICKPROOF_POOL_PRUNED after 45 days)',
  'GET /pickproof/{date}/arms': 'Pick-proof arm names (A, B1, B2, C1) of a sealed day (409 PICKPROOF_NOT_SEALED before the seal); ?arm= for one arm',
  'GET /pickproof/report': 'Pick-proof report (proxy, not profit): per arm n, events, rate, unknown_n; A vs C1 (primary), B1, B2 with Fisher or permutation, CMH by price band, Holm; UNPOWERED under 10 events',
  'GET /market/episodes': 'Market episodes (name x venue x listing episode) with outcome labels; summary counts first, then rows (filters outcome, rule, band, from, to, venue, limit)',
  'POST /auctions/prebid': 'Pre-bid safety check of a registered .com (name rules, typo, SURBL, Web Risk, RDAP status, other endings, UK companies); stores the answer and returns prebid_id, verdict, checks and the manual items',
  'POST /auctions/plans': "Record Dvir's approved maximum bid for one name (approval names the domain and the amount; needs a recent pre-bid that did not fail; closeouts paused); WRITE only",
  'POST /auctions/plans/{id}/result': 'Record the real outcome of a bid plan: won (with the final price, never above the maximum bid), lost or withdrawn; WRITE only',
  'GET /auctions/plans': 'Bid plans, newest first; filters status (open, won, lost, withdrawn, expired), domain, limit',
  'GET /auctions/plans/{id}': 'One bid plan with its event history',
  'POST /replay/runs': 'Queue a replay of an archived day (CR-081): the current logic on that day\'s saved list against N seeded random names, outcomes read from later data; 202 {id}; dry_run answers the report at once and stores nothing; WRITE only',
  'GET /replay/{date}': 'The newest finished replay report of an archived day (CR-081; the one bots use): query kind (auctions|closeouts), n, seed (default derived from the archive file); 404 REPLAY_NOT_RUN; writes nothing',
  'GET /replay/runs/{id}': 'One replay run with its status and, when done, the report (per-group counts and rates, paired bootstrap, the names that did well)',
  'GET /replay/runs': 'Replay runs, newest first (status and logic version; the report is in GET /replay/runs/{id}); filters limit, status',
  'GET /auctions/shortlist': 'The daily shortlist of the best live GoDaddy auctions in our range (v5.45.0): rank, score and parts, price, bids, end time, suggested maximum bid, automatic pre-bid (id, verdict, flags), reasons; filters date, limit',
  'GET /auctions/funnel': 'The auction funnel counted over a date range (default the last 7 days): auctions seen, shortlisted, pre-bid, bid plans, won, imported, listed, traffic, sold',
  'GET /auctions/live': 'GoDaddy auctions inside the buying range (price up to the S8 cap, with bids) from the latest daily save, with the stored band; filters date, max_price, min_bids, ends_within_hours, type, sort, limit, offset, include_ended',
  'GET /market/matched': 'Matched sold-vs-unsold set for (asof, ratio, seed): frozen and sealed with a sha256 on the first call',
  'GET /market/dq': 'Latest market data-quality checks (duplicates, survivorship, leakage, price sanity, coverage, tier)',
  'GET /market/coverage': 'Market data coverage: rows per source per day, counts per label and band, progress against the 1,000 / 2,000 targets, row counts',
  'POST /kb/sources': 'Add sources to the knowledge base (CR-078): url (canonicalised), type, reliability A-F with a reason, excerpt up to 300 characters; 1 to 1,000 rows, all-or-nothing (422 KB_ROWS_REJECTED lists the bad rows), idempotent on the canonical URL, "supersede": true appends a correction; bots, WRITE or data token',
  'POST /kb/authors': 'Add authors to the knowledge base (CR-078): name, grade A-F with a reason; 1 to 1,000 rows, all-or-nothing, idempotent on the name; bots, WRITE or data token',
  'POST /kb/claims': 'Add normalised claims (CR-078): topic, variable, population, direction, optional question slugs and option; the claim_key is topic|variable|population lowercased; 1 to 1,000 rows, all-or-nothing, idempotent',
  'POST /kb/evidence': 'Link sources to claims (CR-078): source URL, claim_key or claim triplet, stance, credibility 1-5, evidence_kind, quote up to 15 words; 1 to 1,000 rows, all-or-nothing, idempotent on source, claim and locator',
  'POST /kb/links': 'Link sources that are not independent (CR-078): echo_of, syndicated, same_author (with a note), aggregator_of or cites; 1 to 1,000 rows, all-or-nothing, idempotent',
  'POST /kb/questions': 'Open decision questions with their options (CR-078): slug, text, options; 1 to 1,000 rows, all-or-nothing, idempotent on the slug',
  'GET /kb/questions': 'List the knowledge base questions with the certainty of their latest stored verdict (limit, offset)',
  'GET /kb/questions/{id}/verdict': 'Compute the verdict of a question now (by id or slug): leading option, certainty (high, moderate, low, very_low), the reasons for each step down in plain words, the top independence clusters with source URLs and grades; appends a kb_verdicts row only when it differs from the latest stored one',
  'GET /kb/claims': 'List the current claims (filters topic, question, limit, offset)',
  'GET /kb/sources': 'List the current sources (filters status lead, read, graded or rejected; topic; limit, offset)',
  'POST /decisions': 'Record company decisions (D-ids): id, decided_at, decided_by, summary, scope, domains, source_ref, supersedes; same id and content is a duplicate, other content is 409 DECISION_EXISTS; a record only, no action',
  'GET /decisions': 'Company decisions, newest first (filters q, scope, domain, since, limit, offset), with total_n',
  'GET /decisions/{id}': 'One company decision by its D-id, with supersedes and superseded_by',
  'GET /kb/recheck': 'Claims whose age weight (mean R of their evidence) has fallen below the re-check threshold',
  'GET /kb/echo-candidates': 'Source pairs with similar excerpts (MinHash estimate at or above 0.5) that no link joins yet, for a session to confirm with POST /kb/links',
  'POST /data/sales-comps': 'Load graded comparable sales; WRITE or data token, dry_run supported, counts accepted, duplicate, rejected',
  'GET /data/sales-comps': 'Read graded comparable sales (filters host, since, limit)',
  'POST /engine/sales': 'Upload sold names for the scoring engine (1 to 20,000 rows; counts accepted, duplicate, rejected with reasons)',
  'POST /engine/unsold': 'Upload unsold names (dropped after held, registered unsold) for the scoring engine',
  'GET /engine/rows': 'The stored engine labels (sales, unsold, auction ends) in id order, paged by after_id',
  'GET /engine/lift': 'The current lift table of the auction shortlist: patterns, bins, lifts, counts and the AUC on a seeded holdout',
  'GET /engine/health': 'Scoring engine data counts, age, last uploads, the endings fill progress and the active model',
  'GET /owned/{domain}/endings': 'Current state and event history of the other endings (.net .co .org .io .ai) of an owned name',
  'GET /engine/holdout-date': 'Deprecated since 5.41.0, no effect: the stored holdout date (rows are never rejected for their date)',
  'POST /engine/holdout-date': 'Deprecated since 5.41.0, no effect: move the stored holdout date (WRITE only; the approval_ref text must name the date)',
  'POST /engine/train': 'Start a scoring-engine training run on the job queue (at most one a day)',
  'GET /engine/train/{id}': 'A training run: status, metrics, frozen test-file hash',
  'POST /score': 'Score .com names with the active model (READ scope; the one read-only POST)',
  'GET /ledger': 'The ledger (JSON or CSV)',
  'POST /ledger/costs': 'Append non-money cost rows (type tool, ai or adjustment, signed amount_usd; bots or WRITE); dry_run answers 200 with counts and stores nothing; corrections are reversing rows',
  'PUT /portfolio/{domain}/forward-costs': 'Replace the planned forward-cost lines of a name as a set (old plans stay as history); a derived field (floor, walkaway, renewal_due, ...) is 422 DERIVED_FIELD',
  'GET /portfolio/{domain}/forward-costs': 'The current forward-cost plan of a name and every earlier version (history, newest first)',
  'GET /costs/forward': 'Planned forward costs plus committed renewals per month and in total (from, to = YYYY-MM); an unknown renewal price is null with RENEWAL_PRICE_UNKNOWN and incomplete: true',
  'GET /books.csv': 'Private books CSV, one row per live name, values equal to GET /portfolio (includes the walk-away; READ or bots token only)',
  'GET /deals/{id}': 'One deal',
  'GET /audit': 'The audit log',
  'GET /selection/settings': 'Selection settings: active and drafts',
  'POST /selection/settings': 'Draft a selection settings version',
  'POST /selection/settings/{label}/activate': 'Activate a settings draft (needs Dvir\'s approval_ref)',
  'GET /selection/lists/{name}': 'A frozen selection list',
  'POST /selection/lists/{name}': 'Freeze a selection list version',
  'POST /demand/keywords': 'Upload the monthly Keyword Planner export (base64 CSV) as keyword demand',
  'GET /demand/keywords': 'The latest stored demand of a keyword',
  'POST /selection/sibling-scan': 'Scan the same words on other endings (CR-050), store the result',
  'GET /selection/sibling-scan/{domain}': 'The newest stored sibling scan of a name',
  'GET /selection/sibling-methods/{method}': 'A sibling method and its approval',
  'POST /selection/sibling-methods/{method}/approve': 'Approve a sibling method (needs Dvir\'s approval_ref)',
  'GET /selection/test-sets/{name}': 'A test set',
  'POST /selection/test-sets': 'Create a test set',
  'POST /selection/test-sets/{name}/seal': 'Seal a test set',
  'POST /selection/test-sets/{name}/cancel': 'Cancel a test set',
  'GET /selection/drop-lists': 'Uploaded drop lists',
  'GET /selection/drop-lists/{name}': 'One drop list',
  'POST /selection/drop-lists': 'Upload a drop list',
  'GET /selection/cohorts/{name}': 'A cohort',
  'GET /selection/cohorts/report': 'Cohort outcomes report',
  'POST /selection/cohorts': 'Create a cohort',
  'POST /selection/evaluate': 'Evaluate a name against the selection rules',
  'POST /selection/labelled-names': 'Upload labelled names',
  'POST /selection/replays': 'Replay labelled names under a settings version',
  'GET /selection/replays/{id}': 'One replay',
  'GET /selection/buy-hold': 'The buy hold and the steps to lift it',
  'GET /selection/holdout-suites': 'Holdout suites',
  'POST /selection/holdout-suites': 'Create a holdout suite',
  'GET /selection/namebio': 'NameBio reference status',
  'POST /screening/runs': 'Start a screening run',
  'POST /screening/runs/{id}/cancel': 'Cancel a screening run',
  'POST /screening/runs/{id}/manual': 'Record a manual check result for a run',
  'POST /screening/runs/{id}/verdicts': 'Record a verdict for a run',
  'GET /screening/runs/{id}': 'One screening run with its results',
  'GET /screening/runs/{id}/report.csv': 'One row per name of a screening run, as CSV (verdict, EV, ratio, lookalikes, topic, sellers, comps)',
  'GET /screening/evidence/{id}': 'One piece of screening evidence',
  'POST /quotes/manual': 'Record a manual registrar quote',
  'GET /screening/packs': 'Screening packs',
  'POST /screening/packs': 'Create a screening pack',
  'GET /screening/packs/{id}': 'One screening pack',
  'POST /tranches': 'Open a tranche',
  'GET /tranches': 'Tranches',
  'POST /tranches/{id}/members': 'Add members to a tranche',
  'POST /tranches/{id}/close': 'Close a tranche',
  'POST /candidates/intake': 'A scout sends names for screening',
  'POST /candidates/screen': 'Screen the waiting intake names now (own daily allowance), then rebuild the list',
  'GET /candidates/daily': 'The day\'s candidate list',
  'GET /candidates/closeouts': 'Ranked closeout and drop-list candidates of a day: eight hard filters with counts, scored offline by the datasave step scorePool; read-only, 409 SNAPSHOT_MISSING without a sealed snapshot',
  'POST /candidates/daily/rebuild': 'Rebuild today\'s candidate list',
  'POST /candidates/{domain}/records': 'Record a manual check (tm_us, history, sellers) for a name',
  'GET /candidates/{domain}/records': 'The records of a name',
  'POST /jobs/run': 'Queue a tick, daily or datasave run',
  'GET /rdap/{domain}': 'RDAP facts of a .com from the shared cache (24 h TTL) or live; ?fresh=true forces a live lookup; 429 LOOKUP_LIMIT when the rolling 24 h limit is used up',
  'POST /rdap/batch': 'RDAP rows for 1..500 .com names, cached first, live within the rolling limit; read-only POST (READ scope, no Idempotency-Key); limit_hit with LOOKUP_LIMIT rows',
  'GET /lookups/usage': 'Live RDAP lookups used in the rolling 24 hours, the limit and when the next slot frees',
  'GET /snapshots': 'The daily data saves: manifests (sha256, size, Last-Modified, status, raw_available) and parsed row counts',
  'POST /snapshots/dynadot': 'Upload Dynadot rows a bot pulled (aftermarket, closed_auctions, closeouts); bots or WRITE, dry_run supported; the part with final true seals the day (409 SNAPSHOT_SEALED after)',
  'GET /snapshots/missing': 'Days with no complete save of every configured inventory file',
  'GET /jobs/runs': 'Job runs (queued, running, finished)',
  'POST /jobs/preview': 'Dry run of the price and drop jobs for a day',
  'POST /company/document': 'Save a new version of the company document',
  'GET /company/document/versions': 'Versions of the company document',
  'GET /company/document/versions/{n}': 'One version of the company document',
  'GET /company/forbidden-terms': 'Forbidden terms',
  'POST /company/forbidden-terms': 'Add a forbidden term',
  'POST /company/forbidden-terms/{id}/retire': 'Retire a forbidden term',
  'POST /visits/hit': 'Count one visit (visits token only; sent by the api-proxy counting redirect)',
  'POST /visits/import': 'Load Afternic 30-day Views/Leads for a name (WRITE or data)',
  'POST /visits/settings': 'Switch the visitor counter on or off, or request the visit-counter token (WRITE; the approval_ref must name "visits")',
  'POST /visits/forward/{domain}': 'Point the Porkbun URL forward of a listed name at the counting redirect, or revert it (WRITE; approval_ref names the domain and "visits")',
  'GET /visits': 'Daily visitor counts',
  'GET /visits/weekly': 'Weekly visitor counts per name (Sunday to Saturday, UTC) and the names that cannot be counted',
  [`GET ${OPENAPI_PATH}`]: 'This document',
};

const toOpenApiPath = (url: string): string => url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
const paramsOf = (path: string): string[] => [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);

function scopeOf(method: string, url: string): string {
  if (PUBLIC_PATHS.has(url)) return 'none';
  if (url === JOB_PATH && method === 'POST') return 'write or job-trigger token';
  if (method === 'POST' && url === VISITS_HIT_ROUTE) return 'visits';
  if (method === 'POST' && INTAKE_ROUTES.has(url)) return DATA_ROUTES.has(url) ? 'write or intake or data' : 'write or intake';
  if (method === 'POST' && (DATA_ROUTES.has(url) || url.startsWith(DATA_PREFIX))) return 'write or data';
  if (method === 'POST' && (url === '/tokens/bots/rotate' || /^\/portfolio\/[^/]+\/renewal-price$/.test(url))) return 'write or bots';
  return isMutating(method, url) ? 'write' : 'read';
}

/** Installs the route collector. Call it BEFORE any route is registered. */
export function collectOpenApiRoutes(app: FastifyInstance): Entry[] {
  const entries: Entry[] = [];
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      entries.push({ method, url: r.url, ...(r.config?.openapiBody && { body: r.config.openapiBody }), ...(r.config?.openapiNoBody && { noBody: true }), ...(r.config?.openapiStatus && { status: r.config.openapiStatus }) });
    }
  });
  return entries;
}

function buildOpenApi(entries: Entry[], version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const e of [...entries].sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method))) {
    const path = toOpenApiPath(e.url);
    const scope = scopeOf(e.method, e.url);
    const op: Record<string, unknown> = {
      summary: SUMMARIES[`${e.method} ${path}`] ?? `${e.method} ${path}`,
      'x-scope': scope,
      ...(scope === 'none' ? { security: [] } : { security: [{ bearer: [] }] }),
      ...(paramsOf(path).length ? { parameters: paramsOf(path).map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })) } : {}),
      ...(isMutating(e.method, e.url) ? { 'x-idempotency-key': 'required' } : {}),
      ...(e.noBody ? { 'x-no-body': true } : {}),
      responses: { [String(e.status ?? 200)]: { description: 'OK' } },
    };
    if (e.body) {
      try {
        op.requestBody = { required: false, content: { 'application/json': { schema: z.toJSONSchema(e.body, { unrepresentable: 'any', io: 'input' }) } } };
      } catch {
        // a schema that cannot be written as JSON schema is left out
      }
    }
    (paths[path] ??= {})[e.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Domain trading service', version, description: 'The contract is docs/contract/. Every POST needs an Idempotency-Key. Bodies are strict: an unknown field is 422 VALIDATION_ERROR.' },
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    paths,
  };
}

/** GET /openapi.json (READ). The route table is read when the request comes, so it holds every route registered by then (itself included since 3.4.0). */
export function registerOpenApi(app: FastifyInstance, entries: Entry[], version: string): void {
  app.get(OPENAPI_PATH, async () => buildOpenApi(entries, version));
}
