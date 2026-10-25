// CR-078 rule 9: DOM never posts to production. Its research reaches the base as repo files data/knowledge/*.jsonl (one JSON object per line, the same fields as the
// POST /kb/* rows plus "kind": author | source | question | claim | evidence | link), shipped with a release and loaded by the daily step `kbLoad`.
// A file is loaded once per sha256 (kb_loads); the rows go in parent-first order in one transaction with the same validation as the routes; a bad line fails that
// file only (recorded with its error) and the other files still load. Re-loading a file is a no-op also at row level (natural keys).
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Kysely } from 'kysely';
import { advisoryXactLock } from '../../core/locks.js';
import type { Database } from '../../db/types.js';
import { AppError } from '../../http/errors.js';
import { KB_MAX_ROWS, KIND_ORDER, type Kind } from './rows.js';
import { activeKbSettings } from './settings.js';
import { applyKind, type KindResult } from './store.js';
import { sha256 } from './url.js';

export const DEFAULT_KNOWLEDGE_DIR = fileURLToPath(new URL('../../../data/knowledge/', import.meta.url));
export const LOAD_BY = 'repo-load';

export interface KbLoadSummary {
  files_seen: number;
  loaded: { file: string; sha256: string; counts: Record<string, { accepted: number; duplicate: number; superseded: number }> }[];
  unchanged: string[];
  failed: { file: string; sha256: string; error: string }[];
}

/** Parses the lines of a file into rows per kind; throws a plain Error naming the line. */
export function parseKnowledgeFile(text: string): Map<Kind, unknown[]> {
  const out = new Map<Kind, unknown[]>(KIND_ORDER.map((k) => [k, []]));
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
  });
  return out;
}

const errorText = (e: unknown): string => {
  if (e instanceof AppError && Array.isArray(e.details.rejects)) {
    const r = e.details.rejects as { row: number; reason: string; message: string }[];
    return `${String(e.details.kind)}: ${r.slice(0, 3).map((x) => `row ${x.row + 1} ${x.reason} (${x.message})`).join('; ')}`.slice(0, 900);
  }
  return (e instanceof Error ? e.message : String(e)).slice(0, 900);
};

export class KbLoadJob {
  constructor(private readonly deps: { db: Kysely<Database>; now: () => number; dir?: string; log?: { warn: (o: object, m: string) => void } }) {}

  async runOnce(): Promise<KbLoadSummary> {
    const { db } = this.deps;
    const dir = this.deps.dir ?? DEFAULT_KNOWLEDGE_DIR;
    let names: string[];
    try { names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl')).sort(); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { files_seen: 0, loaded: [], unchanged: [], failed: [] };
      throw e;
    }
    const sum: KbLoadSummary = { files_seen: names.length, loaded: [], unchanged: [], failed: [] };
    for (const file of names) {
      const text = await readFile(join(dir, file), 'utf8');
      const hash = sha256(text);
      const done = await db.selectFrom('kb_loads').select('id').where('sha256', '=', hash).where('ok', '=', true).executeTakeFirst();
      if (done) { sum.unchanged.push(file); continue; }
      try {
        const byKind = parseKnowledgeFile(text);
        const settings = await activeKbSettings(db);
        const counts = await db.transaction().execute(async (trx) => {
          await advisoryXactLock(trx, 'kb_write');
          const c: KbLoadSummary['loaded'][number]['counts'] = {};
          for (const kind of KIND_ORDER) {
            const rows = byKind.get(kind)!;
            if (rows.length === 0) continue;
            const acc = { accepted: 0, duplicate: 0, superseded: 0 };
            for (let i = 0; i < rows.length; i += KB_MAX_ROWS) {
              const r: KindResult = await applyKind(trx, kind, rows.slice(i, i + KB_MAX_ROWS), { by: LOAD_BY, auditId: null, now: new Date(this.deps.now()), settings, dryRun: false }).catch((e: unknown) => {
                if (e instanceof AppError && Array.isArray(e.details.rejects) && i > 0) for (const x of e.details.rejects as { row: number }[]) x.row += i;
                throw e;
              });
              acc.accepted += r.accepted_n; acc.duplicate += r.duplicate_n; acc.superseded += r.superseded_n;
            }
            c[kind] = acc;
          }
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
}
