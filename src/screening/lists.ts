// Versioned word lists and frozen census lists (append-only selection_lists). A write never changes a row: it adds version n+1.
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { normalizeDomain } from '../domain-name.js';
import { AppError } from '../http/errors.js';
import type { SelectionValuesT } from './settings.js';

export const FIXED_LISTS = [
  'dictionary_extra', 'city_extra', 'trade', 'regime', 'tech', 'generic_head', 'state', 'legal', 'brand', 'bigco', 'event',
  'sig_harmful_strong', 'sig_harmful_weak', 'sig_parked', 'sig_forsale',
] as const;
export const MAX_LIST_TERMS = 5000;
const PHRASE_LISTS = ['brand', 'bigco', 'event'];
const HARMFUL_CLASSES = ['adult', 'pharma', 'gambling', 'malware', 'phishing', 'hacked_spam', 'pbn', 'scam', 'trademark'];
const SIGNATURE_CLASSES: Record<string, string[]> = {
  sig_harmful_strong: HARMFUL_CLASSES, sig_harmful_weak: HARMFUL_CLASSES, sig_parked: ['parked'], sig_forsale: ['forsale'],
};
/** A census list: `bt1_<sld>` (CR-002 CAP-10) or `s6_regime_audit`; the DB name check is ^[a-z0-9_]{3,64}$. */
const CENSUS_NAME = /^(bt1_[a-z]{2,59}|s6_regime_audit)$/;

export const isFixedList = (name: string): boolean => (FIXED_LISTS as readonly string[]).includes(name);
export const isCensusListName = (name: string): boolean => !isFixedList(name) && CENSUS_NAME.test(name);

export interface ListRow { name: string; version: number; terms: string[]; created_at: Date; created_by: string; note: string | null }

/** The newest version of each named list; a list with no rows is absent from the result. */
export async function currentLists(db: Kysely<Database>, names: string[]): Promise<Record<string, { version: number; terms: string[] }>> {
  if (names.length === 0) return {};
  const rows = await db.selectFrom('selection_lists').select(['name', 'version', 'terms']).where('name', 'in', names).orderBy('name').orderBy('version', 'desc').execute();
  const out: Record<string, { version: number; terms: string[] }> = {};
  for (const r of rows) if (!out[r.name]) out[r.name] = { version: r.version, terms: r.terms };
  return out;
}

export async function listVersion(db: Kysely<Database>, name: string, version?: number): Promise<ListRow | null> {
  let q = db.selectFrom('selection_lists').select(['name', 'version', 'terms', 'created_at', 'created_by', 'note']).where('name', '=', name);
  q = version === undefined ? q.orderBy('version', 'desc').limit(1) : q.where('version', '=', version);
  const r = await q.executeTakeFirst();
  return r ?? null;
}

const invalid = (code: string, message: string, details: Record<string, unknown>) => new AppError(422, code, message, details);

/** Lowercase and trim every term; the term shape depends on the list kind. Duplicates collapse. */
function normaliseTerms(name: string, raw: string[], settings: SelectionValuesT): string[] {
  if (isCensusListName(name)) return normaliseCensus(name, raw, settings);
  const bad: string[] = [];
  const out = new Set<string>();
  const sig = SIGNATURE_CLASSES[name];
  for (const t0 of raw) {
    const t = t0.trim().toLowerCase().replace(/\s+/g, ' ');
    let ok: boolean;
    if (sig) {
      const m = /^([a-z_]+):([a-z0-9][a-z0-9 .'-]{1,80})$/.exec(t);
      ok = !!m && sig.includes(m[1]!);
    } else if (PHRASE_LISTS.includes(name)) ok = /^[a-z]{2,40}( [a-z]{1,40}){0,3}$/.test(t);
    else ok = /^[a-z]{2,40}$/.test(t);
    if (!ok) bad.push(t0);
    else out.add(t);
  }
  if (bad.length > 0) {
    throw invalid('LIST_TERM_INVALID', `Invalid term in list ${name}`, {
      list: name, terms: bad.slice(0, 20),
      expected: sig ? `class:phrase with class in ${sig.join(', ')}` : PHRASE_LISTS.includes(name) ? 'lowercase letters, words separated by single spaces' : 'lowercase letters only, 2 to 40',
    });
  }
  // A phrase is matched without its spaces, so two spellings of one phrase are one term.
  const byKey = new Map<string, string>();
  for (const t of [...out].sort()) if (!byKey.has(t.replace(/ /g, ''))) byKey.set(t.replace(/ /g, ''), t);
  return [...byKey.values()];
}

function normaliseCensus(name: string, raw: string[], settings: SelectionValuesT): string[] {
  const bad: { term: string; reason: string }[] = [];
  const seen = new Set<string>();
  const dup = new Set<string>();
  const out: string[] = [];
  const target = name.startsWith('bt1_') ? `${name.slice(4)}.com` : null;
  for (const t of raw) {
    let d: string;
    try {
      d = normalizeDomain(t);
    } catch {
      bad.push({ term: t, reason: 'not a valid second-level .com name' });
      continue;
    }
    if (d === target) bad.push({ term: t, reason: 'the target name is not its own sibling' });
    else if (seen.has(d)) dup.add(d);
    else {
      seen.add(d);
      out.push(d);
    }
  }
  if (bad.length > 0) throw invalid('CENSUS_LIST_INVALID', 'A census list holds distinct second-level .com names', { list: name, invalid: bad.slice(0, 20) });
  if (dup.size > 0) throw invalid('CENSUS_LIST_INVALID', 'A census list must not repeat a name', { list: name, duplicates: [...dup].slice(0, 20) });
  if (out.length !== settings.census.sibling_count) {
    throw invalid('CENSUS_LIST_SIZE', `A census list has exactly ${settings.census.sibling_count} names`, { list: name, expected: settings.census.sibling_count, got: out.length });
  }
  return out.sort();
}

export type ListBody = { replace?: string[]; add?: string[]; remove?: string[]; note?: string };

/** Writes version n+1 of a list. Census lists are written whole (`replace`) and frozen per version. */
export async function writeList(
  db: Kysely<Database>,
  name: string,
  body: ListBody,
  ctx: { createdBy: string; auditId: string; settings: SelectionValuesT; approvalText?: string },
): Promise<{ name: string; version: number; terms_n: number }> {
  if (!isFixedList(name) && !isCensusListName(name)) {
    throw invalid('LIST_NAME_INVALID', 'Unknown list name', { name, fixed: FIXED_LISTS, census: 'bt1_<sld> or s6_regime_audit' });
  }
  const census = isCensusListName(name);
  if (census && body.replace === undefined) throw invalid('CENSUS_LIST_INVALID', 'A census list is replaced whole: send replace', { list: name });
  if (body.replace !== undefined && (body.add !== undefined || body.remove !== undefined)) {
    throw invalid('LIST_NO_CHANGE', 'Send replace, or add and remove, not both', { list: name });
  }
  for (const k of ['replace', 'add', 'remove'] as const) {
    if ((body[k]?.length ?? 0) > MAX_LIST_TERMS) throw invalid('LIST_TERM_INVALID', `At most ${MAX_LIST_TERMS} terms per list`, { list: name, got: body[k]!.length });
  }

  return db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${'selection_list:' + name}))`.execute(trx);
    const cur = await listVersion(trx, name);
    let next: string[];
    if (body.replace !== undefined) next = normaliseTerms(name, body.replace, ctx.settings);
    else {
      const have = new Set(cur?.terms ?? []);
      const add = normaliseTerms(name, body.add ?? [], ctx.settings);
      const rm = new Set(normaliseTerms(name, body.remove ?? [], ctx.settings));
      const keys = new Set([...have].map((t) => t.replace(/ /g, '')));
      for (const t of add) if (!keys.has(t.replace(/ /g, ''))) have.add(t);
      next = [...have].filter((t) => !rm.has(t) && !rm.has(t.replace(/ /g, ''))).sort();
    }
    if (next.length > MAX_LIST_TERMS) throw invalid('LIST_TERM_INVALID', `At most ${MAX_LIST_TERMS} terms per list`, { list: name, got: next.length });
    const same = cur ? cur.terms.length === next.length && cur.terms.every((t, i) => t === next[i]) : next.length === 0;
    if (same) throw invalid('LIST_NO_CHANGE', 'The list would not change', { list: name, version: cur?.version ?? null });
    const version = (cur?.version ?? 0) + 1;
    await trx.insertInto('selection_lists').values({
      name, version, terms: next, note: body.note ?? null, created_by: ctx.createdBy, audit_id: ctx.auditId, approval_text: census ? ctx.approvalText ?? null : null,
    }).execute();
    return { name, version, terms_n: next.length };
  });
}
