import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { loadState } from './state.js';

const config = loadConfig(process.env);
const app = buildApp({ config, state: loadState() });

for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
await app.listen({ port: config.port, host: config.host });
