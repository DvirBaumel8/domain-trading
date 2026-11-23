import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { loadState } from './state.js';

const config = loadConfig(process.env);
const app = buildApp({ config, state: loadState() });
if (config.tokens.size === 0) app.log.warn('API_TOKENS is empty: every request except /health/ping is refused');

for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
await app.listen({ port: config.port, host: config.host });
