import { HttpResponse } from 'msw';

export const PORKBUN_BASE = 'https://api.porkbun.com/api/json/v3';
export const FAKE_KEYS = { apiKey: 'pk1_fake_test_key_000000000000', secretKey: 'sk1_fake_test_secret_00000000' };

export interface RecordedRequest { method: string; path: string; headers: Record<string, string>; body: unknown }
export const recorded: RecordedRequest[] = [];

export async function record(request: Request): Promise<RecordedRequest> {
  const text = await request.clone().text();
  const r: RecordedRequest = {
    method: request.method,
    path: new URL(request.url).pathname.replace('/api/json/v3', ''),
    headers: Object.fromEntries(request.headers.entries()),
    body: text ? JSON.parse(text) : null,
  };
  recorded.push(r);
  return r;
}

export function checkDomainBody(over: Record<string, unknown> = {}, renewal: string | null = '11.08') {
  return {
    status: 'SUCCESS',
    response: {
      avail: 'yes', type: 'registration', price: '11.08', firstYearPromo: 'no', regularPrice: '11.08',
      premium: 'no', minDuration: 1,
      additional: renewal === null ? {} : { renewal: { type: 'renewal', price: renewal, regularPrice: renewal } },
      ...over,
    },
    limits: { TTL: 10, limit: 10, used: 1, naturalLanguage: '1 out of 10 checks within 10 seconds used.' },
    ttlRemaining: 9,
  };
}

export function pbError(code: string | undefined, extra: Record<string, unknown> = {}, init: { status?: number; headers?: Record<string, string> } = {}) {
  return HttpResponse.json(
    { status: 'ERROR', ...(code ? { code } : {}), message: `msg for ${code ?? 'none'}`, ...extra },
    { status: init.status ?? 400, headers: init.headers },
  );
}
