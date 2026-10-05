import { http, HttpResponse } from 'msw';

export const GODADDY_BASE = 'https://godaddy.test';
export const FAKE_PAT = 'fake_godaddy_pat';

export interface GdRequest { method: string; path: string; auth: string | null; body: unknown }

/** MSW handlers for the GoDaddy v3 NS flow; every request is recorded. */
export function godaddyNsHandlers(opts: { operationStatuses: string[]; operationId?: string; viaLocation?: boolean; recorded: GdRequest[] }) {
  const id = opts.operationId ?? 'op1';
  let polls = 0;
  return [
    http.put(`${GODADDY_BASE}/v3/domains/domain-names/:d/nameservers`, async ({ request }) => {
      opts.recorded.push({ method: 'PUT', path: new URL(request.url).pathname, auth: request.headers.get('authorization'), body: await request.json() });
      return opts.viaLocation
        ? new HttpResponse(null, { status: 202, headers: { location: `${GODADDY_BASE}/v3/domains/operations/${id}` } })
        : HttpResponse.json({ operationId: id }, { status: 202 });
    }),
    http.get(`${GODADDY_BASE}/v3/domains/operations/:id`, ({ request }) => {
      opts.recorded.push({ method: 'GET', path: new URL(request.url).pathname, auth: request.headers.get('authorization'), body: null });
      const statuses = opts.operationStatuses;
      const status = statuses[Math.min(polls++, statuses.length - 1)];
      return HttpResponse.json({ id, status });
    }),
  ];
}
