// Every cross-request or cross-instance lock of the service lives here, with a typed registry of key names (R1b).
// Transaction locks (pg_advisory_xact_lock) serialise a short read-check-write; session locks (pg_try_advisory_lock on a dedicated connection)
// guard a whole run (a job, a review call) so a second instance is skipped. Nothing in-process guards correctness across instances.
import { sql, type Kysely, type Transaction } from 'kysely';
import { AppError } from '../http/errors.js';

type Conn = Kysely<any> | Transaction<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The registry of lock keys. Parameterised keys carry their parameter after the colon. */
export type LockKey =
  | 'posts_cap' | 'intake_screening' | 'daily_rebuild' | 'holdout_suites' | 'test_sets_seal' | 'company_document' | 'selection_settings_activate'
  | 'job:tick' | 'job:daily' | 'job_enqueue' | 'review_run'
  | `job:${'price' | 'drop' | 'ns-verify' | 'registrar-check' | 'portfolio-check' | 'drop-watch' | 'cohort-outcomes' | 'reference-refresh'}`
  | `selection_list:${string}` | `pack:${string}` | `domain:${string}`;

/** The text that is hashed. A domain key hashes the bare domain name: the same key /buy has always used. */
export const lockText = (key: LockKey): string => (key.startsWith('domain:') ? key.slice('domain:'.length) : key);

/** Takes the transaction-level lock `key` inside `trx` (waits; released at commit or rollback). */
export async function advisoryXactLock(trx: Conn, key: LockKey): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${lockText(key)}))`.execute(trx);
}

/** Runs `fn` in a transaction that holds the transaction-level lock `key`. */
export function withAdvisoryLock<T>(db: Kysely<any>, key: LockKey, fn: (trx: Transaction<any>) => Promise<T>): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return db.transaction().execute(async (trx) => {
    await advisoryXactLock(trx, key);
    return fn(trx);
  });
}

/** A session-level lock held on its own connection until released. */
export interface SessionLock { release(): Promise<void> }

/** Tries the session-level lock `key` on a dedicated connection; null when another session (instance) holds it. Always release in a finally. */
export async function trySessionLock(db: Kysely<any>, key: LockKey): Promise<SessionLock | null> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const text = lockText(key);
  let finish!: () => void;
  const done = new Promise<void>((r) => { finish = r; });
  let answer!: (ok: boolean) => void;
  let fail!: (e: unknown) => void;
  const got = new Promise<boolean>((res, rej) => { answer = res; fail = rej; });
  const holder = db.connection().execute(async (conn) => {
    let ok = false;
    try {
      ok = (await sql<{ ok: boolean }>`select pg_try_advisory_lock(hashtext(${text})) as ok`.execute(conn)).rows[0]?.ok === true;
    } catch (e) { fail(e); return; }
    answer(ok);
    if (!ok) return;
    await done;
    try {
      await sql`select pg_advisory_unlock(hashtext(${text}))`.execute(conn);
    } catch {
      try { await sql`select pg_advisory_unlock_all()`.execute(conn); } catch { /* the connection is gone, and its locks with it */ }
    }
  });
  holder.catch(() => { /* surfaced through `got` or release() */ });
  if (!(await got)) { await holder; return null; }
  return { release: async () => { finish(); await holder; } };
}

/** Runs `fn` while holding the session lock `key`; `{ran:false}` when it is held elsewhere. */
export async function withSessionLock<T>(db: Kysely<any>, key: LockKey, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const lock = await trySessionLock(db, key);
  if (!lock) return { ran: false };
  try { return { ran: true, value: await fn() }; } finally { await lock.release(); }
}

const LOCK_POLL_MS = 50;
const LOCK_TIMEOUT_MS = 30_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function release(conn: Conn, text: string): Promise<void> {
  // fn may have left a transaction open (possibly aborted); roll it back so the connection returns to the pool clean
  try { await sql`rollback`.execute(conn); } catch { /* nothing to roll back */ }
  try {
    await sql`select pg_advisory_unlock(hashtext(${text}))`.execute(conn);
  } catch {
    await sql`select pg_advisory_unlock_all()`.execute(conn);
  }
}

/** Session-level advisory lock on the same key /buy uses (pg_advisory_xact_lock(hashtext(domain))). Bounded wait. */
export async function withDomainLock<T, D = any>( // eslint-disable-line @typescript-eslint/no-explicit-any
  db: Kysely<D>, domain: string, fn: (conn: Kysely<D>) => Promise<T>, opts?: { timeoutMs?: number },
): Promise<T> {
  const text = lockText(`domain:${domain}`);
  const deadline = Date.now() + (opts?.timeoutMs ?? LOCK_TIMEOUT_MS);
  return db.connection().execute(async (conn) => {
    for (;;) {
      const r = await sql<{ ok: boolean }>`select pg_try_advisory_lock(hashtext(${text})) as ok`.execute(conn);
      if (r.rows[0]?.ok) break;
      if (Date.now() >= deadline) throw new AppError(503, 'DOMAIN_BUSY', 'Another change to this domain is in progress; retry shortly');
      await sleep(LOCK_POLL_MS);
    }
    let result: T | undefined;
    let failed = false;
    let error: unknown;
    try {
      result = await fn(conn);
    } catch (e) {
      failed = true;
      error = e;
    }
    try {
      await release(conn, text);
    } catch (e) {
      if (!failed) throw e; // never mask fn's error
    }
    if (failed) throw error;
    return result as T;
  });
}
