import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { adapterStatus } from '../../src/registrars/registry.js';
import { testEnv } from '../helpers/env.js';

describe('loadConfig', () => {
  it('parses a valid env with defaults', () => {
    const c = loadConfig(testEnv());
    expect(c.appEnv).toBe('test');
    expect(c.port).toBe(3000);
    expect(c.enabledRegistrars).toEqual(['porkbun']);
    expect(c.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('rejects a missing DATABASE_URL', () => {
    const env = testEnv();
    delete env.DATABASE_URL;
    expect(() => loadConfig(env)).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => loadConfig(testEnv({ DATABASE_URL: 'mysql://x' }))).toThrow(/DATABASE_URL/);
  });

  it('collects every non-empty secret value (registrar keys, backup token, DB password)', () => {
    const c = loadConfig(testEnv());
    expect(c.secretValues).toEqual(
      expect.arrayContaining([
        'pk1_fake_test_key_000000000000',
        'sk1_fake_test_secret_00000000',
        'fake_godaddy_pat_0000000000',
        'github_pat_fake_000000000000',
        'dt',
      ]),
    );
  });

  it('lowercases and trims ENABLED_REGISTRARS', () => {
    expect(loadConfig(testEnv({ ENABLED_REGISTRARS: ' Porkbun, NameCom ' })).enabledRegistrars).toEqual([
      'porkbun',
      'namecom',
    ]);
  });
});

describe('adapterStatus', () => {
  it('lists every known registrar, all disabled in step 1 (no adapter implemented)', () => {
    const s = adapterStatus(loadConfig(testEnv()));
    expect(s.map((a) => a.name)).toEqual(
      expect.arrayContaining(['porkbun', 'dynadot', 'namecom', 'namecheap', 'godaddy', 'spaceship', 'namesilo']),
    );
    expect(s.every((a) => a.enabled === false)).toBe(true);
    expect(s.find((a) => a.name === 'porkbun')?.reason).toBe('not implemented');
  });

  it('never lists cloudflare', () => {
    expect(adapterStatus(loadConfig(testEnv())).some((a) => a.name === 'cloudflare')).toBe(false);
  });

  it('reports missing keys before "not implemented"', () => {
    const s = adapterStatus(loadConfig(testEnv({ PORKBUN_API_KEY: '' })));
    expect(s.find((a) => a.name === 'porkbun')?.reason).toBe('keys missing');
  });

  it('reports registrars not in ENABLED_REGISTRARS', () => {
    const s = adapterStatus(loadConfig(testEnv()));
    expect(s.find((a) => a.name === 'dynadot')?.reason).toBe('not in ENABLED_REGISTRARS');
  });
});
