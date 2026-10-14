/**
 * Routes that use POST only to carry a query in a body (the answer changes nothing the caller owns): READ scope, no Idempotency-Key, no audit row.
 * The one such route is POST /score (v5.5.0, CR-056); founder rule 8 (every POST is idempotent and audited) is about writes. Matched on the routed pattern.
 */
export const READ_ONLY_POSTS: ReadonlySet<string> = new Set(['/score']);

/** Methods that change state: they need WRITE scope, an Idempotency-Key and an audit row. `routeUrl` is the routed pattern (req.routeOptions.url) when known. */
export function isMutating(method: string, routeUrl?: string): boolean {
  if (method === 'POST' && routeUrl !== undefined && READ_ONLY_POSTS.has(routeUrl)) return false;
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}
