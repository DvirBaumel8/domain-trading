/** Methods that change state: they need WRITE scope, an Idempotency-Key and an audit row. */
export function isMutating(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}
