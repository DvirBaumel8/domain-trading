// CR-078 rule 9: DOM never posts to production. Its research reaches the base as repo files data/knowledge/*.jsonl (one JSON object per line, the same fields as the
// POST /kb/* rows plus "kind": author | source | question | claim | evidence | link), shipped with a release and loaded by the daily step `kbLoad`.
// A file is loaded once per sha256 (kb_loads); the rows go in parent-first order in one transaction with the same validation as the routes; a bad line fails that
// file only (recorded with its error) and the other files still load. Re-loading a file is a no-op also at row level (natural keys).
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, type Kysely } from 'kysely';
import { advisoryXactLock } from '../../core/locks.js';
import type { Database } from '../../db/types.js';
import { AppError } from '../../http/errors.js';
import { KB_MAX_ROWS, KIND_ORDER, type Kind, type RowReject } from './rows.js';
import { activeKbSettings } from './settings.js';
import { applyKind, type KindResult } from './store.js';
import { sha256 } from './url.js';

export const DEFAULT_KNOWLEDGE_DIR = fileURLToPath(new URL('../../../data/knowledge/', import.meta.url));
export const LOAD_BY = 'repo-load';
class DryRunRollback extends Error {}

/** `auto_superseded` (v5.79.0, CR-098): the keys whose stored newest version came from a route call and that this file replaced without `supersede`. */
export interface KindCounts { accepted: number; duplicate: number; superseded: number; auto_superseded: string[] }
export interface KbLoadSummary {
  /** v5.79.0 (CR-098): true for `GET /kb/load-preview`; the rows were written and rolled back, and nothing was recorded in kb_loads. */
  dry_run?: boolean;
  files_seen: number;
  loaded: { file: string; sha256: string; counts: Record<string, KindCounts> }[];
  unchanged: string[];
  failed: { file: string; sha256: string; error: string }[];
}

/** Parses the lines of a file into rows per kind; throws a plain Error naming the line. */
export function parseKnowledgeFile(text: string): Map<Kind, unknown[]> {
  return parseWithLines(text).rows;
}

/** The rows per kind and, per kind, the 1-based file line of each row (CR-098 ask 3: a reject names its file line, not its place in the kind's batch). */
function parseWithLines(text: string): { rows: Map<Kind, unknown[]>; lines: Map<Kind, number[]> } {
  const out = new Map<Kind, unknown[]>(KIND_ORDER.map((k) => [k, []]));
  const lines = new Map<Kind, number[]>(KIND_ORDER.map((k) => [k, []]));
  text.split('\n').forEach((line, idx) => {
    if (line.trim() === '' || line.trimStart().startsWith('//')) return;
    let obj: unknown;
    try { obj = JSON.parse(line); } catch { throw new Error(`line ${idx + 1}: not valid JSON`); }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`line ${idx + 1}: not a JSON object`);
    const { kind, ...row } = obj as Record<string, unknown>;
    // A link row has its own field `kind` (echo_of, ...): in a file it is `link_kind`, because "kind" names the row kind.
    if (kind === 'link') {
      if ('kind' in row) throw new Error(`line ${idx + 1}: a link line uses "link_kind" for the link kind (its "kind" is the row kind)`);
      if ('link_kind' in row) { row.kind = row.link_kind; delete row.link_kind; }
    }
    if (typeof kind !== 'string' || !(KIND_ORDER as readonly string[]).includes(kind)) throw new Error(`line ${idx + 1}: "kind" must be one of ${KIND_ORDER.join(', ')}`);
    out.get(kind as Kind)!.push(row);
    lines.get(kind as Kind)!.push(idx + 1);
  });
  return { rows: out, lines };
}

const errorText = (e: unknown): string => {
  if (e instanceof AppError && Array.isArray(e.details.rejects)) {
    const kind = String(e.details.kind);
    const r = e.details.rejects as (RowReject & { line?: number })[];
    const at = (x: RowReject & { line?: number }) => (x.line !== undefined ? `line ${x.line}` : `row ${x.row + 1}`);
    const one = (x: RowReject & { line?: number }) => x.key !== undefined
      ? `${at(x)} ${x.reason} ${x.key.slice(0, 160)}${x.fields?.length ? ` [${x.fields.join(', ')}]` : ''}`
      : `${at(x)} ${x.reason} (${x.message})`;
    const more = r.length > 5 ? `; +${r.length - 5} more` : '';
    return `${kind}: ${r.length} rejected: ${r.slice(0, 5).map(one).join('; ')}${more}`.slice(0, 900);
  }
  return (e instanceof Error ? e.message : String(e)).slice(0, 900);
};

export class KbLoadJob {
  constructor(private readonly deps: { db: Kysely<Database>; now: () => number; dir?: string; log?: { warn: (o: object, m: string) => void } }) {}

  /** `dryRun` (v5.79.0, CR-098): the files not yet loaded run in one transaction that is rolled back at the end (a savepoint per file, so a failed file is undone
   * and the next files still see the earlier files' rows, as in a real load); nothing is kept and kb_loads is not touched. */
  async runOnce(o: { dryRun?: boolean } = {}): Promise<KbLoadSummary> {
    const dryRun = o.dryRun === true;
    const { db } = this.deps;
    const dir = this.deps.dir ?? DEFAULT_KNOWLEDGE_DIR;
    let names: string[];
    try { names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl')).sort(); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...(dryRun ? { dry_run: true } : {}), files_seen: 0, loaded: [], unchanged: [], failed: [] };
      throw e;
    }
    const sum: KbLoadSummary = { ...(dryRun ? { dry_run: true } : {}), files_seen: names.length, loaded: [], unchanged: [], failed: [] };
    const files: { file: string; text: string; hash: string }[] = [];
    for (const file of names) {
      const text = await readFile(join(dir, file), 'utf8');
      const hash = sha256(text);
      const done = await db.selectFrom('kb_loads').select('id').where('sha256', '=', hash).where('ok', '=', true).executeTakeFirst();
      if (done) sum.unchanged.push(file); else files.push({ file, text, hash });
    }
    if (dryRun) {
      await db.transaction().execute(async (trx) => {
        await advisoryXactLock(trx, 'kb_write');
        for (const f of files) {
          await sql`savepoint kb_file`.execute(trx);
          try {
            sum.loaded.push({ file: f.file, sha256: f.hash, counts: await this.loadFile(trx, f.text) });
            await sql`release savepoint kb_file`.execute(trx);
          } catch (e) {
            await sql`rollback to savepoint kb_file`.execute(trx);
            sum.failed.push({ file: f.file, sha256: f.hash, error: `${f.file}: ${errorText(e)}` });
          }
        }
        throw new DryRunRollback();
      }).catch((e: unknown) => { if (!(e instanceof DryRunRollback)) throw e; });
      return sum;
    }
    for (const { file, text, hash } of files) {
      try {
        const counts = await db.transaction().execute(async (trx) => {
          await advisoryXactLock(trx, 'kb_write');
          const c = await this.loadFile(trx, text);
          await trx.insertInto('kb_loads').values({ file_name: file, sha256: hash, ok: true, counts: JSON.stringify(c), error: null, loaded_at: new Date(this.deps.now()) }).execute();
          return c;
        });
        sum.loaded.push({ file, sha256: hash, counts });
      } catch (e) {
        const error = errorText(e);
        sum.failed.push({ file, sha256: hash, error: `${file}: ${error}` });
        this.deps.log?.warn({ file, error }, 'kbLoad: a knowledge file failed to load');
        const same = await db.selectFrom('kb_loads').select('id').where('sha256', '=', hash).where('ok', '=', false).where('error', '=', error).executeTakeFirst();
        if (!same) await db.insertInto('kb_loads').values({ file_name: file, sha256: hash, ok: false, counts: '{}', error, loaded_at: new Date(this.deps.now()) }).execute();
      }
    }
    return sum;
  }

  /** One file's rows in parent-first order inside `trx` (the caller holds the `kb_write` lock). A reject is rethrown with the file lines of its rows. */
  private async loadFile(trx: Kysely<Database>, text: string): Promise<Record<string, KindCounts>> {
    const { rows: byKind, lines } = parseWithLines(text);
    const settings = await activeKbSettings(trx);
    const c: Record<string, KindCounts> = {};
    for (const kind of KIND_ORDER) {
      const rows = byKind.get(kind)!;
      if (rows.length === 0) continue;
      const acc: KindCounts = { accepted: 0, duplicate: 0, superseded: 0, auto_superseded: [] };
      for (let i = 0; i < rows.length; i += KB_MAX_ROWS) {
        const r: KindResult = await applyKind(trx, kind, rows.slice(i, i + KB_MAX_ROWS), { by: LOAD_BY, auditId: null, now: new Date(this.deps.now()), settings, dryRun: false, fileBy: LOAD_BY }).catch((e: unknown) => {
          if (e instanceof AppError && Array.isArray(e.details.rejects)) for (const x of e.details.rejects as (RowReject & { line?: number })[]) { x.row += i; x.line = lines.get(kind)![x.row]; }
          throw e;
        });
        acc.accepted += r.accepted_n; acc.duplicate += r.duplicate_n; acc.superseded += r.superseded_n; acc.auto_superseded.push(...r.auto_superseded);
      }
      c[kind] = acc;
    }
    return c;
  }
}
