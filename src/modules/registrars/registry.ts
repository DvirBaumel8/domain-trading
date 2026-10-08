import type { Config } from '../../config.js';
import { GoDaddyAdapter } from './godaddy.js';
import { PorkbunAdapter } from './porkbun.js';
import type { RegistrarAdapter } from './types.js';

/** Env vars each registrar adapter needs. Cloudflare is deliberately absent (founder rule 5). */
export const REGISTRAR_ENV: Record<string, readonly string[]> = {
  porkbun: ['PORKBUN_API_KEY', 'PORKBUN_SECRET_API_KEY'],
  dynadot: ['DYNADOT_API_KEY', 'DYNADOT_API_SECRET'],
  namecom: ['NAMECOM_USERNAME', 'NAMECOM_API_TOKEN'],
  namecheap: ['NAMECHEAP_API_USER', 'NAMECHEAP_API_KEY', 'NAMECHEAP_USERNAME', 'NAMECHEAP_CLIENT_IP'],
  godaddy: ['GODADDY_PAT'],
  spaceship: ['SPACESHIP_API_KEY', 'SPACESHIP_API_SECRET'],
  namesilo: ['NAMESILO_API_KEY'],
};

/** Adapters with code behind them. */
export const IMPLEMENTED_ADAPTERS: ReadonlySet<string> = new Set<string>(['porkbun', 'godaddy']);

export function adapterStatus(config: Config): { name: string; enabled: boolean; reason: string | null }[] {
  return Object.entries(REGISTRAR_ENV).map(([name, keys]) => {
    let reason: string | null = null;
    if (!config.enabledRegistrars.includes(name)) reason = 'not in ENABLED_REGISTRARS';
    else if (keys.some((k) => !config.env[k])) reason = 'keys missing';
    else if (!IMPLEMENTED_ADAPTERS.has(name)) reason = 'not implemented';
    return { name, enabled: reason === null, reason };
  });
}

export function createAdapters(config: Config): RegistrarAdapter[] {
  return adapterStatus(config)
    .filter((a) => a.enabled)
    .map((a) => {
      switch (a.name) {
        case 'porkbun':
          return new PorkbunAdapter({
            apiKey: config.env.PORKBUN_API_KEY!,
            secretKey: config.env.PORKBUN_SECRET_API_KEY!,
            baseUrl: config.env.PORKBUN_BASE_URL || undefined,
          });
        case 'godaddy':
          return new GoDaddyAdapter({ pat: config.env.GODADDY_PAT!, baseUrl: config.env.GODADDY_BASE_URL || undefined });
        default:
          throw new Error(`No adapter implementation for ${a.name}`);
      }
    });
}
