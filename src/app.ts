import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Kysely } from 'kysely';
import { registerBuy } from './api/buy.js';
import { registerPricing } from './api/pricing.js';
import { registerList } from './api/list.js';
import { registerOffers } from './api/offers.js';
import { registerReads } from './api/reads.js';
import { registerReport } from './api/report.js';
import { registerSold } from './api/sold.js';
import { registerSelection } from './api/selection.js';
import { registerScreening } from './api/screening.js';
import { registerTestSets } from './api/test-sets.js';
import { registerPacks } from './api/packs.js';
import { registerTranches } from './api/tranches.js';
import { ScreeningWorker } from './screening/engine.js';
import type { ScreeningDeps } from './screening/types.js';
import type { HoldoutCheck } from './screening/settings.js';
import { SoldService } from './services/sold.js';
import { OffersService } from './services/offers.js';
import { registerExport } from './api/export.js';
import { registerCheck } from './api/check.js';
import { registerHealth } from './api/health.js';
import dns from 'node:dns';
import { queryDns, queryNs, type NsLookup } from './dns/ns-lookup.js';
import type { Config } from './config.js';
import type { Database } from './db/types.js';
import { dbAuditWriter, auditFrameworkError, registerAuditId, registerAuditWrite, type AuditWriter } from './http/audit.js';
import { registerAuth, registerScope } from './http/auth.js';
import { registerIdempotency } from './http/idempotency.js';
import { registerRateLimit } from './http/rate-limit.js';
import { registerErrorHandling } from './http/errors.js';
import { jerusalemDeep } from './core/dates.js';
import { rdapLookup, rdapStatus, type RdapFn } from './rdap.js';
import { RegistrarCheckJob } from './jobs/registrar-check.js';
import { PortfolioCheckJob } from './jobs/portfolio-check.js';
import { DropWatchJob } from './jobs/drop-watch.js';
import { CohortOutcomesJob } from './jobs/cohort-outcomes.js';
import { registerDropLists } from './api/drop-lists.js';
import { registerCohorts } from './api/cohorts.js';
import { registerCompany } from './api/company.js';
import { registerCandidates } from './api/candidates.js';
import { registerPosts } from './api/posts.js';
import { BufferClient } from './services/posting/buffer.js';
import { postsRefresh, type PostingDeps } from './services/posting/posts.js';
import { registerReviews } from './api/reviews.js';
import { retryReview, runReview } from './services/review/run.js';
import { createAdapters } from './registrars/registry.js';
import type { RegistrarAdapter } from './registrars/types.js';
import { BuyService } from './services/buy.js';
import { CheckService } from './services/check.js';
import { ExportService } from './services/export.js';
import { ListService } from './services/list.js';
import { NsVerifier } from './jobs/ns-verify.js';
import { DropJob } from './jobs/drop.js';
import { ReferenceRefreshJob } from './jobs/reference-refresh.js';
import { PriceScheduleJob } from './jobs/price-schedule.js';
import { registerJobs } from './api/jobs.js';
import { IntakeScreeningJob } from './screening/intake.js';
import { BuildDailyListJob } from './screening/daily-list.js';
import { JobRunner, type BackupExport } from './jobs/runner.js';
import { Reconciler } from './services/reconciler.js';

declare module 'fastify' {
  interface FastifyInstance {
    routeTable: { method: string; url: string }[];
    reconciler: Reconciler;
    nsVerifier: NsVerifier;
    priceJob: PriceScheduleJob;
    dropJob: DropJob;
    registrarCheckJob: RegistrarCheckJob;
    portfolioCheckJob: PortfolioCheckJob;
    dropWatchJob: DropWatchJob;
    intakeScreeningJob: IntakeScreeningJob;
    buildDailyListJob: BuildDailyListJob;
    cohortOutcomesJob: CohortOutcomesJob;
    referenceRefreshJob: ReferenceRefreshJob;
    jobRunner: JobRunner;
    screeningWorker: ScreeningWorker;
  }
}

export interface AppDeps {
  config: Config;
  db: Kysely<Database>;
  /** Clock in ms, for the rate limiter. */
  now?: () => number;
  audit?: AuditWriter;
  logger?: FastifyServerOptions['logger'];
  /** Test-only routes. Production never passes this. */
  registerExtraRoutes?: (app: FastifyInstance) => void;
  adapters?: RegistrarAdapter[];
  rdap?: RdapFn;
  quoteTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  nsLookup?: NsLookup;
  exportLockTimeoutMs?: number;
  /** Nightly data export (step 6a task 2); undefined → that step is skipped. */
  backupExport?: BackupExport;
  /** Gate for clearing `buy_hold` in a selection settings activation (replaced by the holdout report in a later task). */
  holdoutCheck?: HoldoutCheck;
  /** Test-only: the screening worker stops (as if killed) after this many results of its first execution. */
  screeningStopAfterResults?: number;
  /** Test-only: how long buildDailyList waits for the day's intake run (default 20 minutes). */
  dailyListWaitMs?: number;
  /** Test-only: replaces the screening checks' outside access (RDAP, DNS, fetch). Production passes nothing. */
  screening?: Partial<Omit<ScreeningDeps, 'checkService'>>;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const auditWriter = deps.audit ?? dbAuditWriter(deps.db);
  const app = Fastify({
    logger: deps.logger ?? { level: deps.config.logLevel, redact: ['req.headers.authorization'] },
    trustProxy: (_addr: string, hop: number) => hop < 1, // trust exactly 1 proxy hop (Render); 'true' would trust a forged X-Forwarded-For in audit client_ip
    bodyLimit: 64 * 1024,
    // Framework errors bypass all hooks; see auditFrameworkError.
    frameworkErrors: (err, req, reply) => auditFrameworkError(err, req, reply),
  });

  // BUG-3 (CR-005): Fastify's built-in text/plain parser would pass a string body on to the zod schema (422). Remove it, so
  // text/plain (like every non-JSON type) is a 415 INVALID_BODY.
  app.removeContentTypeParser('text/plain');

  const routeTable: { method: string; url: string }[] = [];
  app.decorate('routeTable', routeTable);
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) routeTable.push({ method, url: r.url });
  });

  registerErrorHandling(app);
  // BUG-2 (CR-005): every response timestamp uses the Asia/Jerusalem offset, except the documented UTC fields.
  const UTC_FIELDS: Record<string, ReadonlySet<string>> = {
    '/export/:venue/uploaded': new Set(['uploaded_at']),
    '/jobs/run': new Set(['started_at', 'finished_at']),
  };
  app.addHook('preSerialization', async (req, _reply, payload) => {
    if (payload === null || typeof payload !== 'object' || Buffer.isBuffer(payload)) return payload;
    return jerusalemDeep(payload, UTC_FIELDS[req.routeOptions?.url ?? '']);
  });
  registerAuditId(app); // onRequest (first)
  registerAuth(app, deps.db, deps.config.jobTriggerToken, deps.now); // onRequest
  registerRateLimit(app, deps.now); // preHandler (first, so a 429 never claims an idempotency key)
  registerScope(app); // preHandler
  registerIdempotency(app, deps.db); // preHandler (after scope) + onSend (before audit write)
  registerAuditWrite(app, auditWriter); // onSend (last)

  const postingDeps: PostingDeps = {
    db: deps.db, now: deps.now ?? Date.now, secretValues: deps.config.secretValues, publicBaseUrl: deps.config.publicBaseUrl,
    buffer: deps.config.bufferApiKey ? new BufferClient({ fetch: globalThis.fetch, apiKey: deps.config.bufferApiKey, channelId: deps.config.bufferChannelId }) : null,
  };
  registerHealth(app, deps.config, deps.db, deps.now ?? Date.now, postingDeps);
  const adapters = deps.adapters ?? createAdapters(deps.config);
  const checkService = new CheckService({
    db: deps.db,
    adapters,
    rdap: deps.rdap ?? rdapStatus,
    now: deps.now ?? Date.now,
    quoteTimeoutMs: deps.quoteTimeoutMs,
    log: app.log,
  });
  registerCheck(app, checkService);
  const buyService = new BuyService({
    db: deps.db, adapters, checkService, rdap: deps.rdap ?? rdapStatus, now: deps.now ?? Date.now,
    sleep: deps.sleep, log: app.log,
  });
  registerBuy(app, buyService);
  registerExport(app, new ExportService({ db: deps.db, config: deps.config, now: deps.now ?? Date.now, lockTimeoutMs: deps.exportLockTimeoutMs }));
  registerPricing(app, { db: deps.db, now: deps.now ?? Date.now });
  const nsLookup: NsLookup = deps.nsLookup ?? ((d: string) => queryNs(d, { server: deps.config.dnsNsServer }));
  registerList(app, new ListService({ db: deps.db, adapters, config: deps.config, nsLookup, now: deps.now ?? Date.now }));
  registerOffers(app, new OffersService({ db: deps.db, now: deps.now ?? Date.now }), { db: deps.db, now: deps.now ?? Date.now });
  registerReport(app, { db: deps.db, now: deps.now ?? Date.now });
  registerReads(app, { db: deps.db, now: deps.now ?? Date.now });
  registerSold(app, new SoldService({ db: deps.db, now: deps.now ?? Date.now }));
  registerSelection(app, { db: deps.db, now: deps.now ?? Date.now, holdoutCheck: deps.holdoutCheck });
  const screeningDeps: ScreeningDeps = {
    fetch: globalThis.fetch, sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), checkService,
    rdapLookup, dnsQuery: queryDns,
    resolveNs: (zone) => dns.promises.resolveNs(zone),
    resolve4: (host) => dns.promises.resolve4(host),
    webRiskApiKey: deps.config.webRiskApiKey,
    ...deps.screening,
  };
  const screeningWorker = new ScreeningWorker({
    db: deps.db, now: deps.now ?? Date.now, log: app.log,
    stopAfterResults: deps.screeningStopAfterResults,
    screening: screeningDeps,
  });
  app.decorate('screeningWorker', screeningWorker);
  app.addHook('onClose', async () => screeningWorker.idle());
  registerScreening(app, { db: deps.db, now: deps.now ?? Date.now, worker: screeningWorker });
  registerTestSets(app, { db: deps.db, now: deps.now ?? Date.now, worker: screeningWorker });
  registerDropLists(app, { db: deps.db, now: deps.now ?? Date.now });
  registerCohorts(app, { db: deps.db, now: deps.now ?? Date.now, worker: screeningWorker });
  registerCandidates(app, { db: deps.db, now: deps.now ?? Date.now, worker: screeningWorker });
  registerCompany(app, { db: deps.db, now: deps.now ?? Date.now, secretValues: deps.config.secretValues });
  const reviewDeps = { fetch: globalThis.fetch, apiKey: deps.config.geminiApiKey };
  registerReviews(app, { db: deps.db, now: deps.now ?? Date.now, secretValues: deps.config.secretValues, version: deps.config.version, review: reviewDeps });
  registerPosts(app, postingDeps);
  registerPacks(app, { db: deps.db, now: deps.now ?? Date.now });
  registerTranches(app, { db: deps.db, now: deps.now ?? Date.now });
  const referenceRefresh = new ReferenceRefreshJob({ db: deps.db, screening: screeningDeps, now: deps.now ?? Date.now, log: app.log });
  app.decorate('referenceRefreshJob', referenceRefresh);
  app.decorate('registrarCheckJob', new RegistrarCheckJob({ db: deps.db, adapters, now: deps.now ?? Date.now, log: app.log }));
  app.decorate('portfolioCheckJob', new PortfolioCheckJob({ db: deps.db, rdapLookup: screeningDeps.rdapLookup, screening: screeningDeps, now: deps.now ?? Date.now, log: app.log }));
  app.decorate('dropWatchJob', new DropWatchJob({ db: deps.db, screening: screeningDeps, now: deps.now ?? Date.now, log: app.log }));
  app.decorate('intakeScreeningJob', new IntakeScreeningJob({ db: deps.db, worker: screeningWorker, now: deps.now ?? Date.now }));
  app.decorate('buildDailyListJob', new BuildDailyListJob({ db: deps.db, worker: screeningWorker, now: deps.now ?? Date.now, waitMs: deps.dailyListWaitMs }));
  app.decorate('cohortOutcomesJob', new CohortOutcomesJob({ db: deps.db, screening: screeningDeps, now: deps.now ?? Date.now, log: app.log }));
  app.decorate('reconciler', new Reconciler({ db: deps.db, adapters, rdap: deps.rdap ?? rdapStatus, now: deps.now ?? Date.now, log: app.log }));
  app.decorate('nsVerifier', new NsVerifier({ db: deps.db, nsLookup, now: deps.now ?? Date.now, log: app.log }));
  app.decorate('dropJob', new DropJob({ db: deps.db, now: deps.now ?? Date.now, log: app.log }));
  app.decorate('priceJob', new PriceScheduleJob({ db: deps.db, now: deps.now ?? Date.now, log: app.log }));
  app.decorate('jobRunner', new JobRunner({
    db: deps.db, now: deps.now ?? Date.now, reconciler: app.reconciler, nsVerifier: app.nsVerifier, priceJob: app.priceJob,
    dropJob: app.dropJob, registrarCheckJob: app.registrarCheckJob, portfolioCheckJob: app.portfolioCheckJob, dropWatchJob: app.dropWatchJob, intakeScreeningJob: app.intakeScreeningJob, buildDailyListJob: app.buildDailyListJob, cohortOutcomesJob: app.cohortOutcomesJob, screeningWorker, backupExport: deps.backupExport, referenceRefresh,
    outsideReview: async () => {
      const r = await runReview({ ...reviewDeps, db: deps.db, secretValues: deps.config.secretValues, version: deps.config.version }, { trigger: 'scheduled', now: (deps.now ?? Date.now)() });
      return 'skipped' in r ? { skipped: true, reason: r.skipped, ...(r.category ? { category: r.category } : {}) } : r;
    },
    postsRefresh: async () => postsRefresh(postingDeps),
    reviewRetry: async () => {
      const r = await retryReview({ ...reviewDeps, db: deps.db, secretValues: deps.config.secretValues, version: deps.config.version }, { now: (deps.now ?? Date.now)() });
      return 'skipped' in r ? { skipped: true, reason: r.skipped } : r;
    },
    secretValues: deps.config.secretValues,
  }));
  registerJobs(app, app.jobRunner, { db: deps.db, now: deps.now ?? Date.now, config: deps.config, priceJob: app.priceJob, dropJob: app.dropJob });
  deps.registerExtraRoutes?.(app);
  return app;
}
