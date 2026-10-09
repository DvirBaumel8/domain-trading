// v3.3.0 (CR-023 F): GET /openapi.json, an OpenAPI 3.1 description of every route. The routes come from Fastify itself (an onRoute hook that is
// installed before any route is registered), so the document can never list a route that does not exist or miss one that does. A route may carry
// `config: { openapiBody: <zod schema> }`; the request body's JSON schema is then made from that schema (z.toJSONSchema).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { INTAKE_ROUTES, JOB_PATH, MEDIA_PATH, PUBLIC_PATHS } from './auth.js';
import { isMutating } from './methods.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** The zod schema of the JSON request body, for GET /openapi.json. */
    openapiBody?: z.ZodType;
  }
}

export const OPENAPI_PATH = '/openapi.json';

interface Entry { method: string; url: string; body?: z.ZodType }

/** One line per route: what it does. Keyed `METHOD /fastify/path`. A route with no line here fails the test that keeps the document complete. */
export const SUMMARIES: Record<string, string> = {
  'GET /health/ping': 'Liveness (public, no database)',
  'GET /health': 'Service health: version, database, jobs, posting',
  'GET /check': 'Price and availability check of a name across registrars',
  'POST /buy': 'Buy a name (needs Dvir\'s approval_ref and a complete screening pack); dry_run supported',
  'GET /pricing/preview': 'Preview the sell plan of a price',
  'POST /list/{domain}': 'List an owned name (mode, price, lander)',
  'GET /export/afternic.csv': 'Afternic full-file export',
  'GET /export/sedo.csv': 'Sedo full-file export',
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
  'GET /ledger': 'The ledger (JSON or CSV)',
  'GET /deals/{id}': 'One deal',
  'GET /audit': 'The audit log',
  'GET /selection/settings': 'Selection settings: active and drafts',
  'POST /selection/settings': 'Draft a selection settings version',
  'POST /selection/settings/{label}/activate': 'Activate a settings draft (needs Dvir\'s approval_ref)',
  'GET /selection/lists/{name}': 'A frozen selection list',
  'POST /selection/lists/{name}': 'Freeze a selection list version',
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
  'POST /candidates/daily/rebuild': 'Rebuild today\'s candidate list',
  'POST /candidates/{domain}/records': 'Record a manual check (tm_us, history, sellers) for a name',
  'GET /candidates/{domain}/records': 'The records of a name',
  'POST /jobs/run': 'Queue a tick or daily run',
  'GET /jobs/runs': 'Job runs (queued, running, finished)',
  'POST /jobs/preview': 'Dry run of the price and drop jobs for a day',
  'POST /company/document': 'Save a new version of the company document',
  'GET /company/document/versions': 'Versions of the company document',
  'GET /company/document/versions/{n}': 'One version of the company document',
  'GET /company/forbidden-terms': 'Forbidden terms',
  'POST /company/forbidden-terms': 'Add a forbidden term',
  'POST /company/forbidden-terms/{id}/retire': 'Retire a forbidden term',
  'POST /reviews/packet': 'Build a review packet',
  'POST /reviews/run': 'Run the outside review',
  'GET /reviews/packets/{id}': 'One review packet',
  'GET /reviews/items': 'Review items',
  'POST /reviews/items/{id}/status': 'Set the status of a review item',
  'POST /reviews/{packet_id}/feedback': 'Record review feedback',
  'GET /reviews/cost': 'Review cost this month',
  'GET /reviews/settings': 'Review settings',
  'POST /reviews/settings': 'Change review settings',
  'GET /reviews/settings/history': 'Review settings history',
  'POST /posts': 'Publish a post to the company X account through Buffer',
  'GET /posts': 'Posts and today\'s allowance',
  'POST /posts/schema-check': 'Check the Buffer input for a post body (or the fixed sample) against Buffer\'s live schema; publishes nothing',
  'GET /posts/{id}/images/{part}/{position}': 'The stored bytes of a post image',
  'POST /posts/{id}/remove': 'Mark a post removed',
  'POST /posts/pause': 'Pause or resume posting',
  'POST /posts/burst': 'Raise the post allowance for a day',
  'GET /media/{token}': 'A post image for Buffer (public, unguessable token)',
  [`GET ${OPENAPI_PATH}`]: 'This document',
};

const toOpenApiPath = (url: string): string => url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
const paramsOf = (path: string): string[] => [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);

function scopeOf(method: string, url: string): string {
  if (PUBLIC_PATHS.has(url) || MEDIA_PATH.test(url)) return 'none';
  if (url === JOB_PATH && method === 'POST') return 'write or job-trigger token';
  if (method === 'POST' && INTAKE_ROUTES.has(url)) return 'write or intake';
  return isMutating(method) ? 'write' : 'read';
}

/** Installs the route collector. Call it BEFORE any route is registered. */
export function collectOpenApiRoutes(app: FastifyInstance): Entry[] {
  const entries: Entry[] = [];
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) {
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      entries.push({ method, url: r.url, ...(r.config?.openapiBody && { body: r.config.openapiBody }) });
    }
  });
  return entries;
}

export function buildOpenApi(entries: Entry[], version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const e of [...entries].sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method))) {
    const path = toOpenApiPath(e.url);
    const scope = scopeOf(e.method, e.url);
    const op: Record<string, unknown> = {
      summary: SUMMARIES[`${e.method} ${path}`] ?? `${e.method} ${path}`,
      'x-scope': scope,
      ...(scope === 'none' ? { security: [] } : { security: [{ bearer: [] }] }),
      ...(paramsOf(path).length ? { parameters: paramsOf(path).map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })) } : {}),
      ...(isMutating(e.method) ? { 'x-idempotency-key': 'required' } : {}),
      responses: { '200': { description: 'OK' } },
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

/** GET /openapi.json (READ). The route table is read when the request comes, so it holds every route registered by then (itself excluded). */
export function registerOpenApi(app: FastifyInstance, entries: Entry[], version: string): void {
  app.get(OPENAPI_PATH, async () => buildOpenApi(entries.filter((e) => e.url !== OPENAPI_PATH), version));
}
