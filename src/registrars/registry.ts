import type { Config } from '../config.js';
import { PorkbunAdapter } from './porkbun.js';
import type { RegistrarAdapter } from './types.js';

/** The registrars `/check` may pick (founder rule 5: never Cloudflare). */
export const ALLOWED_REGISTRARS: readonly string[] = ['porkbun'];

export function createAdapters(config: Config): RegistrarAdapter[] {
  return config.porkbun ? [new PorkbunAdapter(config.porkbun)] : [];
}
