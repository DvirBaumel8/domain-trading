import dgram from 'node:dgram';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';

// MSW's built-in 'error' strategy skips "common asset" URLs (isCommonAssetRequest: paths ending .csv, .json, .zip, .txt, .xml, ...), and
// lets them reach the real network. The IANA bootstrap (dns.json) and the popularity list (.csv) are such URLs, so a catch-all for the
// same extensions answers with a network error. Handlers a test adds with `use` come first, so mocking such a URL still works.
const ASSET_PATH = /\.(s?css|less|m?jsx?|m?tsx?|html|ttf|otf|woff2?|eot|gif|jpe?g|png|avif|webp|svg|mp4|webm|ogg|mov|mp3|wav|flac|aac|pdf|txt|csv|json|xml|md|zip|tar|gz|rar|7z)$/i;
export const mswServer = setupServer(
  http.all(({ request }) => ASSET_PATH.test(new URL(request.url).pathname), () => HttpResponse.error()),
);

beforeAll(() => {
  vi.spyOn(dgram, 'createSocket').mockImplementation(() => { throw new Error('UDP blocked in tests'); });
});
beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());
