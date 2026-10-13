import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // BUG-044: the API service binding (to the api-proxy Worker) has no local Worker in tests; a stub stands in. Tests pass their own fetcher.
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' }, miniflare: { serviceBindings: { API: () => new Response('stub') } } })],
});
