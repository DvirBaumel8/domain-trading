import dgram from 'node:dgram';
import { http, HttpResponse, isCommonAssetRequest } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';

// MSW's built-in 'error' strategy skips "common asset" URLs (isCommonAssetRequest: paths ending .csv, .json, .zip, .txt, ...) and lets
// them reach the real network. The IANA bootstrap (dns.json) and the popularity list (.csv) are such URLs, so a catch-all for the same
// predicate answers with a network error. Handlers a test adds with `use` come first, so mocking such a URL still works.
export const mswServer = setupServer(
  http.all(({ request }) => isCommonAssetRequest(request), () => HttpResponse.error()),
);

beforeAll(() => {
  vi.spyOn(dgram, 'createSocket').mockImplementation(() => { throw new Error('UDP blocked in tests'); });
});
beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());
