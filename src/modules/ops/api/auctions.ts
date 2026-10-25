// v5.39.0 (CR-077). Auction bid plans: POST /auctions/prebid (the automatic safety checks of a registered name, stored), POST /auctions/plans (Dvir's approved maximum bid),
// POST /auctions/plans/:id/result (won, lost, withdrawn: what the name really cost), GET /auctions/plans, GET /auctions/plans/:id. GET /auctions/live is in the market module.
// Prebid is a normal mutating POST (it stores a row): Idempotency-Key, audit row, WRITE or bots. Plans and results are WRITE only. Rules and test ids: docs/internal/auctions.md.
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { toJerusalemIso } from '../../../core/dates.js';
import { pair } from '../../../core/money.js';
import type { Database } from '../../../db/types.js';
import { normalizeDomain } from '../../../domain-name.js';
import { AppError } from '../../../http/errors.js';
import { prebidVerdictOf, runPrebidChecks, type ScreeningDeps } from '../../selection/index.js';
import { createPlan, getPlan, listPlans, PlanBody, PlansQuery, recordResult, ResultBody, VENUES } from '../auctions/plans.js';

const PrebidBody = z.object({ domain: z.string().min(1).max(253), venue: z.enum(VENUES) }).strict();

/** The exact strings of the manual checks (v5.44.0): the name as words, in quotes, its CamelCase form, and the company registers. No automation of Google: a human pastes them. */
export function manualSearches(domain: string, words: readonly string[]): { words: string; camel_case: string; queries: string[]; wayback: string } {
  const sld = domain.replace(/\.com$/, '');
  const parts = words.length > 0 ? [...words] : [sld];
  const spaced = parts.join(' ');
  const camel = parts.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  return {
    words: spaced, camel_case: camel, wayback: `https://web.archive.org/web/*/${domain}`,
    queries: [
      `"${spaced}"`, `"${camel}"`, `"${sld}"`,
      `site:opencorporates.com "${spaced}"`, `site:find-and-update.company-information.service.gov.uk "${spaced}"`, `site:companieshouse.gov.uk "${spaced}"`,
    ],
  };
}

/** What no program can check: said in every pre-bid answer, confirmed by the caller in the plan's `manual` block. */
export function manualRequired(domain: string, words: readonly string[]) {
  const s = manualSearches(domain, words);
  return [
    { id: 'EXACT_STRING_BUSINESS', what: 'Google exact phrase + company registries: an operating business called exactly this name kills a coined name', search_strings: s.queries, name_as_words: s.words, camel_case: s.camel_case },
    { id: 'HIST_WAYBACK', what: 'past harmful use, checked by hand', wayback_url: s.wayback },
  ];
}

const bad = (p: { error: z.ZodError }) => new AppError(400, 'VALIDATION_ERROR', `Invalid query: ${p.error.issues.map((i) => `${i.path.join('.') || 'query'} ${i.message}`).join('; ')}`);
const idOf = (raw: string): number => {
  if (!/^\d{1,9}$/.test(raw) || Number(raw) < 1) throw new AppError(400, 'VALIDATION_ERROR', 'The plan id must be a positive whole number');
  return Number(raw);
};

export function registerAuctions(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number; screening: ScreeningDeps }): void {
  const { db } = deps;

  app.post('/auctions/prebid', { config: { openapiBody: PrebidBody } }, async (req, reply) => {
    const b = PrebidBody.parse(req.body ?? {});
    const domain = normalizeDomain(b.domain);
    if (!domain.endsWith('.com') || domain.split('.').length !== 2) throw new AppError(422, 'VALIDATION_ERROR', 'Only .com names');
    const cfg = await db.selectFrom('settings').select('s8_max_price_cents').executeTakeFirstOrThrow();
    const out = await runPrebidChecks(db, deps.screening, domain, deps.now);
    const verdict = prebidVerdictOf(out.checks);
    const answer = {
      domain, venue: b.venue, checked_at: toJerusalemIso(new Date(deps.now())), verdict, checks: out.checks, manual_required: manualRequired(domain, out.words), endings: out.endings, ...pair('s8_max_price', cfg.s8_max_price_cents),
    };
    const row = await db.insertInto('prebid_checks').values({
      domain, venue: b.venue, verdict, answer: JSON.stringify(answer), token_name: req.auth?.name ?? null, audit_id: req.auditId ?? null, created_at: new Date(deps.now()),
    }).returning('id').executeTakeFirstOrThrow();
    req.auditSummary = `prebid ${domain} (${b.venue}): ${verdict}`;
    return reply.code(201).send({ prebid_id: row.id, ...answer, audit_id: req.auditId ?? null });
  });

  app.post('/auctions/plans', { config: { openapiBody: PlanBody } }, async (req, reply) => {
    const b = PlanBody.parse(req.body ?? {});
    const plan = await createPlan(db, b, { tokenName: req.auth?.name ?? null, auditId: req.auditId ?? null, nowMs: deps.now() });
    req.auditSummary = `bid plan ${plan.id} for ${plan.domain}: max ${plan.max_bid} (${plan.kind}, ${plan.venue})`;
    return reply.code(201).send({ ...plan, audit_id: req.auditId ?? null });
  });

  app.post<{ Params: { id: string } }>('/auctions/plans/:id/result', { config: { openapiBody: ResultBody } }, async (req, reply) => {
    const id = idOf(req.params.id);
    const b = ResultBody.parse(req.body ?? {});
    const plan = await recordResult(db, id, b, { tokenName: req.auth?.name ?? null, auditId: req.auditId ?? null, nowMs: deps.now() });
    req.auditSummary = `bid plan ${id} for ${plan.domain}: ${b.outcome}${plan.final_price ? ` at ${plan.final_price}` : ''}`;
    return reply.code(200).send({ ...plan, audit_id: req.auditId ?? null });
  });

  app.get('/auctions/plans', async (req) => {
    const p = PlansQuery.safeParse(req.query ?? {});
    if (!p.success) throw bad(p);
    return listPlans(db, p.data, deps.now());
  });

  app.get<{ Params: { id: string } }>('/auctions/plans/:id', async (req) => getPlan(db, idOf(req.params.id), deps.now()));
}
