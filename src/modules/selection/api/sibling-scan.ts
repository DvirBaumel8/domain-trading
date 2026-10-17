// CR-050 part 1 (v4.1.0): POST /selection/sibling-scan (WRITE) scans up to 20 .com names and stores the results; GET /selection/sibling-scan/:domain (READ) returns the newest stored scan.
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../../db/types.js';
import { normalizeDomain } from '../../../domain-name.js';
import { AppError } from '../../../http/errors.js';
import { latestSiblingScan, scanSiblings } from '../sibling-scan.js';
import type { ScreeningDeps } from '../types.js';

export interface SiblingScanApiDeps { db: Kysely<Database>; now: () => number; screening: ScreeningDeps }

const SIBLING_SCAN_MAX_DOMAINS = 20;
const Body = z.object({ domains: z.array(z.string().trim().min(1).max(253)).min(1).max(SIBLING_SCAN_MAX_DOMAINS) }).strict();

export function registerSiblingScan(app: FastifyInstance, deps: SiblingScanApiDeps): void {
  app.post('/selection/sibling-scan', { config: { openapiBody: Body } }, async (req, reply) => {
    const b = Body.parse(req.body ?? {});
    const domains = [...new Set(b.domains.map((d) => normalizeDomain(d)))]; // 422 DOMAIN_INVALID / TLD_NOT_SUPPORTED before anything is fetched
    const scans = await scanSiblings(deps.db, deps.screening, domains, { now: deps.now, by: req.auth!.name, auditId: req.auditId ?? null });
    return reply.code(200).send({ scans });
  });

  app.get<{ Params: { domain: string } }>('/selection/sibling-scan/:domain', async (req) => {
    const domain = normalizeDomain(req.params.domain);
    const scan = await latestSiblingScan(deps.db, domain);
    if (!scan) throw new AppError(404, 'SIBLING_SCAN_NOT_FOUND', `No sibling scan for ${domain}`);
    return scan;
  });
}
