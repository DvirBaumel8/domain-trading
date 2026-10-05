// setupFiles hook for the porkbun-sandbox project: runs after tests/contract/setup.ts (host allowlist), so the
// guard wraps that fetch. Any sandbox test file is guarded without having to remember to install it.
import { beforeAll } from 'vitest';
import { installGuardFetch } from './sandbox-guard.js';

beforeAll(() => installGuardFetch());
