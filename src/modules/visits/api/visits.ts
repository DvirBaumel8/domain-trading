// v5.18.0 (CR-068): the $0 visitor counter.
//   POST /visits/hit (visits token only, Idempotency-Key, not audited per hit), POST /visits/import (WRITE or data), POST /visits/settings (WRITE; v5.19.0: approval_ref optional and ignored),
//   POST /visits/forward/{domain} (WRITE; v5.19.0: approval_ref optional and ignored, live NS check), GET /visits, GET /visits/weekly (READ).
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { dayNumber, realYmd } from '../../../core/dates.js';
import { approvalRef } from '../../../core/validation.js';
import type { Database } from '../../../db/types.js';
import { normalizeDomain } from '../../../domain-name.js';
import { AppError } from '../../../http/errors.js';
import type { RegistrarAdapter } from '../../registrars/index.js';
import { setForward } from '../forward.js';
import { importAfternic, isCountable, normalizeReferrerHost, readDaily, recordHit, requestVisitsToken, setVisitsEnabled, utcDay, visitsEnabled, weekly } from '../store.js';

const HitBody = z.object({ domain: z.string().min(1).max(253), ua_class: z.enum(['human', 'bot']), referrer_host: z.string().max(2048).nullable().optional() }).strict();
const ImportBody = z.object({ domain: z.string().min(1).max(253), date: realYmd, views_30d: z.number().int().min(0).max(100_000_000), leads_30d: z.number().int().min(0).max(100_000_000) }).strict();
const SettingsBody = z.object({ enabled: z.boolean().optional(), token: z.literal('request').optional(), approval_ref: approvalRef.optional() }).strict();
const SettingsDoc = z.object({ enabled: z.boolean().optional(), token: z.literal('request').optional(), approval_ref: z.object({ text: z.string(), approved_at: z.string() }).optional() }).strict();
const ForwardBody = z.object({ approval_ref: approvalRef.optional(), revert: z.boolean().optional(), dry_run: z.boolean().optional() }).strict();
const ForwardDoc = z.object({ approval_ref: z.object({ text: z.string(), approved_at: z.string() }).optional(), revert: z.boolean().optional(), dry_run: z.boolean().optional() }).strict();
const RangeQuery = z.object({ from: realYmd.optional(), to: realYmd.optional() }).strict();
const WeeklyQuery = z.object({ week_ending: realYmd }).strict();

const MAX_RANGE_DAYS = 400;
const DAY = 86_400_000;
const issues = (e: z.ZodError) => ({ issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
const invalid = (message: string, path: string): AppError => new AppError(422, 'VALIDATION_ERROR', message, { issues: [{ path, message }] });
const dayMs = (ymd: string): number => dayNumber(ymd) * DAY;

export function registerVisits(app: FastifyInstance, deps: { db: Kysely<Database>; now: () => number; adapters: RegistrarAdapter[]; publicBaseUrl: string; nsLookup?: (d: string) => Promise<string[] | null> }): void {
  const { db } = deps;

  // From the api-proxy Worker, once per redirected visitor. Counts only; the answer says nothing but whether it was counted.
  app.post('/visits/hit', { config: { openapiBody: HitBody, openapiStatus: 202 } }, async (req, reply) => {
    const b = HitBody.parse(req.body ?? {});
    if (!(await visitsEnabled(db))) throw new AppError(409, 'VISITS_DISABLED', 'The visitor counter is switched off');
    let domain: string;
    try { domain = normalizeDomain(b.domain); } catch { throw new AppError(422, 'DOMAIN_NOT_LISTED', 'Not a listed name we count'); }
    if (!(await isCountable(db, domain))) {
      req.log.warn({ code: 'DOMAIN_NOT_LISTED', domain }, 'visits hit refused'); // BUG-046: the host log shows why a hit was not counted (no request data)
      throw new AppError(422, 'DOMAIN_NOT_LISTED', 'Not a listed name we count', { domain });
    }
    const r = await recordHit(db, { domain, ua: b.ua_class, referrer: normalizeReferrerHost(b.referrer_host), nowMs: deps.now() });
    return reply.code(202).send({ counted: r.counted, capped: r.capped });
  });

  // Afternic's own 30-day Views/Leads (CR-037 rows) for the names Afternic serves; a re-import of the same (domain, date) replaces the row.
  app.post('/visits/import', { config: { openapiBody: ImportBody } }, async (req) => {
    const b = ImportBody.parse(req.body ?? {});
    let domain: string;
    try { domain = normalizeDomain(b.domain); } catch { throw new AppError(422, 'DOMAIN_NOT_LISTED', 'Unknown domain'); }
    if (b.date > utcDay(deps.now())) throw invalid('date cannot be in the future', 'date');
    const ok = await importAfternic(db, { domain, date: b.date, views30d: b.views_30d, leads30d: b.leads_30d, now: new Date(deps.now()) });
    if (!ok) throw new AppError(422, 'DOMAIN_NOT_LISTED', `${domain} is not in the portfolio`, { domain });
    req.auditSummary = `visits import ${domain} ${b.date}: views ${b.views_30d}, leads ${b.leads_30d}`;
    return { domain, date: b.date, source: 'afternic', views_30d: b.views_30d, leads_30d: b.leads_30d, audit_id: req.auditId ?? null };
  });

  // The switch, and the request for the visit-counter token. v5.19.0 (Dvir, 19 Oct 2026): no approval line needed; a sent approval_ref is accepted and ignored.
  app.post('/visits/settings', { config: { openapiBody: SettingsDoc } }, async (req) => {
    const b = SettingsBody.parse(req.body ?? {});
    if (b.enabled === undefined && b.token === undefined) throw invalid('enabled or token is required', 'enabled');
    const out: Record<string, unknown> = {};
    const parts: string[] = [];
    if (b.enabled !== undefined) {
      const previous = await setVisitsEnabled(db, b.enabled, new Date(deps.now()));
      Object.assign(out, { enabled: b.enabled, previous });
      parts.push(`visits.enabled ${previous} -> ${b.enabled}`);
    }
    if (b.token !== undefined) {
      const before = await requestVisitsToken(db, new Date(deps.now()));
      Object.assign(out, { token_request: 'requested', token_request_before: before });
      parts.push(`visits token requested (was ${before ?? 'none'})`);
    }
    req.auditSummary = parts.join('; ');
    return { ...out, audit_id: req.auditId ?? null };
  });

  // Point the Porkbun URL forward of a listed name at the counting redirect (or back at Afternic). dry_run answers with the plan and calls no registrar.
  app.post<{ Params: { domain: string } }>('/visits/forward/:domain', { config: { openapiBody: ForwardDoc } }, async (req) => {
    let domain: string;
    try { domain = normalizeDomain(req.params.domain); } catch { throw new AppError(404, 'DOMAIN_NOT_FOUND', 'Domain not found'); }
    const b = ForwardBody.parse(req.body ?? {});
    const r = await setForward({ db, adapters: deps.adapters, publicBaseUrl: deps.publicBaseUrl, now: deps.now, nsLookup: deps.nsLookup }, { domain, revert: b.revert === true, dryRun: b.dry_run === true });
    req.auditSummary = `visits forward ${domain}${r.revert ? ' revert' : ''}${r.dry_run ? ' (dry run)' : ''}`;
    return { domain: r.domain, before: r.before, after: r.after, dry_run: r.dry_run, audit_id: req.auditId ?? null };
  });

  app.get('/visits', async (req) => {
    const q = RangeQuery.safeParse(req.query ?? {});
    if (!q.success) throw new AppError(422, 'VALIDATION_ERROR', 'Invalid query', issues(q.error));
    const to = q.data.to ?? utcDay(deps.now());
    const from = q.data.from ?? utcDay(dayMs(to) - 29 * DAY);
    if (from > to) throw invalid('from is after to', 'from');
    if ((dayMs(to) - dayMs(from)) / DAY + 1 > MAX_RANGE_DAYS) throw invalid(`the range is at most ${MAX_RANGE_DAYS} days`, 'from');
    return { from, to, enabled: await visitsEnabled(db), rows: await readDaily(db, from, to) };
  });

  app.get('/visits/weekly', async (req) => {
    const q = WeeklyQuery.safeParse(req.query ?? {});
    if (!q.success) throw new AppError(422, 'VALIDATION_ERROR', 'week_ending is required (YYYY-MM-DD)', issues(q.error));
    const end = q.data.week_ending;
    if (new Date(dayMs(end)).getUTCDay() !== 6) throw invalid('week_ending must be a Saturday', 'week_ending');
    const from = utcDay(dayMs(end) - 6 * DAY);
    const w = await weekly(db, from, end, deps.nsLookup);
    return { week_ending: end, week_start: from, enabled: await visitsEnabled(db), rows: w.rows, not_countable: w.not_countable };
  });
}
