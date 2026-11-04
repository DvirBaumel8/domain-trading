// v5.39.0 (CR-077). Auction bid plans: POST /auctions/prebid (the automatic safety checks of a registered name, stored), POST /auctions/plans (Dvir's approved maximum bid),
// POST /auctions/plans/:id/result (won, lost, withdrawn: what the name really cost), GET /auctions/plans, GET /auctions/plans/:id. GET /auctions/live is in the market module.
// Prebid is a normal mutating POST (it stores a row): Idempotency-Key, audit row, WRITE or bots. Plans and results are WRITE only. Rules and test ids: docs/internal/auctions.md.
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../../db/types.js';
import { normalizeDomain } from '../../../domain-name.js';
import { AppError } from '../../../http/errors.js';
import { registerBulkRoute, type DbSizeGuard } from '../../engine/index.js';
import type { ScreeningDeps } from '../../selection/index.js';
import { manualRequired, manualSearches, storePrebid } from '../auctions/prebid-store.js';
import { KILLS_MAX_ROWS, KillsQuery, listKills, loadKills } from '../auctions/kills.js';
import { FunnelQuery, getFunnel, getShortlist, ShortlistQuery } from '../auctions/shortlist.js';
import { createPlan, getPlan, listPlans, PlanBody, PlansQuery, recordResult, ResultBody, VENUES } from '../auctions/plans.js';

export { manualRequired, manualSearches };

const PrebidBody = z.object({ domain: z.string().min(1).max(253), venue: z.enum(VENUES) }).strict();

const bad = (p: { error: z.ZodError }) => new AppError(400, 'VALIDATION_ERROR', `Invalid query: ${p.error.issues.map((i) => `${i.path.join('.') || 'query'} ${i.message}`).join('; ')}`);
const idOf = (raw: string): number => {
  if (!/^\d{1,9}$/.test(raw) || Number(raw) < 1) throw new AppError(400, 'VALIDATION_ERROR', 'The plan id must be a positive whole number');
  return Number(raw);
};

export function registerAuctions(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number; screening: ScreeningDeps; dbSize: DbSizeGuard }): void {
  const { db } = deps;

  // v6.4.0 (CR-101): the kill store. A kill is a fact about a public name (no money, price or listing); WRITE or bots. The normal DB-size guard applies: the small-write
  // exemption of CR-097 is switched off here (a kill can wait a day).
  const KillsDoc = z.object({ rows: z.array(z.record(z.string(), z.unknown())).min(1).max(KILLS_MAX_ROWS) }).strict();
  registerBulkRoute(app, { ...deps, dbSize: { ...deps.dbSize, smallWriteBytes: undefined, hardStopPercent: undefined } }, {
    path: '/auctions/kills', doc: KillsDoc, dryRun: false, maxRows: KILLS_MAX_ROWS,
    load: (rows, ctx) => loadKills(db, rows, ctx),
    summary: (r, before, after) => `auction kills: ${r.accepted_n} accepted, ${r.duplicate_n} duplicate, ${r.rejected_n} rejected of ${r.received_n}; db ${before} -> ${after} bytes`,
  });
  app.get('/auctions/kills', async (req) => {
    const p = KillsQuery.safeParse(req.query ?? {});
    if (!p.success) throw bad(p);
    return listKills(db, p.data, deps.now());
  });

  app.post('/auctions/prebid', { config: { openapiBody: PrebidBody } }, async (req, reply) => {
    const b = PrebidBody.parse(req.body ?? {});
    const domain = normalizeDomain(b.domain);
    if (!domain.endsWith('.com') || domain.split('.').length !== 2) throw new AppError(422, 'VALIDATION_ERROR', 'Only .com names');
    const stored = await storePrebid(db, deps.screening, domain, b.venue, deps.now, { tokenName: req.auth?.name ?? null, auditId: req.auditId ?? null });
    const { verdict } = stored;
    req.auditSummary = `prebid ${domain} (${b.venue}): ${verdict}`;
    return reply.code(201).send({ prebid_id: stored.id, ...stored.answer, audit_id: req.auditId ?? null });
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

  // v5.45.0 (G-127): the daily shortlist and the weekly funnel (READ or bots)
  app.get('/auctions/shortlist', async (req) => {
    const p = ShortlistQuery.safeParse(req.query ?? {});
    if (!p.success) throw bad(p);
    return getShortlist(db, p.data, deps.now());
  });

  app.get('/auctions/funnel', async (req) => {
    const p = FunnelQuery.safeParse(req.query ?? {});
    if (!p.success) throw bad(p);
    return getFunnel(db, p.data, deps.now());
  });

  app.get('/auctions/plans', async (req) => {
    const p = PlansQuery.safeParse(req.query ?? {});
    if (!p.success) throw bad(p);
    return listPlans(db, p.data, deps.now());
  });

  app.get<{ Params: { id: string } }>('/auctions/plans/:id', async (req) => getPlan(db, idOf(req.params.id), deps.now()));
}
