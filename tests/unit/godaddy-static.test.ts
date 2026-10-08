import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { testEnv } from '../helpers/env.js';

describe('IM-11 (static): the GoDaddy adapter is management-only', () => {
  it('src/modules/registrars/godaddy.ts has no purchase, register, availability, top-up or billing path', () => {
    const src = readFileSync('src/modules/registrars/godaddy.ts', 'utf8');
    for (const banned of ['/purchase', '/register', 'availab', 'topup', 'top-up', 'billing', "method: 'post'", "'post'", '/renew']) {
      expect(src.toLowerCase(), banned).not.toContain(banned);
    }
  });
  it('GODADDY_BASE_URL must be https outside test', () => {
    expect(() => loadConfig(testEnv({ APP_ENV: 'development', GODADDY_BASE_URL: 'http://evil.example' }))).toThrow('Invalid environment: GODADDY_BASE_URL must be https');
    expect(() => loadConfig(testEnv({ APP_ENV: 'development', GODADDY_BASE_URL: 'https://api.godaddy.com' }))).not.toThrow();
    expect(() => loadConfig(testEnv({ APP_ENV: 'test', GODADDY_BASE_URL: 'http://localhost:1' }))).not.toThrow();
  });
});
