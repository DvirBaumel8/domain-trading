import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Kysely } from 'kysely';
import { registerBuy } from './modules/buying/index.js';
import { registerPricing } from './modules/listing/index.js';
import { registerList } from './modules/listing/index.js';
import { registerOffers, registerSold, SoldService, OffersService } from './modules/selling/index.js';
import { registerReads, registerReport } from './modules/reporting/index.js';
import { registerSelection } from './modules/selection/index.js';
import { registerScreening } from './modules/selection/index.js';
import { registerTestSets } from './modules/selection/index.js';
import { registerPacks } from './modules/selection/index.js';
import { registerTranches } from './modules/buying/index.js';
import { ScreeningWorker } from './modules/selection/index.js';
import type { ScreeningDeps } from './modules/selection/index.js';
import type { HoldoutCheck } from './modules/selection/index.js';
import { registerExport } from './modules/listing/index.js';
import { registerCheck } from './modules/registrars/index.js';
import { registerHealth } from './modules/ops/index.js';
import dns from 'node:dns';
import { queryDns, queryNs, type NsLookup } from './core/ns-lookup.js';
import type { Config } from './config.js';
import type { Database } from './db/types.js';
import { dbAuditWriter, auditFrameworkError, registerAuditId, registerAuditWrite, type AuditWriter } from './http/audit.js';
import { registerAuth, registerScope } from './http/auth.js';
import { registerIdempotency } from './http/idempotency.js';
import { registerRateLimit } from './http/rate-limit.js';
import { registerErrorHandling } from './http/errors.js';
import { jerusalemDeep } from './core/dates.js';
import { rdapLookup, rdapStatus, type RdapFn } from './core/rdap.js';
import { RegistrarCheckJob } from './modules/ops/index.js';
import { PortfolioCheckJob } from './modules/ops/index.js';
import { DropWatchJob } from './modules/ops/index.js';
import { CohortOutcomesJob } from './modules/ops/index.js';
import { registerDropLists } from './modules/candidates/index.js';
import { registerCohorts } from './modules/candidates/index.js';
import { registerCompany, registerPosts, BufferClient, postsRefresh, type PostingDeps, registerReviews, retryReview, runReview } from './modules/outreach/index.js';
import { registerCandidates } from './modules/candidates/index.js';
import { createAdapters } from './modules/registrars/index.js';
import type { RegistrarAdapter } from './modules/registrars/index.js';
import { BuyService } from './modules/buying/index.js';
import { CheckService } from './modules/registrars/index.js';
import { ExportService } from './modules/listing/index.js';
import { ListService } from './modules/listing/index.js';
import { NsVerifier } from './modules/ops/index.js';
import { DropJob } from './modules/ops/index.js';
import { ReferenceRefreshJob } from './modules/ops/index.js';
import { PriceScheduleJob } from './modules/ops/index.js';
import { registerJobs } from './modules/ops/index.js';
import { IntakeScreeningJob } from './modules/candidates/index.js';
import { BuildDailyListJob } from './modules/candidates/index.js';
import { JobQueue, JobRunner, type BackupExport } from './modules/ops/index.js';
import { Reconciler } from './modules/buying/index.js';

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
    jobQueue: JobQueue;
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
  /** Test hook: per-step overrides of the queue's attempts and timeout (applied when a run is enqueued). */
  /** Test hook: turns the queue's keep-alive ping on with a fake fetch (default: on only in production with PUBLIC_BASE_URL set). */
  jobQueueKeepAlive?: { url: string; fetch?: typeof fetch };
  jobQueueOverrides?: Record<string, { maxAttempts?: number; timeoutMs?: number }>;
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
  registerHealth(app, deps.config, deps.db, deps.now ?? Date.now, postingDeps, () => app.jobQueue.kickIfNeeded());
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
  const reviewDeps = { fetch: globalThis.fetch, apiKey: deps.config.geminiApiKey, ...(deps.sleep ? { sleep: deps.sleep } : {}) };
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
  app.decorate('jobQueue', new JobQueue({ db: deps.db, now: deps.now ?? Date.now, runner: app.jobRunner, log: app.log, overrides: deps.jobQueueOverrides,
    keepAlive: deps.jobQueueKeepAlive ?? (deps.config.appEnv === 'production' && deps.config.publicBaseUrl ? { url: deps.config.publicBaseUrl } : undefined) }));
  // Closing the app waits for the step in flight, so nothing touches the database after it is closed. Unfinished runs resume at start (main.ts) or on the next GET.
  app.addHook('onClose', async () => app.jobQueue.stop());
  registerJobs(app, app.jobQueue, { db: deps.db, now: deps.now ?? Date.now, config: deps.config, priceJob: app.priceJob, dropJob: app.dropJob });
  deps.registerExtraRoutes?.(app);
  return app;
}
