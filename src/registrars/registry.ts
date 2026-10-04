import type { Config } from '../config.js';

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

/** Adapters with code behind them. Step 2 adds 'porkbun'. */
export const IMPLEMENTED_ADAPTERS: ReadonlySet<string> = new Set<string>();

export function adapterStatus(config: Config): { name: string; enabled: boolean; reason: string | null }[] {
  return Object.entries(REGISTRAR_ENV).map(([name, keys]) => {
    let reason: string | null = null;
    if (!config.enabledRegistrars.includes(name)) reason = 'not in ENABLED_REGISTRARS';
    else if (keys.some((k) => !config.env[k])) reason = 'keys missing';
    else if (!IMPLEMENTED_ADAPTERS.has(name)) reason = 'not implemented';
    return { name, enabled: reason === null, reason };
  });
}
