import { describe, expect, it } from 'vitest';
import { loadConfig, parseAccess } from '../../src/config.js';

const H = 'a'.repeat(64);

describe('loadConfig', () => {
  it('starts with nothing set: no database, no keys', () => {
    expect(loadConfig({}, '{}')).toMatchObject({ port: 3000, host: '0.0.0.0', porkbun: null, commit: null, tokens: new Map() });
    expect(loadConfig({}).version).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it('ignores a leftover DATABASE_URL', () => {
    expect(JSON.stringify(loadConfig({ DATABASE_URL: 'postgres://u:p@h/db' }))).not.toContain('postgres');
  });
  it('reads data/access.json as hash -> name', () => {
    expect(parseAccess(JSON.stringify({ gavriel: H, 'dom-read': 'b'.repeat(64) }))).toEqual(new Map([[H, 'gavriel'], ['b'.repeat(64), 'dom-read']]));
    expect(loadConfig({}).tokens.size).toBeGreaterThan(0); // the real file
  });
  it.each(['dt_a-real-token', '{"gavriel":"dt_a-real-token"}', `{"gavriel":"${H.toUpperCase()}"}`, `{"gavriel":"${H.slice(1)}"}`, `{"a":"${H}","b":"${H}"}`, `{"Bad Name":"${H}"}`, '[]'])('refuses a bad access file without showing it: %s', (v) => {
    expect(() => parseAccess(v)).toThrow(/^data\/access.json must map/);
    try { parseAccess(v); } catch (e) { expect((e as Error).message).not.toContain('dt_a-real-token'); }
  });
  it('needs both Porkbun keys or neither', () => {
    expect(() => loadConfig({ PORKBUN_API_KEY: 'pk1_fake' })).toThrow(/both/);
    expect(loadConfig({ PORKBUN_API_KEY: 'pk1_fake', PORKBUN_SECRET_API_KEY: 'sk1_fake' }).porkbun).toEqual({ apiKey: 'pk1_fake', secretKey: 'sk1_fake' });
    expect(loadConfig({ PORKBUN_API_KEY: '', PORKBUN_SECRET_API_KEY: '' }).porkbun).toBeNull();
  });
});
