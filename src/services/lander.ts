const LANDERS: Record<string, readonly string[]> = {
  afternic: ['ns1.afternic.com', 'ns2.afternic.com'],
  sedo: ['ns1.sedoparking.com', 'ns2.sedoparking.com'],
};

/** Nameservers for a configured lander; null for 'custom' (needs explicit ns via /list). */
export function landerNameservers(target: string): readonly string[] | null {
  return LANDERS[target] ?? null;
}

const norm = (n: string) => n.trim().toLowerCase().replace(/\.$/, '');

export function sameNsSet(a: Iterable<string>, b: Iterable<string>): boolean {
  const x = new Set([...a].map(norm));
  const y = new Set([...b].map(norm));
  return x.size === y.size && [...x].every((n) => y.has(n));
}
