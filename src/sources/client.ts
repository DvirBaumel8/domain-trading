// One outside read. Every failure is a SourceError: a caller can never mistake it for "clean", "ok" or an empty answer.
export type SourceErrorCode = 'KEY_MISSING' | 'TIMEOUT' | 'NETWORK' | 'HTTP_ERROR' | 'BAD_RESPONSE' | 'NOT_IN_ACCOUNT' | 'DAILY_LIMIT';

export class SourceError extends Error {
  constructor(
    readonly source: string,
    readonly code: SourceErrorCode,
    readonly httpStatus: number | null = null,
    /** The source's own error code (GoDaddy's 403 eligibility code, for example). */
    readonly sourceCode: string | null = null,
  ) {
    super(`${source}: ${code}`);
  }
}

export type Fetch = typeof fetch;
export interface Request { source: string; url: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number }

const USER_AGENT = 'dt-read-client/1.0';
const TIMEOUT_MS = 10_000;

const ownCode = (text: string): string | null => {
  try {
    const code = (JSON.parse(text) as { code?: unknown } | null)?.code;
    return typeof code === 'string' && /^[\w-]{1,80}$/.test(code) ? code : null;
  } catch { return null; }
};

/** The body of a 200 answer. A key travels only in a header, and never to another host (redirects are refused). */
export async function readText(fetchFn: Fetch, r: Request): Promise<string> {
  let status: number;
  let text: string;
  try {
    const res = await fetchFn(r.url, {
      method: r.body === undefined ? 'GET' : 'POST',
      headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...(r.body === undefined ? {} : { 'content-type': 'application/json' }), ...r.headers },
      ...(r.body === undefined ? {} : { body: JSON.stringify(r.body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(r.timeoutMs ?? TIMEOUT_MS),
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    throw new SourceError(r.source, ['TimeoutError', 'AbortError'].includes((e as Error).name) ? 'TIMEOUT' : 'NETWORK');
  }
  if (status !== 200) throw new SourceError(r.source, 'HTTP_ERROR', status, ownCode(text));
  return text;
}

export async function readJson(fetchFn: Fetch, r: Request): Promise<unknown> {
  const text = await readText(fetchFn, r);
  try { return JSON.parse(text) as unknown; } catch { throw new SourceError(r.source, 'BAD_RESPONSE', 200); }
}

/** GoDaddy and Afternic send money in micro-units (1,000,000 = $1). */
export function microToCents(source: string, micro: number | null | undefined): number | null {
  if (micro === null || micro === undefined) return null;
  if (!Number.isSafeInteger(micro) || micro % 10_000 !== 0) throw new SourceError(source, 'BAD_RESPONSE', 200);
  return micro / 10_000;
}
