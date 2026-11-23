import { defineConfig } from 'vitest/config';

// Offline: MSW refuses every request a test did not mock, and UDP is blocked (tests/setup/network.ts).
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], setupFiles: ['tests/setup/network.ts'] } });
