// CR-078: reading the base. Heads = the newest version of every row (a correction is a new version); evidence items for the verdict engine; verdict append; recheck; echo candidates.
import { createHash } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import { advisoryXactLock } from '../../core/locks.js';
import type { Database } from '../../db/types.js';
import { AppError } from '../../http/errors.js';
import { candidatePairs, estimatedJaccard } from './minhash.js';
import { activeKbSettings, GRADE_ORDER, halfLifeOf, type Grade, type KbSettings } from './settings.js';
import { computeVerdict, weightOf, type Item, type VerdictResult } from './verdict.js';

const DAY_MS = 86_400_000;
type SourceRow = Selectable<Database['kb_sources']>;
type ClaimRow = Selectable<Database['kb_claims']>;

function newest<T extends { version: number }>(rows: T[], key: (r: T) => string): Map<string, T> {
  const m = new Map<string, T>();
  for (const r of rows) { const k = key(r); const h = m.get(k); if (!h || r.version > h.version) m.set(k, r); }
  return m;
}

/** The kinds of link that put two sources in one independence cluster (`cites` does not: it adds analysis). */
export const CLUSTER_KINDS = ['echo_of', 'syndicated', 'same_author', 'aggregator_of'] as const;

export async function clusterEdges(db: Kysely<Database>): Promise<[number, number][]> {
  const rows = await db.selectFrom('kb_source_links').selectAll().execute();
  return [...newest(rows, (r) => `${r.from_source_id}|${r.to_source_id}|${r.kind}`).values()]
    .filter((r) => !r.retracted && (CLUSTER_KINDS as readonly string[]).includes(r.kind)).map((r) => [r.from_source_id, r.to_source_id] as [number, number]);
}

/** Claim heads (optionally only those linked to a question) with their evidence heads as engine items. */
export async function loadItems(db: Kysely<Database>, s: KbSettings, nowMs: number, questionId?: number): Promise<{ items: (Item & { claim: ClaimRow })[]; claims: ClaimRow[] }> {
  let claimRows: ClaimRow[];
  if (questionId === undefined) claimRows = await db.selectFrom('kb_claims').selectAll().execute();
  else {
    claimRows = await db.selectFrom('kb_claims').selectAll()
      .where('claim_key', 'in', (q) => q.selectFrom('kb_claims').select('claim_key').where(sql<boolean>`${questionId} = any(question_ids)`)).execute();
  }
  const claimHeads = [...newest(claimRows, (r) => r.claim_key).values()].filter((c) => questionId === undefined || c.question_ids.includes(questionId));
  const rootOfKey = new Map(claimRows.filter((r) => r.version === 1).map((r) => [r.claim_key, r.id]));
  const headByRoot = new Map(claimHeads.map((c) => [rootOfKey.get(c.claim_key)!, c]));
  if (headByRoot.size === 0) return { items: [], claims: claimHeads };
  const evAll: Selectable<Database['kb_evidence']>[] = [];
  const roots = [...headByRoot.keys()];
  for (let i = 0; i < roots.length; i += 1000) evAll.push(...await db.selectFrom('kb_evidence').selectAll().where('claim_id', 'in', roots.slice(i, i + 1000)).execute());
  const evidence = [...newest(evAll, (r) => `${r.source_id}|${r.claim_id}|${r.locator}`).values()];
  const srcIds = [...new Set(evidence.map((e) => e.source_id))];
  const rootSources: Selectable<Database['kb_sources']>[] = [];
  for (let i = 0; i < srcIds.length; i += 1000) rootSources.push(...await db.selectFrom('kb_sources').selectAll().where('id', 'in', srcIds.slice(i, i + 1000)).execute());
  const hashes = [...new Set(rootSources.map((r) => r.url_hash))];
  const srcRows: SourceRow[] = [];
  for (let i = 0; i < hashes.length; i += 1000) srcRows.push(...await db.selectFrom('kb_sources').selectAll().where('url_hash', 'in', hashes.slice(i, i + 1000)).execute());
  const srcHead = newest(srcRows, (r) => r.url_hash);
  const hashOfRoot = new Map(rootSources.map((r) => [r.id, r.url_hash]));
  const items: (Item & { claim: ClaimRow })[] = [];
  for (const e of evidence) {
    const claim = headByRoot.get(e.claim_id)!;
    const src = srcHead.get(hashOfRoot.get(e.source_id)!)!;
    const grade: Grade = e.claim_grade && GRADE_ORDER[e.claim_grade] < GRADE_ORDER[src.reliability] ? e.claim_grade : src.reliability;
    const ref = claim.date_range_end ? Date.parse(`${claim.date_range_end}T00:00:00Z`) : (src.published_at ?? src.retrieved_at).getTime();
    items.push({
      evidenceId: e.id, source: e.source_id, sourceUrl: src.url, sourceType: src.type, sourceStatus: src.status, conflict: src.conflict_of_interest, grade, claimKey: claim.claim_key,
      option: claim.option, stance: e.stance, credibility: e.credibility, sampleSize: e.sample_size, kind: e.evidence_kind, populationMatch: e.population_match, survivorship: e.survivorship,
      effectValue: e.effect_value, effectUnit: claim.effect_unit, halfLifeDays: halfLifeOf(s, claim), ageDays: (nowMs - ref) / DAY_MS, claim,
    });
  }
  return { items, claims: claimHeads };
}

const stableHash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');

export interface VerdictAnswer {
  question: { id: number; slug: string; text: string; options: string[]; population: string | null };
  verdict_id: number; appended: boolean; computed_at: string; settings_version: number; certainty: VerdictResult['certainty']; downgrades: string[];
  verdict: VerdictResult['verdict']; clusters: VerdictResult['clusters']; weight_for: number; weight_against: number; evidence_n: number;
}

/** Computes the verdict of a question now and appends a kb_verdicts row only when it differs from the latest stored one (same settings version, verdict, certainty, downgrades, clusters). */
export async function verdictFor(db: Kysely<Database>, questionId: number, nowMs: number, by: string): Promise<VerdictAnswer> {
  const q = await db.selectFrom('kb_questions').selectAll().where('id', '=', questionId).executeTakeFirst();
  if (!q) throw new AppError(404, 'KB_QUESTION_NOT_FOUND', `No question ${questionId}`);
  const settings = await activeKbSettings(db);
  const options = q.options as string[];
  const { items } = await loadItems(db, settings, nowMs, q.id);
  const edges = await clusterEdges(db);
  const res = computeVerdict({ options, items, edges, settings });
  const result_hash = stableHash({ v: settings.version, verdict: res.verdict, certainty: res.certainty, downgrades: res.downgrades, clusters: res.clusters.map((c) => [c.cluster_id, c.grade, c.stance, c.w, c.evidence_id]) });
  const snapshot = {
    settings_version: settings.version, question: { id: q.id, slug: q.slug, options },
    items: res.items.slice(0, 500).map((i) => ({ ...i, weight: { G: i.weight.G, C: i.weight.C, N: Math.round(i.weight.N * 1000) / 1000, R: Math.round(i.weight.R * 1000) / 1000, K: i.weight.K, w: Math.round(i.weight.w * 1000) / 1000 } })),
    items_total: res.items.length, edges_n: edges.length,
  };
  const row = await db.transaction().execute(async (trx) => {
    await advisoryXactLock(trx, 'kb_write');
    const last = await trx.selectFrom('kb_verdicts').selectAll().where('question_id', '=', q.id).orderBy('id', 'desc').limit(1).executeTakeFirst();
    if (last && last.result_hash === result_hash) return { row: last, appended: false };
    const ins = await trx.insertInto('kb_verdicts').values({
      question_id: q.id, computed_at: new Date(nowMs), settings_version: settings.version, result_hash, verdict: JSON.stringify(res.verdict), certainty: res.certainty,
      downgrades: JSON.stringify(res.downgrades), clusters_used: JSON.stringify(res.clusters), weight_for: res.weight_for, weight_against: res.weight_against, inputs_snapshot: JSON.stringify(snapshot), by,
    }).returningAll().executeTakeFirstOrThrow();
    return { row: ins, appended: true };
  });
  return {
    question: { id: q.id, slug: q.slug, text: q.text, options, population: q.population }, verdict_id: row.row.id, appended: row.appended,
    computed_at: new Date(row.appended ? nowMs : row.row.computed_at).toISOString(), settings_version: settings.version, certainty: res.certainty, downgrades: res.downgrades,
    verdict: res.verdict, clusters: res.clusters, weight_for: res.weight_for, weight_against: res.weight_against, evidence_n: items.length,
  };
}

export interface RecheckRow { claim_key: string; topic: string; statement: string; weighted_r: number; age_days: number; half_life_days: number; evidence_n: number; date_range_end: string | null; question_ids: number[] }

/** Claims whose age weight (the mean R of their evidence, weighted by w without age) has fallen below `recheck_r`; claims without usable evidence use their own date. */
export async function recheckList(db: Kysely<Database>, nowMs: number): Promise<{ settings_version: number; threshold: number; claims: RecheckRow[] }> {
  const s = await activeKbSettings(db);
  const { items, claims } = await loadItems(db, s, nowMs);
  const byClaim = new Map<string, typeof items>();
  for (const it of items) (byClaim.get(it.claimKey) ?? byClaim.set(it.claimKey, []).get(it.claimKey)!).push(it);
  const out: RecheckRow[] = [];
  for (const c of claims) {
    const its = byClaim.get(c.claim_key) ?? [];
    const hl = halfLifeOf(s, c);
    let r: number, age: number;
    const wts = its.map((i) => weightOf(i, s));
    const sum = wts.reduce((a, w) => a + w.wNoAge, 0);
    if (sum > 0) { r = wts.reduce((a, w) => a + w.R * w.wNoAge, 0) / sum; age = its.reduce((a, i, k) => a + i.ageDays * wts[k]!.wNoAge, 0) / sum; }
    else {
      const ref = c.date_range_end ? Date.parse(`${c.date_range_end}T00:00:00Z`) : c.created_at.getTime();
      age = (nowMs - ref) / DAY_MS; r = Math.pow(0.5, Math.max(0, age) / hl);
    }
    if (r < s.values.thresholds.recheck_r) out.push({ claim_key: c.claim_key, topic: c.topic, statement: c.statement, weighted_r: Math.round(r * 1000) / 1000, age_days: Math.round(age), half_life_days: hl, evidence_n: its.length, date_range_end: c.date_range_end, question_ids: c.question_ids });
  }
  out.sort((a, b) => a.weighted_r - b.weighted_r || (a.claim_key < b.claim_key ? -1 : 1));
  return { settings_version: s.version, threshold: s.values.thresholds.recheck_r, claims: out };
}

export interface EchoCandidate { a: { id: number; url: string; title: string | null }; b: { id: number; url: string; title: string | null }; jaccard: number }

/** Source pairs whose excerpts look alike (MinHash estimate at or above `echo_jaccard`) and that no link joins yet, strongest first. */
export async function echoCandidates(db: Kysely<Database>, limit: number): Promise<{ settings_version: number; threshold: number; pairs: EchoCandidate[]; sources_checked: number }> {
  const s = await activeKbSettings(db);
  const rows = await db.selectFrom('kb_sources').selectAll().execute();
  const heads = [...newest(rows, (r) => r.url_hash).values()].filter((r) => r.minhash !== null && r.status !== 'rejected');
  const rootOf = new Map(rows.filter((r) => r.version === 1).map((r) => [r.url_hash, r.id]));
  const links = await db.selectFrom('kb_source_links').select(['from_source_id', 'to_source_id']).execute();
  const linked = new Set(links.flatMap((l) => [`${l.from_source_id}|${l.to_source_id}`, `${l.to_source_id}|${l.from_source_id}`]));
  const out: EchoCandidate[] = [];
  for (const [i, j] of candidatePairs(heads.map((h) => h.minhash!))) {
    const a = heads[i]!, b = heads[j]!;
    const ra = rootOf.get(a.url_hash)!, rb = rootOf.get(b.url_hash)!;
    if (linked.has(`${ra}|${rb}`)) continue;
    const jac = estimatedJaccard(a.minhash!, b.minhash!);
    if (jac >= s.values.thresholds.echo_jaccard) out.push({ a: { id: ra, url: a.url, title: a.title }, b: { id: rb, url: b.url, title: b.title }, jaccard: Math.round(jac * 1000) / 1000 });
  }
  out.sort((x, y) => y.jaccard - x.jaccard || x.a.id - y.a.id || x.b.id - y.b.id);
  return { settings_version: s.version, threshold: s.values.thresholds.echo_jaccard, pairs: out.slice(0, limit), sources_checked: heads.length };
}
