// v2.8.0 (CR-007 §22, G-2 source A): POST /selection/drop-lists, GET /selection/drop-lists/{name}, GET /selection/drop-lists?drop_from=&drop_to=.
// The daily step `dropWatch` (src/jobs/drop-watch.ts) fills the registry checks.
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/types.js';
import { DROP_LIST_NAME_RE, daysBetween, filterDropName, namesDroppingBetween } from '../drops/drop-lists.js';
import { splitV2 } from '../screening/split-v2.js';
import { AppError } from '../http/errors.js';
import { idtDay, realYmd, toJerusalemIso } from '../core/dates.js';
export interface DropListsDeps { db: Kysely<Database>; now: () => number }

export const ymd = realYmd;
const Body = z.object({ name: z.string().regex(DROP_LIST_NAME_RE), list_date: ymd, domains: z.array(z.string().max(300)).min(1).max(20_000) }).strict();
const WindowQuery = z.object({ drop_from: ymd, drop_to: ymd }).strict();
export const MAX_WINDOW_DAYS = 31;

const bad = (m: string) => new AppError(400, 'VALIDATION_ERROR', m);

/** Parses and checks a drop window (both ends required, calendar dates, from <= to, at most 31 days apart). Shared with POST /selection/cohorts. */
export function parseWindow(q: unknown): { from: string; to: string } {
  const p = WindowQuery.safeParse(q ?? {});
  if (!p.success) throw bad(`Invalid query: drop_from and drop_to are both required calendar dates (YYYY-MM-DD) and nothing else is accepted (${p.error.issues.map((i) => i.path.join('.') || i.message).join(', ')})`);
  const { drop_from: from, drop_to: to } = p.data;
  if (to < from) throw bad('drop_to must not be before drop_from');
  if (daysBetween(from, to) > MAX_WINDOW_DAYS) throw bad(`The window drop_from..drop_to is at most ${MAX_WINDOW_DAYS} days`);
  return { from, to };
}

/** Rows stored before v2.15.0 have no tokens for a TOO_MANY_WORDS or ONE_WORD removal (the table is append-only): the split is recomputed on read. */
function legacyTokens(r: { domain: string; reason: string | null }): string[] | null {
  if (r.reason !== 'TOO_MANY_WORDS' && r.reason !== 'ONE_WORD') return null;
  const m = /^([a-z]+)\.com$/.exec(r.domain);
  return m ? splitV2(m[1]!) : null;
}

export function registerDropLists(app: FastifyInstance, deps: DropListsDeps): void {
  const { db } = deps;

  app.post('/selection/drop-lists', { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const b = Body.parse(req.body ?? {});
    if (b.list_date > idtDay(deps.now())) throw new AppError(422, 'VALIDATION_ERROR', 'list_date must not be in the future', { list_date: b.list_date });
    if (await db.selectFrom('drop_lists').select('name').where('name', '=', b.name).executeTakeFirst()) {
      throw new AppError(409, 'DROP_LIST_NAME_TAKEN', `A drop list named ${b.name} exists`, { name: b.name });
    }
    const seen = new Set<string>();
    const rows = b.domains.map((d) => filterDropName(d, seen));
    const kept = rows.filter((r) => r.kept).length;
    const removed: Record<string, number> = {};
    for (const r of rows) if (r.reason) removed[r.reason] = (removed[r.reason] ?? 0) + 1;
    try {
      await db.transaction().execute(async (trx) => {
        await trx.insertInto('drop_lists').values({ name: b.name, list_date: b.list_date, created_at: new Date(deps.now()), created_by: req.auth!.name, received_n: rows.length, kept_n: kept }).execute();
        for (let i = 0; i < rows.length; i += 1000) {
          await trx.insertInto('drop_list_rows').values(rows.slice(i, i + 1000).map((r) => ({ list_name: b.name, domain: r.domain, kept: r.kept, reason: r.reason, tokens: r.tokens }))).execute();
        }
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new AppError(409, 'DROP_LIST_NAME_TAKEN', `A drop list named ${b.name} exists`, { name: b.name });
      throw e;
    }
    return reply.code(201).send({ name: b.name, list_date: b.list_date, received_n: rows.length, kept_n: kept, removed });
  });

  app.get<{ Params: { name: string } }>('/selection/drop-lists/:name', async (req) => {
    z.object({}).strict().parse(req.query ?? {});
    const list = await db.selectFrom('drop_lists').selectAll().where('name', '=', req.params.name).executeTakeFirst();
    if (!list) throw new AppError(404, 'DROP_LIST_NOT_FOUND', `No drop list "${req.params.name}"`);
    const rows = (await sql<{ domain: string; kept: boolean; reason: string | null; tokens: string[] | null; status: string | null; expected_drop_date: string | null; drop_date_source: string | null; checked_at: Date | null }>`
      select r.domain, r.kept, r.reason, r.tokens, c.status, c.expected_drop_date::text as expected_drop_date, c.drop_date_source, c.checked_at
      from drop_list_rows r left join lateral (select * from drop_list_checks k where k.list_name = r.list_name and k.domain = r.domain order by k.id desc limit 1) c on true
      where r.list_name = ${list.name} order by r.id`.execute(db)).rows;
    return {
      name: list.name, list_date: list.list_date, created_at: toJerusalemIso(list.created_at), created_by: list.created_by, received_n: list.received_n, kept_n: list.kept_n,
      rows: rows.map((r) => ({ domain: r.domain, kept: r.kept, reason: r.reason, tokens: r.tokens ?? legacyTokens(r), status: r.status, expected_drop_date: r.expected_drop_date, drop_date_source: r.drop_date_source, checked_at: r.checked_at ? toJerusalemIso(r.checked_at) : null })),
    };
  });

  app.get('/selection/drop-lists', async (req) => {
    const { from, to } = parseWindow(req.query);
    const names = await namesDroppingBetween(db, deps.now(), from, to);
    return { names };
  });
}
