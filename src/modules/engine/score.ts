// POST /score (CR-056 part 2): reads the active model and the stored facts, asks the registries live only for endings it has no answer for
// (inside a time budget; what is not answered in time stays unknown, never guessed), and returns the score block per name. The only write is the
// caching of those registry answers in engine_endings. The same input gives the same output.
import { sql, type Kysely } from 'kysely';
import { idtDay } from '../../core/dates.js';
import type { Database } from '../../db/types.js';
import { hostPacer, type ScreeningDeps } from '../selection/index.js';
import { baseSplitTable, loadDemand, loadEndings, loadSales, loadUnsold, tokenContext } from './data.js';
import { askRdap, endingBase, ENGINE_TLDS, saveAnswer, type EndingTld, type Pair } from './endings.js';
import { computeFeatures, ENDING_FEATURE_TLDS, extendedTable, FEATURE_NAMES, sldOf, toVector, type EndingFact, type FeatureContext } from './features.js';
import { gbmProba } from './model/gbm.js';
import { percentileIn } from './model/metrics.js';
import { reasonsFor, type Reason } from './reasons.js';
import { TIERS, type ModelParams } from './train.js';

export const SCORE_MAX_DOMAINS = 500;
/** Time allowed for live registry asks in one call; names not answered by then are unknown. */
export const SCORE_LIVE_BUDGET_MS = 4_000;
const LIVE_CONCURRENCY = 4;
const LIVE_LOOKUP_TIMEOUT_MS = 3_000;

export interface ActiveModel { id: string; trainedAt: Date; params: ModelParams }

export interface ScoreDeps {
  db: Kysely<Database>; now: () => number; screening: ScreeningDeps;
  budgetMs?: number; clock?: () => number; log?: { warn(o: object, m: string): void };
}

export interface ScoreResult {
  domain: string; score: number; percentile_vs_dropped: number | null; percentile_vs_sold: number | null; in_regime: boolean; warning?: string;
  price_tier: Record<(typeof TIERS)[number], number> | null; reasons: Reason[];
  likely_buyers: { host: string; registered: string; source: 'rdap'; live_business?: boolean }[];
  features: Record<string, number | string | null>; features_as_of: string; model_version: string;
}

const r4 = (x: number): number => Math.round(x * 10_000) / 10_000;
export const OUT_OF_REGIME_WARNING = 'Outside the regime the model was tested on (letters only, 6 to 20 characters, 2 to 3 known words); the score is less reliable.';

export class Scorer {
  private cachedModel: ActiveModel | null = null;
  private cachedTokens: { key: string; tokens: FeatureContext['tokens'] } | null = null;
  constructor(private readonly deps: ScoreDeps) {}

  /** The newest finished model (parameters parsed once and kept while it stays the newest). */
  async activeModel(): Promise<ActiveModel | null> {
    const { db } = this.deps;
    const head = await db.selectFrom('engine_models').select(['id', 'finished_at', 'created_at']).where('status', '=', 'done').orderBy('n', 'desc').limit(1).executeTakeFirst();
    if (!head) return null;
    if (this.cachedModel?.id === head.id) return this.cachedModel;
    const full = await db.selectFrom('engine_models').select(['id', 'params', 'finished_at', 'created_at']).where('id', '=', head.id).executeTakeFirstOrThrow();
    if (full.params === null) return null; // cleared parameters (not the newest four): cannot happen for the newest model
    this.cachedModel = { id: full.id, trainedAt: full.finished_at ?? full.created_at, params: full.params as ModelParams };
    return this.cachedModel;
  }

  private async tokenIndex(model: ActiveModel, table: ReturnType<typeof extendedTable>): Promise<FeatureContext['tokens']> {
    const { db } = this.deps;
    // the key follows the upload history: every upload (sales or unsold) is one engine_uploads row written in the same transaction as its rows
    const k = await sql<{ n: string }>`select coalesce(max(id), 0)::text as n from engine_uploads`.execute(db);
    const key = `${model.id}|${k.rows[0]!.n}`;
    if (this.cachedTokens?.key === key) return this.cachedTokens.tokens;
    const [sales, unsold] = [await loadSales(db), await loadUnsold(db)];
    const tokens = tokenContext(sales, unsold, table);
    tokens.tokRateEnabled = model.params.tok_rate_enabled; // scoring follows the model: it was trained with or without the token rate
    this.cachedTokens = { key, tokens };
    return tokens;
  }

  /** Asks the registries for the (name, ending) pairs with no answer, in parallel per registry, inside the time budget. */
  private async fillLive(names: string[], endings: Awaited<ReturnType<typeof loadEndings>>): Promise<void> {
    const { db, now, screening } = this.deps;
    const clock = this.deps.clock ?? Date.now;
    const deadline = clock() + (this.deps.budgetMs ?? SCORE_LIVE_BUDGET_MS);
    const byTld = new Map<EndingTld, Pair[]>();
    for (const name of names) {
      for (const tld of ENGINE_TLDS) {
        const f = endings.get(name)?.[tld];
        if (f && f.registered !== null) continue;
        (byTld.get(tld) ?? byTld.set(tld, []).get(tld)!).push({ name, tld, prevId: f?.id ?? null, prevRegistered: f ? f.registered : null });
      }
    }
    await Promise.all([...byTld.entries()].map(async ([tld, pairs]) => {
      const base = await endingBase(db, screening, now, tld, this.deps.log);
      if (!base) return;
      const pace = hostPacer(new URL(base).host, screening.sleep);
      let next = 0;
      const worker = async () => {
        for (;;) {
          const left = deadline - clock();
          if (left <= 0 || pace.breakerOpen) return;
          const p = pairs[next++];
          if (!p) return;
          const a = await askRdap(screening, `${p.name}.${tld}`, base, pace, Math.max(200, Math.min(LIVE_LOOKUP_TIMEOUT_MS, left)));
          await saveAnswer(db, now(), p, a);
          const m = endings.get(p.name) ?? endings.set(p.name, {}).get(p.name)!;
          m[tld] = { registered: a.registered, createdMs: a.createdAt ? a.createdAt.getTime() : null } as EndingFact;
        }
      };
      await Promise.all(Array.from({ length: LIVE_CONCURRENCY }, worker));
    }));
  }

  async score(domains: string[], asOfIn?: string): Promise<{ model_version: string; results: ScoreResult[] } | null> {
    const { db, now } = this.deps;
    const model = await this.activeModel();
    if (!model) return null;
    const p = model.params;
    const asOf = asOfIn ?? idtDay(now());
    const table = extendedTable(baseSplitTable(), p.extra_terms);
    const tokens = await this.tokenIndex(model, table);
    const unique = [...new Set(domains)];
    const names = unique.map(sldOf);
    const endings = await loadEndings(db, names);
    await this.fillLive(names, endings);
    const ctx0: FeatureContext = { table, tokens, endings, demand: new Map() };
    // keyword demand only for the names' readings
    const kws = [...new Set(unique.map((d) => computeFeatures(ctx0, d, asOf).words.join(' ')).filter((k) => k !== ''))];
    const ctx: FeatureContext = { ...ctx0, demand: await loadDemand(db, kws) };
    const scans = new Map<string, { domain: string; live_business: boolean | null }[]>();
    if (unique.length) {
      const rows = await sql<{ domain: string; siblings: { domain: string; live_business: boolean | null }[] }>`select distinct on (domain) domain, siblings from sibling_scans where domain = any(${unique}) order by domain, id desc`.execute(db);
      for (const r of rows.rows) scans.set(r.domain, Array.isArray(r.siblings) ? r.siblings : []);
    }
    const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
    const results: ScoreResult[] = unique.map((domain) => {
      const nf = computeFeatures(ctx, domain, asOf);
      const x = toVector(nf.values, p.features);
      const prob = gbmProba(p.gbm, x)[0]!;
      const tier = p.tier ? gbmProba(p.tier, x) : null;
      const facts = endings.get(sldOf(domain)) ?? {};
      const siblings = scans.get(domain) ?? [];
      const buyers: ScoreResult['likely_buyers'] = [];
      for (const tld of ENDING_FEATURE_TLDS) {
        const f = facts[tld];
        if (!f || f.registered !== true || f.createdMs === null || f.createdMs >= asOfMs) continue;
        const host = `${sldOf(domain)}.${tld}`;
        const live = siblings.find((s) => s.domain === host)?.live_business;
        buyers.push({ host, registered: new Date(f.createdMs).toISOString().slice(0, 10), source: 'rdap', ...(typeof live === 'boolean' ? { live_business: live } : {}) });
      }
      const features: ScoreResult['features'] = Object.fromEntries(FEATURE_NAMES.map((n) => [n, nf.values[n] === null ? null : r4(nf.values[n]!)]));
      features.acq = nf.acq;
      return {
        domain, score: r4(prob), percentile_vs_dropped: percentileIn(p.quantiles.dropped, prob), percentile_vs_sold: percentileIn(p.quantiles.sold, prob),
        in_regime: nf.inRegime, ...(nf.inRegime ? {} : { warning: OUT_OF_REGIME_WARNING }),
        price_tier: tier ? { lt1k: r4(tier[0]!), '1k_5k': r4(tier[1]!), '5k_25k': r4(tier[2]!), gt25k: r4(tier[3]!) } : null,
        reasons: reasonsFor(p.logit, p.features, x, nf.values, asOf), likely_buyers: buyers, features, features_as_of: asOf, model_version: model.id,
      };
    });
    const byDomain = new Map(results.map((r) => [r.domain, r]));
    return { model_version: model.id, results: domains.map((d) => byDomain.get(d)!) };
  }
}

