import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { adapterStatus } from '../../src/modules/registrars/registry.js';
import { testEnv } from '../helpers/env.js';

describe('loadConfig', () => {
  it('parses a valid env with defaults', () => {
    const c = loadConfig(testEnv());
    expect(c.appEnv).toBe('test');
    expect(c.port).toBe(3000);
    expect(c.enabledRegistrars).toEqual(['porkbun']);
    expect(c.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('defaults sedoTemplatePath and dnsNsServer', () => {
    const c = loadConfig(testEnv());
    expect(c.sedoTemplatePath).toBe('templates/sedo_template.json');
    expect(c.dnsNsServer).toBe('192.5.6.30');
  });

  it('PORKBUN_BASE_URL must be https outside test', () => {
    expect(() => loadConfig(testEnv({ APP_ENV: 'development', PORKBUN_BASE_URL: 'http://evil.example' }))).toThrow(
      'Invalid environment: PORKBUN_BASE_URL must be https');
    expect(() => loadConfig(testEnv({ APP_ENV: 'development', PORKBUN_BASE_URL: 'https://api.porkbun.com/api/json/v3' }))).not.toThrow();
    expect(() => loadConfig(testEnv({ APP_ENV: 'development' }))).not.toThrow();
    expect(() => loadConfig(testEnv({ APP_ENV: 'test', PORKBUN_BASE_URL: 'http://localhost:1' }))).not.toThrow();
  });

  it('G-89: RENDER set with APP_ENV other than production refuses to start; production passes', () => {
    expect(() => loadConfig(testEnv({ RENDER: 'true' }))).toThrow(/RENDER is set but APP_ENV is test/);
    expect(() => loadConfig(testEnv({ RENDER: 'true', APP_ENV: 'development' }))).toThrow(/APP_ENV=production/);
    expect(() => loadConfig(testEnv({ RENDER: 'true', APP_ENV: 'production', DATABASE_SSL: 'true', DATABASE_URL: 'postgres://u:p@db.example.com/d?sslmode=verify-full' }))).not.toThrow();
    expect(() => loadConfig(testEnv({ APP_ENV: 'development' }))).not.toThrow();
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
        'pk1_sb_fake_test_key_0000000',
        'sk1_sb_fake_test_secret_00000',
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
  it('porkbun is enabled with keys; every other registrar is disabled', () => {
    const s = adapterStatus(loadConfig(testEnv()));
    expect(s.map((a) => a.name)).toEqual(
      expect.arrayContaining(['porkbun', 'dynadot', 'namecom', 'namecheap', 'godaddy', 'spaceship', 'namesilo']),
    );
    expect(s.find((a) => a.name === 'porkbun')).toMatchObject({ enabled: true, reason: null });
    expect(s.filter((a) => a.name !== 'porkbun').every((a) => a.enabled === false)).toBe(true);
  });

  it('never lists cloudflare', () => {
    expect(adapterStatus(loadConfig(testEnv())).some((a) => a.name === 'cloudflare')).toBe(false);
  });

  it('reports porkbun keys missing', () => {
    const s = adapterStatus(loadConfig(testEnv({ PORKBUN_API_KEY: '' })));
    expect(s.find((a) => a.name === 'porkbun')?.reason).toBe('keys missing');
  });

  it('reports "not implemented" for an enabled registrar with keys but no adapter', () => {
    const s = adapterStatus(
      loadConfig(testEnv({ ENABLED_REGISTRARS: 'porkbun,dynadot', DYNADOT_API_KEY: 'fake_dyn_key_000000', DYNADOT_API_SECRET: 'fake_dyn_secret_0000' })),
    );
    expect(s.find((a) => a.name === 'dynadot')?.reason).toBe('not implemented');
  });

  it('reports registrars not in ENABLED_REGISTRARS', () => {
    const s = adapterStatus(loadConfig(testEnv()));
    expect(s.find((a) => a.name === 'dynadot')?.reason).toBe('not in ENABLED_REGISTRARS');
  });
});

describe('ENABLED_REGISTRARS validation (S8)', () => {
  it('rejects unknown registrar names', () => {
    expect(() => loadConfig(testEnv({ ENABLED_REGISTRARS: 'porkbun,porkbunn' }))).toThrow(/ENABLED_REGISTRARS.*porkbunn/);
  });
  it('rejects prototype-chain names like constructor', () => {
    expect(() => loadConfig(testEnv({ ENABLED_REGISTRARS: 'constructor' }))).toThrow(/unknown registrar/);
  });
  it('rejects cloudflare explicitly (founder rule 5)', () => {
    expect(() => loadConfig(testEnv({ ENABLED_REGISTRARS: 'cloudflare' }))).toThrow(/cloudflare/i);
  });
  it('accepts an empty list', () => {
    expect(loadConfig(testEnv({ ENABLED_REGISTRARS: '' })).enabledRegistrars).toEqual([]);
  });
});
