import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Kysely } from 'kysely';
import { registerBuy, smallBuyView, registerTranches, BuyService, Reconciler } from './modules/buying/index.js';
import { registerPricing, registerList, registerVenue, registerExport, registerAfternicPush, AfternicClient, AfternicPushService, ExportService, ListService } from './modules/listing/index.js';
import { registerOffers, registerSold, SoldService, OffersService } from './modules/selling/index.js';
import { DB_SIZE_WARN_PERCENT, NEON_FREE_STORAGE_BYTES, registerBooks, registerDecisions, registerOutcomes, registerReads, registerReport } from './modules/reporting/index.js';
import { registerDemand, registerSelection, registerSiblingScan, registerScreening, registerTestSets, registerPacks, ScreeningWorker, type ScreeningDeps, type HoldoutCheck } from './modules/selection/index.js';
import { registerCheck, createAdapters, type RegistrarAdapter, CheckService } from './modules/registrars/index.js';
import { AfternicSyncJob, ListingSyncJob, PortfolioLifecycleJob, SellerHubClient, registerHealth, registerCloseouts, registerAuctions, registerReplay, ReplayRunner, registerPortfolioImport, registerPortfolioWrites, registerTokens, RegistrarCheckJob, PortfolioCheckJob, DropWatchJob, CohortOutcomesJob, NsVerifier, DropJob, ReferenceRefreshJob, RetentionJob, PriceScheduleJob, registerJobs, registerSnapshots, registerLookups, DatasaveJob, DYNADOT_CLOSEOUTS_DEFAULT_PATH, JobQueue, JobRunner, type BackupExport } from './modules/ops/index.js';
import dns from 'node:dns';
import { queryDns, queryNs, type NsLookup } from './core/ns-lookup.js';
import type { Config } from './config.js';
import type { Database } from './db/types.js';
import { registerDbScope, registerDbStatsLog } from './http/db-stats.js';
import { dbAuditWriter, auditFrameworkError, registerAuditId, registerAuditWrite, type AuditWriter } from './http/audit.js';
import { registerAuth, registerScope } from './http/auth.js';
import { registerIdempotency } from './http/idempotency.js';
import { registerRateLimit } from './http/rate-limit.js';
import { registerErrorHandling } from './http/errors.js';
import { jerusalemDeep } from './core/dates.js';
import { rdapLookup, rdapStatus, type RdapFn } from './core/rdap.js';
import { cachedRdapLookup } from './core/rdap-cache.js';
import { registerDropLists, registerCohorts, registerCandidates, registerLessons, registerPatterns, IntakeScreeningJob, autoRebuildDailyList, BuildDailyListJob } from './modules/candidates/index.js';
import { registerEmails, registerCompany } from './modules/outreach/index.js';
import { EndingsJob, EngineTrainer, LiftTrainJob, registerEngine, Scorer, type TrainDeps } from './modules/engine/index.js';
import { registerData } from './modules/data/index.js';
import { KbLoadJob, registerKnowledge } from './modules/knowledge/index.js';
import { registerMarket } from './modules/market/index.js';
import { registerPickproof } from './modules/pickproof/index.js';
import { importAfternic, registerVisits } from './modules/visits/index.js';
import { collectOpenApiRoutes, registerOpenApi } from './http/openapi.js';

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
    listingSyncJob: ListingSyncJob;
    afternicSyncJob: AfternicSyncJob;
    portfolioLifecycleJob: PortfolioLifecycleJob;
    referenceRefreshJob: ReferenceRefreshJob;
    jobRunner: JobRunner;
    jobQueue: JobQueue;
    replayRunner: ReplayRunner;
    screeningWorker: ScreeningWorker;
  }
}

export interface AppDeps {
  /** v5.43.0 (CR-078): the folder of the repo knowledge files the daily step kbLoad reads (default data/knowledge next to the build). Tests pass a fixture folder. */
  knowledgeDir?: string;
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
  /** Tests: smaller training parameters, a shorter bootstrap, a time source for the budget guard. */
  engineTrain?: Partial<Pick<TrainDeps, 'clock' | 'budgetMs' | 'gbmParams' | 'tierParams' | 'bootstrapResamples' | 'minTrainPerClass' | 'minTestPerClass'>>;
  /** Tests: the size guard of the engine uploads (limit, and a fake size reader). */
  engineDbSize?: { limitBytes?: number; bytes?: () => Promise<number> };
  /** Tests: the budget for live registry asks in POST /score and its time source. */
  engineScore?: { budgetMs?: number; clock?: () => number };
  /** Test-only: replaces the screening checks' outside access (RDAP, DNS, fetch). Production passes nothing. */
  screening?: Partial<Omit<ScreeningDeps, 'checkService'>>;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const now = deps.now ?? Date.now;
  const base = { db: deps.db, now };
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

  const openApiRoutes = collectOpenApiRoutes(app); // v3.3.0 (CR-023 F): before any route is registered
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
  registerDbScope(app); // onRequest (very first: v5.40.0 query counter)
  registerAuditId(app); // onRequest (first)
  registerAuth(app, deps.db, deps.config.jobTriggerToken, deps.now); // onRequest
  registerRateLimit(app, deps.now, deps.db); // preHandler (first, so a 429 never claims an idempotency key)
  registerScope(app); // preHandler
  registerIdempotency(app, deps.db); // preHandler (after scope) + onSend (before audit write)
  registerAuditWrite(app, auditWriter); // onSend (last)
  registerDbStatsLog(app); // onSend (after the audit write, so its insert is counted)

  registerHealth(app, deps.config, deps.db, now, () => app.jobQueue.kickIfNeeded());
  const adapters = deps.adapters ?? createAdapters(deps.config);
  const checkService = new CheckService({
    db: deps.db,
    adapters,
    rdap: deps.rdap ?? rdapStatus,
    now,
    quoteTimeoutMs: deps.quoteTimeoutMs,
    log: app.log,
  });
  registerCheck(app, checkService);
  const buyService = new BuyService({
    db: deps.db, adapters, checkService, rdap: deps.rdap ?? rdapStatus, now,
    sleep: deps.sleep, log: app.log,
  });
  registerBuy(app, buyService);
  const exportService = new ExportService({ db: deps.db, config: deps.config, now, lockTimeoutMs: deps.exportLockTimeoutMs });
  registerExport(app, exportService);
  const afternicClient = deps.config.afternic.apiKey && deps.config.afternic.apiSecret
    ? new AfternicClient({ fetch: globalThis.fetch, baseUrl: deps.config.afternic.baseUrl, apiKey: deps.config.afternic.apiKey, apiSecret: deps.config.afternic.apiSecret, sleep: deps.sleep })
    : null;
  registerAfternicPush(app, new AfternicPushService({ db: deps.db, client: afternicClient, exports: exportService, now }));
  registerPricing(app, base);
  const nsLookup: NsLookup = deps.nsLookup ?? ((d: string) => queryNs(d, { server: deps.config.dnsNsServer }));
  registerList(app, new ListService({ db: deps.db, adapters, config: deps.config, nsLookup, now }));
  registerVenue(app, base);
  registerOffers(app, new OffersService(base), base);
  registerReport(app, base);
  registerPortfolioWrites(app, base);
  registerTokens(app, base);
  registerOutcomes(app, base);
  registerReads(app, base);
  registerBooks(app, base);
  registerDecisions(app, base);
  const sellerhub = deps.config.sellerhub.apiKey && deps.config.sellerhub.apiSecret
    ? new SellerHubClient({ fetch: globalThis.fetch, baseUrl: deps.config.sellerhub.baseUrl, apiKey: deps.config.sellerhub.apiKey, apiSecret: deps.config.sellerhub.apiSecret })
    : null;
  const listingSync = new ListingSyncJob({ db: deps.db, client: sellerhub, now, secretValues: deps.config.secretValues, log: app.log });
  app.decorate('listingSyncJob', listingSync);
  app.decorate('afternicSyncJob', new AfternicSyncJob({ db: deps.db, client: afternicClient, now, recordViews: (o) => importAfternic(deps.db, o) }));
  registerSold(app, new SoldService({ ...base, afterSold: async (d) => { await listingSync.delist(d); } }));
  registerSelection(app, { ...base, holdoutCheck: deps.holdoutCheck, smallBuy: () => Promise.resolve(smallBuyView()) });
  const screeningDeps: ScreeningDeps = {
    fetch: globalThis.fetch, sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), checkService,
    rdapLookup, dnsQuery: queryDns,
    resolveNs: (zone) => dns.promises.resolveNs(zone),
    resolve4: (host) => dns.promises.resolve4(host),
    webRiskApiKey: deps.config.webRiskApiKey,
    companiesHouseApiKey: deps.config.companiesHouseApiKey,
    namebio: { ...(deps.config.namebio.retailstatsCsvUrl && { retailstatsCsvUrl: deps.config.namebio.retailstatsCsvUrl }), },
    ...deps.screening,
  };
  registerPortfolioImport(app, { db: deps.db, adapters, now, rdapLookup: screeningDeps.rdapLookup });
  registerDemand(app, base);
  registerSiblingScan(app, { ...base, screening: screeningDeps });
  const screeningWorker = new ScreeningWorker({
    ...base, log: app.log,
    stopAfterResults: deps.screeningStopAfterResults,
    screening: screeningDeps,
  });
  app.decorate('screeningWorker', screeningWorker);
  app.addHook('onClose', async () => screeningWorker.idle());
  // CR-018 A: the day's list is rebuilt when the day's intake screening run ends (a run resumed after a restart included).
  screeningWorker.onFinished(async (runId) => { await autoRebuildDailyList({ db: deps.db, worker: screeningWorker, now }, runId); });
  registerScreening(app, { ...base, worker: screeningWorker });
  registerTestSets(app, { ...base, worker: screeningWorker });
  registerDropLists(app, base);
  registerCohorts(app, { ...base, worker: screeningWorker });
  registerPatterns(app, base);
  registerLessons(app, base);
  const engineTrainer = new EngineTrainer({
    ...base, log: app.log, ...deps.engineTrain,
    enqueue: async (trainId, by) => { const r = await app.jobQueue.enqueue('train', { trigger: 'manual', triggeredBy: by, params: { train_id: trainId } }); app.jobQueue.kick(); return r; },
  });
  const engineScorer = new Scorer({ ...base, screening: screeningDeps, log: app.log, ...deps.engineScore });
  registerEngine(app, { ...base, trainer: engineTrainer, scorer: engineScorer, dbSize: { limitBytes: deps.engineDbSize?.limitBytes ?? NEON_FREE_STORAGE_BYTES, warnPercent: DB_SIZE_WARN_PERCENT, bytes: deps.engineDbSize?.bytes } });
  registerData(app, { ...base, dbSize: { limitBytes: deps.engineDbSize?.limitBytes ?? NEON_FREE_STORAGE_BYTES, warnPercent: DB_SIZE_WARN_PERCENT, bytes: deps.engineDbSize?.bytes } });
  registerVisits(app, { db: deps.db, now, adapters, publicBaseUrl: deps.config.publicBaseUrl, nsLookup });
  registerCandidates(app, { ...base, worker: screeningWorker, queue: () => app.jobQueue });
  registerEmails(app, base);
  registerCompany(app, { ...base, secretValues: deps.config.secretValues });
  registerPacks(app, base);
  registerTranches(app, base);
  const referenceRefresh = new ReferenceRefreshJob({ db: deps.db, screening: screeningDeps, now, log: app.log });
  app.decorate('referenceRefreshJob', referenceRefresh);
  const retention = new RetentionJob({ ...base, log: app.log });
  app.decorate('registrarCheckJob', new RegistrarCheckJob({ db: deps.db, adapters, now, log: app.log }));
  app.decorate('portfolioCheckJob', new PortfolioCheckJob({ db: deps.db, rdapLookup: cachedRdapLookup(deps.db, screeningDeps.rdapLookup, { now, ttlMs: 0 }), screening: screeningDeps, now, log: app.log }));
  app.decorate('dropWatchJob', new DropWatchJob({ db: deps.db, screening: screeningDeps, now, log: app.log }));
  app.decorate('intakeScreeningJob', new IntakeScreeningJob({ db: deps.db, worker: screeningWorker, now }));
  app.decorate('buildDailyListJob', new BuildDailyListJob({ db: deps.db, worker: screeningWorker, now, waitMs: deps.dailyListWaitMs }));
  app.decorate('cohortOutcomesJob', new CohortOutcomesJob({ db: deps.db, screening: screeningDeps, now, log: app.log }));
  app.decorate('portfolioLifecycleJob', new PortfolioLifecycleJob({ db: deps.db, screening: screeningDeps, now, log: app.log }));
  app.decorate('reconciler', new Reconciler({ db: deps.db, adapters, now, log: app.log }));
  app.decorate('nsVerifier', new NsVerifier({ db: deps.db, nsLookup, now, log: app.log }));
  app.decorate('dropJob', new DropJob({ ...base, log: app.log }));
  app.decorate('priceJob', new PriceScheduleJob({ ...base, log: app.log }));
  app.decorate('jobRunner', new JobRunner({
    ...base, reconciler: app.reconciler, nsVerifier: app.nsVerifier, priceJob: app.priceJob,
    dropJob: app.dropJob, listingSyncJob: app.listingSyncJob, afternicSyncJob: app.afternicSyncJob, portfolioLifecycleJob: app.portfolioLifecycleJob, registrarCheckJob: app.registrarCheckJob, portfolioCheckJob: app.portfolioCheckJob, dropWatchJob: app.dropWatchJob, intakeScreeningJob: app.intakeScreeningJob, buildDailyListJob: app.buildDailyListJob, cohortOutcomesJob: app.cohortOutcomesJob, screeningWorker, backupExport: deps.backupExport, referenceRefresh, kbLoad: new KbLoadJob({ db: deps.db, now, dir: deps.knowledgeDir, log: app.log }), retention, datasaveJob: new DatasaveJob({ db: deps.db, now, snapshotDir: deps.config.snapshotDir, archiveDir: deps.config.archiveDir, dynadotKey: deps.config.env.DYNADOT_API_KEY || undefined, dynadotSecret: deps.config.env.DYNADOT_API_SECRET || undefined, dynadotCloseoutsPath: deps.config.env.DYNADOT_CLOSEOUTS_PATH || DYNADOT_CLOSEOUTS_DEFAULT_PATH, scorer: engineScorer, log: app.log, screening: screeningDeps, dbSize: { limitBytes: deps.engineDbSize?.limitBytes ?? NEON_FREE_STORAGE_BYTES, warnPercent: DB_SIZE_WARN_PERCENT, bytes: deps.engineDbSize?.bytes } }), engineEndingsJob: new EndingsJob({ db: deps.db, screening: screeningDeps, now, log: app.log }), engineTrainer, liftTrainJob: new LiftTrainJob({ db: deps.db, now, log: app.log }),
    secretValues: deps.config.secretValues,
  }));
  app.decorate('jobQueue', new JobQueue({ ...base, runner: app.jobRunner, log: app.log, overrides: deps.jobQueueOverrides,
    resumeScreening: (atStart) => screeningWorker.resumeStalled({ atStart }),
    keepAlive: deps.jobQueueKeepAlive ?? (deps.config.appEnv === 'production' && deps.config.onRender && deps.config.publicBaseUrl ? { url: deps.config.publicBaseUrl } : undefined) }));
  // Closing the app waits for the step in flight, so nothing touches the database after it is closed. Unfinished runs resume at start (main.ts) or on the next GET.
  app.addHook('onClose', async () => app.jobQueue.stop());
  registerSnapshots(app, { db: deps.db, now });
  registerLookups(app, { db: deps.db, now, rdapLookup: screeningDeps.rdapLookup });
  registerCloseouts(app, { db: deps.db, now, scorer: engineScorer });
  registerAuctions(app, { db: deps.db, now, screening: screeningDeps });
  const replayDeps = { db: deps.db, now, archiveDir: deps.config.archiveDir, log: app.log };
  app.decorate('replayRunner', new ReplayRunner(replayDeps));
  app.addHook('onClose', async () => app.replayRunner.idle());
  registerReplay(app, { runner: app.replayRunner, run: replayDeps });
  registerMarket(app, { db: deps.db, now });
  registerKnowledge(app, { db: deps.db, now, dbSize: { limitBytes: deps.engineDbSize?.limitBytes ?? NEON_FREE_STORAGE_BYTES, warnPercent: DB_SIZE_WARN_PERCENT, bytes: deps.engineDbSize?.bytes } });
  registerPickproof(app, { db: deps.db, now });
  registerJobs(app, app.jobQueue, { ...base, config: deps.config, priceJob: app.priceJob, dropJob: app.dropJob });
  registerOpenApi(app, openApiRoutes, deps.config.version);
  deps.registerExtraRoutes?.(app);
  return app;
}
