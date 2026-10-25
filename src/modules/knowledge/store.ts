// CR-078: writing the six kinds. One function for the routes and the repo load: parse, resolve natural keys, decide per row
// (accepted / duplicate / superseded / rejected) and insert. All-or-nothing: any rejected row rejects the batch (KB_ROWS_REJECTED) and nothing is written.
// Append-only: a row that exists with other content is rejected unless it says `supersede: true`, which appends version + 1 with `supersedes` = the replaced row.
// References between rows always point at the first version (the root) of the row they name, so a later correction never breaks a link.
import type { Kysely } from 'kysely';
import { advisoryXactLock } from '../../core/locks.js';
import type { Database } from '../../db/types.js';
import { AppError } from '../../http/errors.js';
import { authorKeyOf, claimKeyOf, issueText, SCHEMAS, sourceCols, type Kind, type RowReject } from './rows.js';
import { GRADE_ORDER, type Grade, type KbSettings } from './settings.js';
import { canonicalUrl, urlHash } from './url.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = Kysely<any>;
type Cols = Record<string, unknown>;
export interface Ctx { by: string; auditId: string | null; now: Date; settings: KbSettings; dryRun: boolean }
export interface RowResult { row: number; outcome: 'accepted' | 'duplicate' | 'superseded'; id: number | null }
export interface KindResult { kind: Kind; received_n: number; accepted_n: number; duplicate_n: number; superseded_n: number; rows: RowResult[] }

interface Prepared { i: number; keyVals: unknown[]; cols: Cols; supersede: boolean }
interface Spec { table: string; keyCols: string[]; versioned: boolean }
const SPECS: Record<Kind, Spec> = {
  author: { table: 'kb_authors', keyCols: ['name_key'], versioned: true },
  source: { table: 'kb_sources', keyCols: ['url_hash'], versioned: true },
  question: { table: 'kb_questions', keyCols: ['slug'], versioned: false },
  claim: { table: 'kb_claims', keyCols: ['claim_key'], versioned: true },
  evidence: { table: 'kb_evidence', keyCols: ['source_id', 'claim_id', 'locator'], versioned: true },
  link: { table: 'kb_source_links', keyCols: ['from_source_id', 'to_source_id', 'kind'], versioned: true },
};
const JSON_COLS = new Set(['handles', 'options']);

function stable(v: unknown): string {
  if (v instanceof Date) return `d:${v.getTime()}`;
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${k}:${stable((v as Cols)[k])}`).join(',')}}`;
  return typeof v === 'number' ? `n:${v}` : JSON.stringify(v);
}
const same = (head: Cols, cols: Cols): boolean => Object.entries(cols).every(([k, v]) => v === undefined || stable(head[k]) === stable(v));

/** Parsed natural-key references: id of the first version of each named row. */
async function rootIds(db: AnyDb, table: string, col: string, values: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < values.length; i += 500) {
    const rows = await db.selectFrom(table).select(['id', col]).where('version', '=', 1).where(col, 'in', values.slice(i, i + 500)).execute();
    for (const r of rows) out.set(r[col] as string, r.id as number);
  }
  return out;
}

async function sourceGrades(db: AnyDb, rootIdList: number[]): Promise<Map<number, Grade>> {
  // grade of the newest version of each root source
  const out = new Map<number, Grade>();
  if (rootIdList.length === 0) return out;
  const roots = await db.selectFrom('kb_sources').select(['id', 'url_hash']).where('id', 'in', rootIdList).execute();
  const heads = await db.selectFrom('kb_sources').select(['url_hash', 'reliability', 'version']).where('url_hash', 'in', roots.map((r: Cols) => r.url_hash)).orderBy('version').execute();
  const byHash = new Map<string, Grade>();
  for (const h of heads) byHash.set(h.url_hash as string, h.reliability as Grade);
  for (const r of roots) out.set(r.id as number, byHash.get(r.url_hash as string)!);
  return out;
}

/** The ids of the questions of the slugs, with their options. */
async function questionsBySlug(db: AnyDb, slugs: string[]): Promise<Map<string, { id: number; options: string[] }>> {
  const out = new Map<string, { id: number; options: string[] }>();
  if (slugs.length === 0) return out;
  for (const r of await db.selectFrom('kb_questions').select(['id', 'slug', 'options']).where('slug', 'in', slugs).execute()) out.set(r.slug as string, { id: r.id as number, options: r.options as string[] });
  return out;
}

type Parsed = { ok: true; value: Cols } | { ok: false; message: string };
const fail = (message: string): Parsed => ({ ok: false, message });

/** Turns each raw row into insertable columns (references resolved). Returns the prepared rows and rejects. */
async function prepare(db: AnyDb, kind: Kind, raw: unknown[], ctx: Ctx): Promise<{ prepared: Prepared[]; rejects: RowReject[] }> {
  const rejects: RowReject[] = [];
  const parsed: { i: number; r: Record<string, unknown> }[] = [];
  raw.forEach((x, i) => {
    const p = SCHEMAS[kind].safeParse(x);
    if (p.success) parsed.push({ i, r: p.data as Record<string, unknown> });
    else rejects.push({ row: i, reason: 'ROW_INVALID', message: issueText(p.error) });
  });
  const topics = new Set(ctx.settings.values.topics);
  const out: Prepared[] = [];
  const reject = (i: number, reason: string, message: string) => rejects.push({ row: i, reason, message });
  const keyOf = (cols: Cols, spec: Spec) => spec.keyCols.map((c) => cols[c]);

  if (kind === 'author') {
    for (const { i, r } of parsed) {
      const cols: Cols = {
        name_key: authorKeyOf(r.name as string), name: r.name, handles: r.handles ?? {}, first_seen: r.first_seen ?? null, verified_sales_count: r.verified_sales_count ?? null,
        verified_sales_source: r.verified_sales_source ?? null, years_active: r.years_active ?? null, track_score: r.track_score ?? null, grade: r.grade, grade_reason: r.grade_reason ?? null,
      };
      out.push({ i, keyVals: keyOf(cols, SPECS.author), cols, supersede: r.supersede === true });
    }
  } else if (kind === 'source') {
    const authors = await rootIds(db, 'kb_authors', 'name_key', [...new Set(parsed.filter(({ r }) => r.author).map(({ r }) => authorKeyOf(r.author as string)))]);
    for (const { i, r } of parsed) {
      const sc = sourceCols(r as never);
      if ('error' in sc) { reject(i, 'URL_INVALID', sc.error); continue; }
      const bad = (r.topics as string[]).find((t) => !topics.has(t));
      if (bad) { reject(i, 'TOPIC_UNKNOWN', `topic "${bad}" is not in kb_settings v${ctx.settings.version}`); continue; }
      let authorId: number | null = null;
      if (r.author) {
        authorId = authors.get(authorKeyOf(r.author as string)) ?? null;
        if (authorId === null) { reject(i, 'AUTHOR_UNKNOWN', `author "${String(r.author).slice(0, 80)}" is not in the base; post it to /kb/authors first`); continue; }
      }
      const cols: Cols = {
        url: sc.url, url_hash: sc.url_hash, publisher: r.publisher ?? null, author_id: authorId, title: r.title ?? null, published_at: r.published_at ? new Date(r.published_at as string) : null,
        retrieved_at: r.retrieved_at ? new Date(r.retrieved_at as string) : undefined, type: r.type, access_method: r.access_method, access_note: r.access_note ?? null,
        reliability: r.reliability, reliability_reason: r.reliability_reason ?? null, conflict_of_interest: r.conflict_of_interest, excerpt: r.excerpt ?? null,
        content_hash: sc.content_hash, minhash: sc.minhash, topics: r.topics, status: r.status, rejected_reason: r.rejected_reason ?? null,
      };
      out.push({ i, keyVals: keyOf(cols, SPECS.source), cols, supersede: r.supersede === true });
    }
  } else if (kind === 'question') {
    for (const { i, r } of parsed) {
      const cols: Cols = { slug: r.slug, text: r.text, options: r.options, population: r.population ?? null, decision_owner: r.decision_owner ?? null };
      out.push({ i, keyVals: keyOf(cols, SPECS.question), cols, supersede: false });
    }
  } else if (kind === 'claim') {
    const qs = await questionsBySlug(db, [...new Set(parsed.flatMap(({ r }) => r.questions as string[]))]);
    for (const { i, r } of parsed) {
      if (!topics.has(r.topic as string)) { reject(i, 'TOPIC_UNKNOWN', `topic "${String(r.topic)}" is not in kb_settings v${ctx.settings.version}`); continue; }
      const linked = (r.questions as string[]).map((s) => ({ s, q: qs.get(s) }));
      const missing = linked.find((l) => !l.q);
      if (missing) { reject(i, 'QUESTION_UNKNOWN', `question "${missing.s.slice(0, 80)}" is not in the base; post it to /kb/questions first`); continue; }
      const opt = r.option as string | undefined;
      const wrong = opt === undefined ? undefined : linked.find((l) => !l.q!.options.includes(opt));
      if (wrong) { reject(i, 'OPTION_UNKNOWN', `option "${opt!.slice(0, 80)}" is not an option of question "${wrong.s}"`); continue; }
      if (opt !== undefined && linked.length === 0) { reject(i, 'OPTION_UNKNOWN', 'an option needs at least one question'); continue; }
      const cols: Cols = {
        claim_key: claimKeyOf(r.topic as string, r.variable as string, r.population as string), topic: r.topic, question_ids: [...new Set(linked.map((l) => l.q!.id))].sort((a, b) => a - b),
        option: opt ?? null, statement: r.statement, variable: r.variable, direction: r.direction, effect_value: r.effect_value ?? null, effect_unit: r.effect_unit ?? null,
        effect_low: r.effect_low ?? null, effect_high: r.effect_high ?? null, population: r.population, date_range_start: r.date_range_start ?? null, date_range_end: r.date_range_end ?? null,
        half_life_days: r.half_life_days ?? null,
      };
      out.push({ i, keyVals: keyOf(cols, SPECS.claim), cols, supersede: r.supersede === true });
    }
  } else if (kind === 'evidence') {
    const keyedClaim = parsed.map(({ i, r }) => {
      const c = r.claim as { topic: string; variable: string; population: string } | undefined;
      return { i, r, key: c ? claimKeyOf(c.topic, c.variable, c.population) : (r.claim_key as string).toLowerCase().trim() };
    });
    const urls = new Map<number, string | null>(parsed.map(({ i, r }) => [i, canonicalUrl(r.source as string)]));
    const sources = await rootIds(db, 'kb_sources', 'url_hash', [...new Set([...urls.values()].filter((u): u is string => u !== null).map(urlHash))]);
    const claims = await rootIds(db, 'kb_claims', 'claim_key', [...new Set(keyedClaim.map((k) => k.key))]);
    const grades = await sourceGrades(db, [...new Set(sources.values())]);
    for (const { i, r, key } of keyedClaim) {
      const url = urls.get(i);
      const sid = url ? sources.get(urlHash(url)) : undefined;
      if (sid === undefined) { reject(i, 'SOURCE_UNKNOWN', 'the source URL is not in the base; post it to /kb/sources first'); continue; }
      const cid = claims.get(key);
      if (cid === undefined) { reject(i, 'CLAIM_UNKNOWN', `claim_key "${key.slice(0, 120)}" is not in the base; post it to /kb/claims first`); continue; }
      const cg = r.claim_grade as Grade | undefined;
      if (cg && GRADE_ORDER[cg] > GRADE_ORDER[grades.get(sid)!]) { reject(i, 'CLAIM_GRADE_ABOVE_SOURCE', `claim_grade ${cg} is above the source's reliability ${grades.get(sid)}; a claim grade can only lower it`); continue; }
      const cols: Cols = {
        source_id: sid, claim_id: cid, locator: r.locator, stance: r.stance, credibility: r.credibility, sample_size: r.sample_size ?? null, evidence_kind: r.evidence_kind,
        population_match: r.population_match, survivorship: r.survivorship, claim_grade: cg ?? null, effect_value: r.effect_value ?? null, quote: r.quote ?? null,
        extracted_by: r.extracted_by, extracted_at: r.extracted_at ? new Date(r.extracted_at as string) : undefined, extraction_check: r.extraction_check,
      };
      out.push({ i, keyVals: keyOf(cols, SPECS.evidence), cols, supersede: r.supersede === true });
    }
  } else {
    const urlOf = (v: unknown) => canonicalUrl(v as string);
    const all = [...new Set(parsed.flatMap(({ r }) => [urlOf(r.from), urlOf(r.to)]).filter((u): u is string => u !== null).map(urlHash))];
    const sources = await rootIds(db, 'kb_sources', 'url_hash', all);
    for (const { i, r } of parsed) {
      const f = urlOf(r.from), t = urlOf(r.to);
      const fid = f ? sources.get(urlHash(f)) : undefined, tid = t ? sources.get(urlHash(t)) : undefined;
      if (fid === undefined || tid === undefined) { reject(i, 'SOURCE_UNKNOWN', `the ${fid === undefined ? 'from' : 'to'} URL is not in the base; post it to /kb/sources first`); continue; }
      if (fid === tid) { reject(i, 'LINK_SELF', 'a source cannot link to itself (the same canonical URL is the same source)'); continue; }
      const cols: Cols = { from_source_id: fid, to_source_id: tid, kind: r.kind, note: r.note ?? null, retracted: r.retracted };
      out.push({ i, keyVals: keyOf(cols, SPECS.link), cols, supersede: r.supersede === true });
    }
  }
  return { prepared: out, rejects };
}

/** The newest version of each row of the batch's keys, by key string. */
async function heads(db: AnyDb, spec: Spec, prepared: Prepared[]): Promise<Map<string, Cols>> {
  const out = new Map<string, Cols>();
  const first = spec.keyCols[0]!;
  const vals = [...new Set(prepared.map((p) => p.keyVals[0]))];
  for (let i = 0; i < vals.length; i += 500) {
    const rows = await db.selectFrom(spec.table).selectAll().where(first, 'in', vals.slice(i, i + 500)).execute() as Cols[];
    for (const r of rows) {
      const k = JSON.stringify(spec.keyCols.map((c) => r[c]));
      const have = out.get(k);
      if (!have || (r.version as number ?? 1) > (have.version as number ?? 1)) out.set(k, r);
    }
  }
  return out;
}

/** Applies a batch of one kind inside `trx` (the caller holds the `kb_write` lock). Throws KB_ROWS_REJECTED when any row is rejected. */
export async function applyKind(trx: AnyDb, kind: Kind, raw: unknown[], ctx: Ctx): Promise<KindResult> {
  const spec = SPECS[kind];
  const { prepared, rejects } = await prepare(trx, kind, raw, ctx);
  const existing = await heads(trx, spec, prepared);
  const results: RowResult[] = [];
  const toInsert: { p: Prepared; version: number; supersedes: number | null }[] = [];
  const seen = new Map<string, Prepared>();
  for (const p of prepared) {
    const k = JSON.stringify(p.keyVals);
    const earlier = seen.get(k);
    if (earlier) {
      if (same(earlier.cols, p.cols) || stable(earlier.cols) === stable(p.cols)) results.push({ row: p.i, outcome: 'duplicate', id: null });
      else rejects.push({ row: p.i, reason: 'CONFLICTING_DUPLICATE_IN_BATCH', message: `row ${earlier.i} has the same key with other content` });
      continue;
    }
    seen.set(k, p);
    const head = existing.get(k);
    if (!head) { toInsert.push({ p, version: 1, supersedes: null }); continue; }
    if (same(head, p.cols)) { results.push({ row: p.i, outcome: 'duplicate', id: head.id as number }); continue; }
    if (p.supersede && spec.versioned) { toInsert.push({ p, version: (head.version as number) + 1, supersedes: head.id as number }); continue; }
    rejects.push({ row: p.i, reason: 'EXISTS_DIFFERENT', message: spec.versioned ? 'a row with this key exists with other content; post it again with "supersede": true to correct it' : 'a question with this slug exists with other content; questions cannot be corrected, use a new slug' });
  }
  if (rejects.length > 0) {
    rejects.sort((a, b) => a.row - b.row);
    throw new AppError(422, 'KB_ROWS_REJECTED', `${rejects.length} of ${raw.length} ${kind} rows were rejected; nothing was written`, { kind, received_n: raw.length, rejected_n: rejects.length, rejects: rejects.slice(0, 200) });
  }
  if (!ctx.dryRun) {
    for (let i = 0; i < toInsert.length; i += 300) {
      const chunk = toInsert.slice(i, i + 300);
      const values = chunk.map(({ p, version, supersedes }) => {
        const v: Cols = { ...p.cols };
        for (const c of JSON_COLS) if (c in v) v[c] = JSON.stringify(v[c]);
        for (const k of Object.keys(v)) if (v[k] === undefined) delete v[k];
        if (kind === 'source' && v.retrieved_at === undefined) v.retrieved_at = ctx.now;
        if (kind === 'evidence' && v.extracted_at === undefined) v.extracted_at = ctx.now;
        if (kind === 'evidence' && v.extracted_by === undefined) v.extracted_by = ctx.by;
        if (spec.versioned) { v.version = version; v.supersedes = supersedes; }
        v.by = ctx.by; v.audit_id = ctx.auditId;
        return v;
      });
      const ids = await trx.insertInto(spec.table).values(values).returning('id').execute();
      chunk.forEach(({ p, supersedes }, j) => results.push({ row: p.i, outcome: supersedes === null ? 'accepted' : 'superseded', id: ids[j]!.id as number }));
    }
  } else {
    for (const { p, supersedes } of toInsert) results.push({ row: p.i, outcome: supersedes === null ? 'accepted' : 'superseded', id: null });
  }
  results.sort((a, b) => a.row - b.row);
  const n = (o: RowResult['outcome']) => results.filter((r) => r.outcome === o).length;
  return { kind, received_n: raw.length, accepted_n: n('accepted'), duplicate_n: n('duplicate'), superseded_n: n('superseded'), rows: results };
}

/** One transaction under the `kb_write` lock: the rows of one kind (routes), or several kinds in parent-first order (files). */
export async function writeKinds(db: Kysely<Database>, batches: { kind: Kind; rows: unknown[] }[], ctx: Omit<Ctx, 'settings'> & { settings: KbSettings }): Promise<KindResult[]> {
  return db.transaction().execute(async (trx) => {
    await advisoryXactLock(trx, 'kb_write');
    const out: KindResult[] = [];
    for (const b of batches) out.push(await applyKind(trx as AnyDb, b.kind, b.rows, ctx));
    return out;
  });
}
