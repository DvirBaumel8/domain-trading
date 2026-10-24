// CR-073: picks (arm A), the seal, the manifest and the arm views.
// Sealing rule (documented choice): the FIRST `GET /pickproof/{date}/manifest` at or after the day's deadline (16:00 UTC of D, setting) draws B1, B2, C1
// from the frozen pool, stores them and seals the day. Picks are closed from the deadline on (409 PICKPROOF_SEALED, sealed or not). The arms are shown
// only after that first manifest call (GET .../arms before it is 409 PICKPROOF_NOT_SEALED), so the bots publish the seal before anyone sees a random arm.
import type { Kysely } from 'kysely';
import type { Database } from '../../db/types.js';
import { addDays } from '../../core/dates.js';
import { AppError } from '../../http/errors.js';
import { armSha, byteOrder, drawArm } from './draw.js';
import { ensureDay, getDay, lockDay, type DayRow } from './pool.js';
import { ALL_ARMS, DRAWN_ARMS, RECIPES, type ArmName } from './recipe.js';

type ArmSummary = { n: number; sha256: string; short: boolean };

export const normalizePick = (s: string): string => s.trim().toLowerCase();
const isClosed = (d: DayRow, now: number): boolean => d.sealed_at !== null || now >= d.deadline.getTime();

export async function postPicks(db: Kysely<Database>, input: { day: string; names: string[]; by: string; auditId: string | null; now: number }) {
  return db.transaction().execute(async (tx) => {
    await lockDay(tx, input.day);
    const d = await ensureDay(tx, input.day);
    if (isClosed(d, input.now)) throw new AppError(409, 'PICKPROOF_SEALED', `Picks for ${input.day} are closed (deadline ${d.deadline.toISOString()}${d.sealed_at ? ', sealed' : ''}); nothing changed`, { date: input.day, deadline: d.deadline.toISOString(), sealed_at: d.sealed_at?.toISOString() ?? null });
    const names = input.names.map(normalizePick);
    if (names.length > d.k) throw new AppError(422, 'VALIDATION_ERROR', `At most ${d.k} names a day`, { k: d.k });
    if (new Set(names).size !== names.length) throw new AppError(422, 'VALIDATION_ERROR', 'The list has a name twice');
    const rows = names.length === 0 ? [] : await tx.selectFrom('pickproof_pool').select(['domain', 'price_cents']).where('day', '=', input.day).where('domain', 'in', names).execute();
    const price = new Map(rows.map((r) => [r.domain, r.price_cents]));
    const bad = names.filter((n) => !price.has(n));
    if (bad.length > 0) throw new AppError(422, 'NOT_IN_POOL', `${bad.length} name(s) are not in the frozen pool of ${input.day}`, { date: input.day, names: bad.slice(0, 100), not_in_pool_n: bad.length, pool_sha256: d.pool_sha256 });
    await tx.deleteFrom('pickproof_arms').where('day', '=', input.day).where('arm', '=', 'A').execute();
    if (names.length > 0) await tx.insertInto('pickproof_arms').values(names.map((domain, i) => ({ day: input.day, arm: 'A' as const, domain, rank: i + 1, price_cents: price.get(domain)! }))).execute();
    await tx.insertInto('pickproof_picks_history').values({ day: input.day, names: JSON.stringify(names), n: names.length, by: input.by, audit_id: input.auditId }).execute();
    return { date: input.day, arm: 'A', n: names.length, k: d.k, deadline: d.deadline.toISOString(), pool_sha256: d.pool_sha256, sealed: false };
  });
}

async function armNames(db: Kysely<Database>, day: string, arm: ArmName): Promise<Array<{ rank: number; domain: string; price_cents: number }>> {
  return db.selectFrom('pickproof_arms').select(['rank', 'domain', 'price_cents']).where('day', '=', day).where('arm', '=', arm).orderBy('rank').execute();
}

/** Seals the day when its deadline has passed; returns the (possibly just sealed) day. Before the deadline it only freezes the pool. */
export async function sealIfDue(db: Kysely<Database>, day: string, now: number, frozenBy?: 'datasave'): Promise<DayRow> {
  const peek = await getDay(db, day);
  if (peek?.sealed_at) return peek;
  return db.transaction().execute(async (tx) => {
    await lockDay(tx, day);
    const d = await ensureDay(tx, day, frozenBy);
    if (d.sealed_at || now < d.deadline.getTime()) return d;
    const pool = await tx.selectFrom('pickproof_pool').select(['domain', 'price_cents', 'passes_k1', 'is_two_word']).where('day', '=', day).execute();
    pool.sort((a, b) => byteOrder(a.domain, b.domain));
    const price = new Map(pool.map((r) => [r.domain, r.price_cents]));
    const subpools = { B1: pool, B2: pool.filter((r) => r.passes_k1), C1: pool.filter((r) => r.is_two_word) };
    const arms: Record<string, ArmSummary> = {};
    for (const arm of DRAWN_ARMS) {
      const drawn = drawArm(subpools[arm].map((r) => r.domain), d.seed, arm, d.k);
      if (drawn.names.length > 0) await tx.insertInto('pickproof_arms').values(drawn.names.map((domain, i) => ({ day, arm, domain, rank: i + 1, price_cents: price.get(domain)! }))).execute();
      arms[arm] = { n: drawn.names.length, sha256: armSha(drawn.names), short: drawn.short };
    }
    const a = await armNames(tx, day, 'A');
    arms.A = { n: a.length, sha256: armSha(a.map((r) => r.domain)), short: false };
    await tx.updateTable('pickproof_days').set({ arms: JSON.stringify(arms), sealed_at: new Date(now) }).where('day', '=', day).execute();
    return (await getDay(tx, day))!;
  });
}

export async function manifest(db: Kysely<Database>, day: string, now: number) {
  const d = await sealIfDue(db, day, now);
  const sealed = d.sealed_at !== null;
  const open = sealed ? null : (await db.selectFrom('pickproof_arms').select((eb) => eb.fn.countAll<string>().as('n')).where('day', '=', day).where('arm', '=', 'A').executeTakeFirstOrThrow()).n;
  const arm = (name: 'A' | 'B1' | 'B2' | 'C1') => {
    if (sealed) return { ...d.arms![name]!, sealed: true };
    return name === 'A' ? { status: 'open', n: Number(open), sealed: false } : { status: 'pending_seal', sealed: false };
  };
  return {
    date: day, data_date: d.data_date, pool_n: d.pool_n, pool_sha256: d.pool_sha256, seed: d.seed, k: d.k, sources: d.sources,
    arms: { A: arm('A'), B1: arm('B1'), B2: arm('B2'), C1: arm('C1'), C2: { status: 'not_built' } },
    recipe: { version: d.recipe_version, ...RECIPES[d.recipe_version] },
    deadline: d.deadline.toISOString(), sealed, sealed_at: d.sealed_at?.toISOString() ?? null,
  };
}

/** The drawn and submitted names, only for a sealed day. */
export async function armsView(db: Kysely<Database>, day: string, arm: ArmName | 'C2' | undefined) {
  const d = await getDay(db, day);
  if (!d || !d.sealed_at) throw new AppError(409, 'PICKPROOF_NOT_SEALED', `The arms of ${day} are shown after the day is sealed: call GET /pickproof/${day}/manifest at or after ${d ? d.deadline.toISOString() : 'the deadline'} first`, { date: day, deadline: d?.deadline.toISOString() ?? null });
  const one = async (a: ArmName) => ({ arm: a, ...d.arms![a]!, names: (await armNames(db, day, a)).map((r) => ({ rank: r.rank, domain: r.domain, price_cents: r.price_cents })) });
  if (arm === 'C2') return { date: day, arm: 'C2', status: 'not_built' };
  if (arm) return { date: day, pool_sha256: d.pool_sha256, seed: d.seed, ...(await one(arm)) };
  const arms: Record<string, unknown> = {};
  for (const a of ALL_ARMS) arms[a] = await one(a);
  return { date: day, pool_sha256: d.pool_sha256, seed: d.seed, arms: { ...arms, C2: { status: 'not_built' } } };
}

/** v5.30.0 (CR-073a): the frozen pool rows of a day (freezes it on first use, like the manifest), sorted by domain in byte order. */
export async function poolView(db: Kysely<Database>, day: string) {
  const d = await db.transaction().execute(async (tx) => { await lockDay(tx, day); return ensureDay(tx, day); });
  const rows = await db.selectFrom('pickproof_pool').select(['domain', 'source', 'price_cents', 'passes_k1', 'is_two_word']).where('day', '=', day).execute();
  if (rows.length !== d.pool_n) throw new AppError(410, 'PICKPROOF_POOL_PRUNED', `The pool rows of ${day} were pruned; pool_sha256 and the manifest stay`, { date: day, pool_sha256: d.pool_sha256, pool_n: d.pool_n });
  rows.sort((a, b) => byteOrder(a.domain, b.domain));
  return {
    date: day, data_date: d.data_date, pool_n: d.pool_n, pool_sha256: d.pool_sha256, seed: d.seed, sources: d.sources,
    fields: ['domain', 'source', 'price_cents', 'passes_k1', 'is_two_word'],
    rows: rows.map((r) => [r.domain, r.source, r.price_cents, r.passes_k1, r.is_two_word]),
  };
}

/**
 * v5.35.0: the datasave step `pickproofSeal`. Every pick day from the first one ever frozen up to yesterday (UTC) that is still unsealed is frozen (if
 * nothing froze it) and sealed, as the first manifest call after the deadline would do. Today is never touched, so the bots' own freeze, picks and
 * seal stay first. It runs before snapshotRetention, while the datasave rows of D-1 still exist. The draw depends only on the frozen pool, so a late
 * seal draws the same arms. A day that cannot be frozen keeps its error code (SNAPSHOT_MISSING, POOL_NOT_READY, POOL_SOURCE_PRUNED).
 */
export async function autoSeal(db: Kysely<Database>, now: number): Promise<{ status: 'ok' | 'nothing_due' | 'not_started'; days: Array<{ date: string; result: 'sealed' | 'error'; frozen_now?: boolean; code?: string }> }> {
  const first = (await db.selectFrom('pickproof_days').select((eb) => eb.fn.min('day').as('d')).executeTakeFirst())?.d;
  if (!first) return { status: 'not_started', days: [] };
  const today = new Date(now).toISOString().slice(0, 10);
  const have = new Map((await db.selectFrom('pickproof_days').select(['day', 'sealed_at']).execute()).map((r) => [String(r.day), r.sealed_at]));
  const days: Array<{ date: string; result: 'sealed' | 'error'; frozen_now?: boolean; code?: string }> = [];
  for (let d = String(first); d < today; d = addDays(d, 1)) {
    if (have.has(d) && have.get(d) !== null) continue;
    try {
      await sealIfDue(db, d, now, 'datasave');
      days.push({ date: d, result: 'sealed', frozen_now: !have.has(d) });
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      days.push({ date: d, result: 'error', code: e.code });
    }
  }
  return { status: days.length ? 'ok' : 'nothing_due', days };
}
