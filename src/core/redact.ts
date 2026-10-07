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

const FREE_TEXT_KEYS = new Set(['text', 'term', 'note', 'reason', 'alt']);

/**
 * v2.12.0: bodies of /posts* too (text, alt text, reason, and image data as base64).
 * v2.10.0: bodies of /company/* and /reviews/* carry free text (a document, a forbidden term, review items) that the block list may
 * refuse because it holds a secret, an address or a listed term. The audit row keeps the shape and the length, never the text.
 */
export function redactFreeText(value: unknown, depth = 0): unknown {
  if (depth > 10) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((v) => redactFreeText(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // v2.12.0: image data (base64 in POST /posts) never reaches the audit row, only its length.
      out[k] = k === 'data_base64' && typeof v === 'string' ? `[IMAGE ${v.length} chars]`
        : FREE_TEXT_KEYS.has(k) && typeof v === 'string' ? `[TEXT ${v.length} chars]` : redactFreeText(v, depth + 1);
    }
    return out;
  }
  return value;
}

export const REDACTED = '[REDACTED]';

/** Replaces every occurrence of each non-empty secret value in `text` (an API key, a token) with [REDACTED]. */
export function scrubSecrets(text: string, secrets: Iterable<string | undefined | null>): string {
  let m = text;
  for (const v of secrets) if (v) m = m.split(v).join(REDACTED);
  return m;
}
