// Screening runs (CAP-20), manual Web Risk / trademark records (CAP-06, CAP-08), evidence, manual renewal quotes (CAP-17).
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../db/types.js';
import { normalizeDomain } from '../domain-name.js';
import { AppError } from '../http/errors.js';
import { dollarsToCents, formatUsd } from '../money.js';
import { MANUAL_CHECKS, TmManual, WebRiskManual, tmFromManual, webRiskFromManual } from '../screening/checks/manual.js';
import { GATE_OF } from '../screening/checks/index.js';
import { latestByCheck } from '../screening/derive.js';
import { HEARTBEAT_STALE_MS, assemble, createRun, effectiveHold, refreshSummary, toResultRow, type ScreeningWorker } from '../screening/engine.js';
import { REGISTRAR_ENV } from '../registrars/registry.js';
import { readEvidence, storeEvidence } from '../screening/evidence.js';
import { CHECK_IDS, LABEL_RE, LANES, activeSelectionSettings, selectionSettingsByLabel } from '../screening/settings.js';
import type { ResultRow, RunItem } from '../screening/types.js';
import type { CheckId, Lane } from '../screening/types.js';

export interface ScreeningApiDeps { db: Kysely<Database>; now: () => number; worker: ScreeningWorker }

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const IsoTime = z.iso.datetime({ offset: true });
const usd = z.number().positive().refine((n) => { try { dollarsToCents(n); return true; } catch { return false; } }, 'a positive USD amount with at most 2 decimals');
const text = (max: number) => z.string().trim().min(1).max(max);

const InputName = z.object({
  domain: z.string().trim().min(1).max(253), lane: z.enum(LANES),
  city: text(60).optional(), state: text(60).optional(), trade: text(60).optional(), price_grade: z.enum(['strong', 'weaker']).optional(),
  bin_usd: usd.optional(), leads_ab: z.number().int().nonnegative().optional(), census_list: text(64).optional(),
  as_of: IsoTime.optional(), rank: z.number().int().optional(),
}).strict();
const RunBody = z.object({
  mode: z.enum(['live', 'full']).default('live'), settings: z.string().regex(LABEL_RE).optional(), tranche_id: text(64).optional(),
  checks: z.array(z.enum(CHECK_IDS)).min(1).optional(), names: z.array(InputName).min(1).max(50),
}).strict();
const ManualBody = z.object({
  domain: z.string().trim().min(1).max(253), check: z.string(), checked_at: IsoTime,
  evidence_url: z.string().url().max(500).refine((u) => u.startsWith('https://'), 'an https URL'),
  result: z.unknown(), note: z.string().max(500).optional(),
}).strict();
const QuoteBody = z.object({
  domain: z.string().trim().min(1).max(253), registrar: text(40), renewal_usd: usd, first_year_usd: usd.optional(),
  source_note: text(500), source_url: z.string().url().max(500).optional(), observed_at: IsoTime,
}).strict();

function resultJson(r: ResultRow) {
  return {
    check: r.check_id, gate: r.gate, rule_ids: r.rule_ids, status: r.status, reason_code: r.reason_code, reason: r.reason, fields: r.fields,
    data_as_of: iso(r.data_as_of), checked_at: r.checked_at.toISOString(), cached: r.source === 'cache', source: r.source,
    settings_version: r.settings_label, list_versions: r.list_versions, duration_ms: r.duration_ms, upstream_calls: r.upstream_calls, evidence: r.evidence_ids,
  };
}

export function registerScreening(app: FastifyInstance, deps: ScreeningApiDeps): void {
  const { db, worker } = deps;
  const now = () => new Date(deps.now());

  app.post('/screening/runs', async (req, reply) => {
    const body = RunBody.parse(req.body ?? {});
    const run = await createRun(db, body, { createdBy: req.auth!.name, auditId: req.auditId!, now: now() }, worker.checks);
    worker.kick(run.id);
    return reply.code(202).send({
      run_id: run.id, status: run.status, mode: run.mode, backtest: run.backtest, settings_version: run.settings_version,
      buy_hold: run.buy_hold, names_n: run.names_n, poll: `/screening/runs/${run.id}`,
    });
  });

  app.get<{ Params: { id: string } }>('/screening/runs/:id', async (req) => {
    const q = z.object({ domain: z.string().optional(), view: z.enum(['summary', 'full']).default('full') }).strict().safeParse(req.query);
    if (!q.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid query: only domain and view=summary|full are accepted');
    const run = await db.selectFrom('screening_runs').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!run) throw new AppError(404, 'RUN_NOT_FOUND', `No screening run "${req.params.id}"`);
    // A running run nobody has worked on lately (the service slept) continues now.
    if (run.status === 'running' && (!run.heartbeat_at || deps.now() - run.heartbeat_at.getTime() > HEARTBEAT_STALE_MS)) worker.kick(run.id);
    const sel = await selectionSettingsByLabel(db, run.settings_label);
    const input = run.input as { names: RunItem[] };
    const rows = (await db.selectFrom('screening_results').selectAll().where('run_id', '=', run.id).orderBy('id').execute()).map(toResultRow);
    const a = assemble(input.names, run.gate_plan as Partial<Record<Lane, CheckId[]>>, rows, sel!.values, await effectiveHold(db, run), run.status !== 'running', run.mode === 'live');
    const want = q.data.domain === undefined ? null : q.data.domain.trim().toLowerCase().replace(/\.$/, '');
    const tierOrder: string[] = sel!.values.tier.order;
    const names = a.items.map((i) => {
      const latest = latestByCheck(i.rows);
      return { i, latest, tierRank: tierOrder.indexOf((latest.get('tier')?.fields.tier as string | undefined) ?? ''), short: (latest.get('form')?.fields.short as number | undefined) ?? 0, score: (latest.get('price')?.fields.score_0_100 as number | undefined) ?? null };
    });
    // Survivors (never rejected, invalid or unknown) in the CR-002 CAP-01 FORM-2 order: tier order, short names first, then score, then submission order.
    const ranking = names.filter((n) => ['buy_candidate', 'would_buy', 'pending_manual'].includes(n.i.derived.final_status))
      .sort((x, y) => (x.tierRank < 0 ? 99 : x.tierRank) - (y.tierRank < 0 ? 99 : y.tierRank) || y.short - x.short || (y.score ?? -1) - (x.score ?? -1) || x.i.item.idx - y.i.item.idx)
      .map((n) => n.i.item.domain);
    return {
      run_id: run.id, status: run.status, mode: run.mode, backtest: run.backtest, settings_version: run.settings_label, buy_hold: run.buy_hold,
      created_at: run.created_at.toISOString(), finished_at: iso(run.finished_at), progress: a.progress,
      names: a.items.filter((i) => want === null || i.item.domain === want).map((i) => {
        const latest = latestByCheck(i.rows);
        return {
          domain: i.item.domain, lane: i.item.lane, final_status: i.derived.final_status, first_fail: i.derived.first_fail,
          tier: (latest.get('tier')?.fields.tier as string | undefined) ?? null, score: (latest.get('price')?.fields.score_0_100 as number | undefined) ?? null, short: (latest.get('form')?.fields.short as number | undefined) ?? null,
          flags: i.derived.flags, pending_manual: i.derived.pending_manual, not_implemented: i.derived.not_implemented,
          source_lane: (latest.get('history')?.fields.source_lane as string | undefined) ?? null,
          ...(q.data.view === 'full' && { results: [...latest.values()].sort((x, y) => x.id - y.id).map(resultJson) }),
        };
      }),
      ranking,
      funnel: a.funnel,
    };
  });

  app.post<{ Params: { id: string } }>('/screening/runs/:id/manual', async (req, reply) => {
    const body = ManualBody.parse(req.body ?? {});
    const run = await db.selectFrom('screening_runs').selectAll().where('id', '=', req.params.id).executeTakeFirst();
    if (!run) throw new AppError(404, 'RUN_NOT_FOUND', `No screening run "${req.params.id}"`);
    if (!(MANUAL_CHECKS as readonly string[]).includes(body.check)) {
      throw new AppError(422, 'CHECK_NOT_MANUAL', `Only ${MANUAL_CHECKS.join(' and ')} take a manual record`, { check: body.check, manual: MANUAL_CHECKS });
    }
    const check = body.check as (typeof MANUAL_CHECKS)[number];
    let domain: string | null = null;
    try { domain = normalizeDomain(body.domain); } catch { /* not a name of any run */ }
    const item = (run.input as { names: RunItem[] }).names.find((n) => n.domain === domain && !n.input_error);
    if (!item) throw new AppError(404, 'NAME_NOT_IN_RUN', `"${body.domain}" is not a screened name of run ${run.id}`);
    const checkedAt = new Date(body.checked_at);
    const sel = (await selectionSettingsByLabel(db, run.settings_label))!;
    if (checkedAt.getTime() > deps.now() + 60_000) throw new AppError(422, 'CHECKED_AT_INVALID', 'checked_at is in the future');
    const windowH = sel.values.freshness_hours[check] ?? 0;
    if (windowH > 0 && checkedAt.getTime() < deps.now() - windowH * 3_600_000) {
      throw new AppError(422, 'CHECKED_AT_INVALID', `checked_at is older than the ${check} freshness window (${windowH} h)`, { freshness_hours: windowH });
    }
    const rec = check === 'web_risk' ? WebRiskManual.parse(body.result) : TmManual.parse(body.result);
    const history = await db.selectFrom('screening_results').selectAll().where('run_id', '=', run.id).where('item_idx', '=', item.idx)
      .where('check_id', '=', 'history').orderBy('id', 'desc').limit(1).executeTakeFirst();
    const json = JSON.stringify(rec);
    const evidenceId = await storeEvidence(db, {
      source: 'manual', url: body.evidence_url, retrievedAt: checkedAt, httpStatus: null, contentType: 'application/json',
      body: json, text: json, maxBytes: sel.values.evidence.max_text_bytes,
    });
    const o = check === 'web_risk'
      ? webRiskFromManual(rec as z.infer<typeof WebRiskManual>, sel.values, history ? toResultRow(history) : undefined, body.evidence_url, checkedAt, body.note)
      : tmFromManual(rec as z.infer<typeof TmManual>, body.evidence_url, checkedAt, body.note, history ? toResultRow(history) : undefined);
    const row = await db.insertInto('screening_results').values({
      run_id: run.id, item_idx: item.idx, domain: item.domain, lane: item.lane, check_id: check, gate: GATE_OF[check],
      rule_ids: worker.checks[check]?.ruleIds ?? [], status: o.status, reason_code: o.reasonCode, reason: o.reason,
      fields: JSON.stringify(o.fields), data_as_of: o.dataAsOf, checked_at: checkedAt, settings_label: run.settings_label,
      list_versions: JSON.stringify(Object.fromEntries((worker.checks[check]?.lists ?? []).filter((n) => (run.list_versions as Record<string, number>)[n] !== undefined).map((n) => [n, (run.list_versions as Record<string, number>)[n]]))),
      duration_ms: 0, upstream_calls: 0, evidence_ids: [String(evidenceId)], source: 'manual',
      recorded_by: req.auth!.name, audit_id: req.auditId!,
    }).returningAll().executeTakeFirstOrThrow();
    await refreshSummary(db, run);
    return reply.code(201).send({ domain: item.domain, ...resultJson(toResultRow(row)), recorded_by: req.auth!.name });
  });

  app.get<{ Params: { id: string } }>('/screening/evidence/:id', async (req) => {
    const id = /^\d{1,15}$/.test(req.params.id) ? Number(req.params.id) : null;
    const e = id === null ? null : await readEvidence(db, id);
    if (!e) throw new AppError(404, 'EVIDENCE_NOT_FOUND', `No evidence "${req.params.id}"`);
    return { id: e.id, source: e.source, url: e.url, retrieved_at: e.retrieved_at.toISOString(), http_status: e.http_status, sha256: e.sha256, truncated: e.truncated, text: e.text };
  });

  app.post('/quotes/manual', async (req, reply) => {
    const b = QuoteBody.parse(req.body ?? {});
    const domain = normalizeDomain(b.domain);
    const registrar = b.registrar.toLowerCase();
    if (registrar === 'cloudflare') throw new AppError(422, 'REGISTRAR_NOT_ALLOWED', 'Cloudflare Registrar is never used: no third-party nameservers, so no for-sale lander (founder rule 5)');
    if (!Object.hasOwn(REGISTRAR_ENV, registrar)) throw new AppError(422, 'REGISTRAR_UNKNOWN', `"${b.registrar}" is not a configured registrar name`, { known: Object.keys(REGISTRAR_ENV) });
    const maxDays = (await activeSelectionSettings(db)).values.quote.manual_max_age_days;
    const observed = new Date(b.observed_at);
    const t = deps.now();
    if (observed.getTime() > t + 60_000) throw new AppError(422, 'OBSERVED_AT_INVALID', 'observed_at is in the future');
    if (observed.getTime() < t - maxDays * 86_400_000) throw new AppError(422, 'OBSERVED_AT_INVALID', `observed_at is older than ${maxDays} days (quote.manual_max_age_days)`, { max_age_days: maxDays });
    const renewal = dollarsToCents(b.renewal_usd);
    const r = await db.insertInto('manual_quotes').values({
      domain, registrar, renewal_cents: renewal, first_year_cents: b.first_year_usd === undefined ? null : dollarsToCents(b.first_year_usd),
      source_url: b.source_url ?? null, source_note: b.source_note, observed_at: observed, recorded_by: req.auth!.name, audit_id: req.auditId!,
    }).returning(['id']).executeTakeFirstOrThrow();
    return reply.code(201).send({
      id: Number(r.id), domain, registrar, renewal_cents: renewal, renewal: formatUsd(renewal),
      valid_until: new Date(observed.getTime() + maxDays * 86_400_000).toISOString(),
    });
  });
}
