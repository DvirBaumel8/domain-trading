import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import { testDb } from './db.js';
import { makeApp } from './app.js';
import { issueToken } from './tokens.js';

/** The Task 4 plan: only the checks that exist offline. */
export const OFFLINE = ['form', 'brand_lists', 'concentration', 'web_risk', 'tm_us'] as const;

export async function putList(name: string, terms: string[], version = 1): Promise<void> {
  await testDb.insertInto('selection_lists').values({ name, version, terms, created_by: 'test' }).execute();
}
export async function putBrandLists(brand: string[] = ['zzbrand'], bigco: string[] = ['zzbigco'], event: string[] = ['zzevent']): Promise<void> {
  await putList('brand', brand);
  await putList('bigco', bigco);
  await putList('event', event);
}

export interface ScreeningHarness {
  app: FastifyInstance;
  clock: { t: number };
  post: (url: string, payload: object) => Promise<LightMyRequestResponse>;
  get: (url: string) => Promise<LightMyRequestResponse>;
  run: (body: object) => Promise<{ id: string; res: LightMyRequestResponse }>;
  /** Creates the run, lets the worker finish, returns the polled body. */
  runDone: (body: object) => Promise<{ id: string; body: any }>;
}

export async function screeningHarness(start = Date.parse('2026-10-06T08:00:00Z')): Promise<ScreeningHarness> {
  const clock = { t: start };
  const app = await makeApp({ now: () => clock.t });
  const w = await issueToken('write', 'gavriel');
  const r = await issueToken('read');
  // The write limiter allows 10 per minute per token: each call is a fresh minute for it.
  const post = (url: string, payload: object) => (clock.t += 7_000, app.inject({ method: 'POST', url, headers: { ...w.auth, 'idempotency-key': randomUUID() }, payload }));
  const get = (url: string) => app.inject({ method: 'GET', url, headers: r.auth });
  const run = async (body: object) => {
    const res = await post('/screening/runs', body);
    return { id: (res.json().run_id as string | undefined) ?? '', res };
  };
  const runDone = async (body: object) => {
    const { id, res } = await run(body);
    if (res.statusCode !== 202) throw new Error(`run refused: ${res.body}`);
    await app.screeningWorker.runToEnd(id);
    return { id, body: (await get(`/screening/runs/${id}`)).json() };
  };
  return { app, clock, post, get, run, runDone };
}
