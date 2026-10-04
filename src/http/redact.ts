const SECRET_KEY = /(secret|password|passwd|token|api[-_]?key|secret[-_]?key|authorization|credential|private[-_]?key|(^|_)pat)s?$/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 10) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    return out;
  }
  return value;
}
