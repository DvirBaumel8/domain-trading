import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const H = 'a'.repeat(64);

describe('loadConfig', () => {
  it('starts with nothing set: no database, no keys, no tokens', () => {
    expect(loadConfig({})).toMatchObject({ port: 3000, host: '0.0.0.0', porkbun: null, commit: null, tokens: new Map() });
    expect(loadConfig({}).version).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it('ignores a leftover DATABASE_URL', () => {
    expect(JSON.stringify(loadConfig({ DATABASE_URL: 'postgres://u:p@h/db' }))).not.toContain('postgres');
  });
  it('reads tokens as hash -> name', () => {
    expect(loadConfig({ API_TOKENS: `gavriel:${H}, dom-read:${'b'.repeat(64)}` }).tokens).toEqual(new Map([[H, 'gavriel'], ['b'.repeat(64), 'dom-read']]));
  });
  it.each(['dt_a-real-token', `gavriel:${H.toUpperCase()}`, `gavriel:${H.slice(1)}`, `a:${H},b:${H}`, `a:${H},a:${'b'.repeat(64)}`])('refuses bad API_TOKENS without showing them: %s', (v) => {
    expect(() => loadConfig({ API_TOKENS: v })).toThrow(/API_TOKENS must be/);
    try { loadConfig({ API_TOKENS: v }); } catch (e) { expect((e as Error).message).not.toContain(v); }
  });
  it('needs both Porkbun keys or neither', () => {
    expect(() => loadConfig({ PORKBUN_API_KEY: 'pk1_fake' })).toThrow(/both/);
    expect(loadConfig({ PORKBUN_API_KEY: 'pk1_fake', PORKBUN_SECRET_API_KEY: 'sk1_fake' }).porkbun).toEqual({ apiKey: 'pk1_fake', secretKey: 'sk1_fake' });
    expect(loadConfig({ PORKBUN_API_KEY: '', PORKBUN_SECRET_API_KEY: '' }).porkbun).toBeNull();
  });
});
