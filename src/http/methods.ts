/**
 * Routes that use POST only to carry a query in a body (the answer changes nothing the caller owns): READ scope, no Idempotency-Key, no audit row.
 * The such routes are POST /score (v5.5.0, CR-056) and POST /rdap/batch (v5.29.0, CR-074: it writes only the RDAP cache and the lookup usage log); founder rule 8 (every POST is idempotent and audited) is about writes. Matched on the routed pattern.
 */
const READ_ONLY_POSTS: ReadonlySet<string> = new Set(['/score', '/rdap/batch']);

/** Methods that change state: they need WRITE scope, an Idempotency-Key and an audit row. `routeUrl` is the routed pattern (req.routeOptions.url) when known. */
export function isMutating(method: string, routeUrl?: string): boolean {
  if (method === 'POST' && routeUrl !== undefined && READ_ONLY_POSTS.has(routeUrl)) return false;
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}
