// Loads the recorded RDAP / IANA fixtures (tests/fixtures/screening/, recorded by `npm run record:screening`) as MSW responses.
import { readFileSync } from 'node:fs';
import { HttpResponse } from 'msw';

export interface RecordedFixture { url: string; status: number; headers: { 'content-type': string | null; 'retry-after': string | null }; body: string }

export function fixture(rel: string): RecordedFixture {
  return JSON.parse(readFileSync(new URL(`../fixtures/screening/${rel}`, import.meta.url), 'utf8')) as RecordedFixture;
}

export function respond(f: RecordedFixture): Response {
  const headers: Record<string, string> = {};
  if (f.headers['content-type']) headers['content-type'] = f.headers['content-type'];
  if (f.headers['retry-after']) headers['retry-after'] = f.headers['retry-after'];
  return new HttpResponse(f.status === 404 && f.body === '' ? null : f.body, { status: f.status, headers });
}

export const RANDOM_COM = 'zjwwqneitamicjovehsptpreqqzxfm.com';
