import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Kysely } from 'kysely';
import { registerBuy } from './api/buy.js';
import { registerPricing } from './api/pricing.js';
import { registerList } from './api/list.js';
import { registerOffers } from './api/offers.js';
import { registerReads } from './api/reads.js';
import { registerReport } from './api/report.js';
import { registerSold } from './api/sold.js';
import { SoldService } from './services/sold.js';
import { OffersService } from './services/offers.js';
import { registerExport } from './api/export.js';
import { registerCheck } from './api/check.js';
import { registerHealth } from './api/health.js';
import { queryNs, type NsLookup } from './dns/ns-lookup.js';
import type { Config } from './config.js';
import type { Database } from './db/types.js';
import { dbAuditWriter, auditFrameworkError, registerAuditId, registerAuditWrite, type AuditWriter } from './http/audit.js';
import { registerAuth, registerScope } from './http/auth.js';
import { registerIdempotency } from './http/idempotency.js';
import { registerRateLimit } from './http/rate-limit.js';
import { errorBody, registerErrorHandling } from './http/errors.js';
import { rdapStatus, type RdapFn } from './rdap.js';
import { registerPayouts } from './api/payouts.js';
import { PayoutsService } from './services/payouts.js';
import { RegistrarCheckJob } from './jobs/registrar-check.js';
import { createAdapters } from './registrars/registry.js';
import type { RegistrarAdapter } from './registrars/types.js';
import { BuyService } from './services/buy.js';
import { CheckService } from './services/check.js';
import { ExportService } from './services/export.js';
import { ListService } from './services/list.js';
import { NsVerifier } from './jobs/ns-verify.js';
import { DropJob } from './jobs/drop.js';
import { PriceScheduleJob } from './jobs/price-schedule.js';
import { registerJobs } from './api/jobs.js';
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
    jobRunner: JobRunner;
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
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const auditWriter = deps.audit ?? dbAuditWriter(deps.db);
  const app = Fastify({
    logger: deps.logger ?? { level: deps.config.logLevel, redact: ['req.headers.authorization'] },
    trustProxy: (_addr: string, hop: number) => hop < 1, // trust exactly 1 proxy hop (Render); 'true' would trust a forged X-Forwarded-For in audit client_ip
    bodyLimit: 64 * 1024,
    // Framework errors bypass all hooks; see auditFrameworkError.
    frameworkErrors: (err, req, reply) => auditFrameworkError(auditWriter, err, req, reply),
  });

  const routeTable: { method: string; url: string }[] = [];
  app.decorate('routeTable', routeTable);
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) routeTable.push({ method, url: r.url });
  });

  registerErrorHandling(app);
  registerAuditId(app); // onRequest (first)
  registerAuth(app, deps.db, deps.config.jobTriggerToken); // onRequest
  registerRateLimit(app, deps.now); // preHandler (first, so a 429 never claims an idempotency key)
  registerScope(app); // preHandler
  registerIdempotency(app, deps.db); // preHandler (after scope) + onSend (before audit write)
  registerAuditWrite(app, auditWriter); // onSend (last)

  registerHealth(app, deps.config, deps.db);
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
  registerPayouts(app, new PayoutsService({ db: deps.db, now: deps.now ?? Date.now }));
  app.decorate('registrarCheckJob', new RegistrarCheckJob({ db: deps.db, adapters, now: deps.now ?? Date.now, log: app.log }));
  app.decorate('reconciler', new Reconciler({ db: deps.db, adapters, rdap: deps.rdap ?? rdapStatus, now: deps.now ?? Date.now, log: app.log }));
  app.decorate('nsVerifier', new NsVerifier({ db: deps.db, nsLookup, now: deps.now ?? Date.now, log: app.log }));
  app.decorate('dropJob', new DropJob({ db: deps.db, now: deps.now ?? Date.now, log: app.log }));
  app.decorate('priceJob', new PriceScheduleJob({ db: deps.db, now: deps.now ?? Date.now, log: app.log }));
  app.decorate('jobRunner', new JobRunner({
    db: deps.db, now: deps.now ?? Date.now, reconciler: app.reconciler, nsVerifier: app.nsVerifier, priceJob: app.priceJob,
    dropJob: app.dropJob, registrarCheckJob: app.registrarCheckJob, backupExport: deps.backupExport,
    secretValues: deps.config.secretValues,
  }));
  registerJobs(app, app.jobRunner);
  deps.registerExtraRoutes?.(app);
  return app;
}
