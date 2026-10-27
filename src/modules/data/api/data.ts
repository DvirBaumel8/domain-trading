// v5.12.0 (CR-063): POST /data/{rdap,live-checks,tm-kills,bigco-names,sales-comps} (WRITE or data scope, Idempotency-Key, { rows, dry_run? }) and
// GET /data/<same> (READ; filters host, since, limit). Loads are guarded like the engine uploads: DB_SIZE_HIGH, the 8 MB body limit, per-row reject reasons.
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { ymd } from '../../../core/dates.js';
import type { Database } from '../../../db/types.js';
import { AppError } from '../../../http/errors.js';
import { ENGINE_MAX_ROWS, registerBulkRoute, type DbSizeGuard } from '../../engine/index.js';
import { registerCardEvidence } from './card-evidence.js';
import { dataRowCounts, loadBigcoNames, loadLive, loadRdap, loadSalesComps, loadTmKills, readData, type DataLoadResult, type DataTable } from '../tables.js';

const Doc = z.object({ rows: z.array(z.record(z.string(), z.unknown())).min(1).max(ENGINE_MAX_ROWS), dry_run: z.boolean().optional() }).strict();
const Query = z.object({
  host: z.string().min(1).max(253).optional(),
  since: z.union([ymd, z.string().regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/)]).optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
}).strict();

type Loader = (db: Kysely<Database>, rows: unknown[], ctx: { by: string; auditId: string | null; now: number; dryRun: boolean }) => Promise<DataLoadResult>;
const TABLES: { path: string; table: DataTable; load: Loader }[] = [
  { path: 'rdap', table: 'domain_rdap', load: loadRdap },
  { path: 'live-checks', table: 'live_checks', load: loadLive },
  { path: 'tm-kills', table: 'tm_kills', load: loadTmKills },
  { path: 'bigco-names', table: 'bigco_names', load: loadBigcoNames },
  { path: 'sales-comps', table: 'sales_comps', load: loadSalesComps },
];

export function registerData(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number; dbSize: DbSizeGuard }): void {
  registerCardEvidence(app, deps); // v5.64.0 (CR-083)
  for (const t of TABLES) {
    registerBulkRoute(app, deps, {
      path: `/data/${t.path}`, doc: Doc, dryRun: true,
      load: (rows, ctx) => t.load(deps.db, rows, ctx),
      extend: async () => ({ rows: await dataRowCounts(deps.db) }),
      summary: (r, before, after) => `data ${t.path}${r.dry_run ? ' (dry run)' : ''}: ${r.accepted_n} accepted, ${r.duplicate_n} duplicate, ${r.rejected_n} rejected${r.skipped_not_in_pool_n !== undefined ? `, ${r.skipped_not_in_pool_n} not in pool` : ''} of ${r.received_n}; db ${before} -> ${after} bytes`,
    });

    app.get(`/data/${t.path}`, async (req) => {
      const parsed = Query.safeParse(req.query ?? {});
      if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', 'Invalid query', { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
      const q = parsed.data;
      const r = await readData(deps.db, t.table, { host: q.host?.trim().toLowerCase(), since: q.since, limit: q.limit, now: deps.now() });
      return { table: t.table, ...r };
    });
  }
}
