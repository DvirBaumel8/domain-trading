// The ONLY file in the service that contacts an AI provider (founder rule 9, changed 7 Oct 2026: one capped outside review, Gemini).
// Header key (never in a URL), 60 s timeout, advice only. The key is never logged, stored or returned.
import { z } from 'zod';

export const GEMINI_HOST = 'https://generativelanguage.googleapis.com';
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
export const GEMINI_TIMEOUT_MS = 60_000;
/** List price in USD per million tokens, written in code (CR-011 v2.11.0). */
export const GEMINI_INPUT_USD_PER_M = 0.30;
export const GEMINI_OUTPUT_USD_PER_M = 2.50;
export const REVIEW_CATEGORIES = ['strategy', 'pricing', 'risk', 'operations', 'data', 'cost', 'other'] as const;

export const REVIEWER_INSTRUCTION = [
  'You are an outside reviewer of a small domain-trading company run by bots.',
  'Read the document, the changes and the numbers in the user message.',
  'Give at most 10 concrete feedback items.',
  `Each item has a category (one of ${REVIEW_CATEGORIES.join(', ')}), a severity (low, medium or high) and a text of at most 600 characters.`,
  'Give advice only. Never ask for secrets, keys or credentials.',
  'Reply only with JSON that follows the response schema.',
].join(' ');

export interface GeminiItem { category: string; severity: 'low' | 'medium' | 'high'; text: string }
export type GeminiResult =
  | { kind: 'ok'; items: GeminiItem[]; inputTokens: number; outputTokens: number; model: string }
  | { kind: 'unknown'; httpStatus: number | null; errorStatus: string | null; reason: string };

/** Cost in USD from Google's token counts, rounded to 4 decimals. */
export function geminiCostUsd(inputTokens: number, outputTokens: number): number {
  return Math.round((inputTokens / 1e6 * GEMINI_INPUT_USD_PER_M + outputTokens / 1e6 * GEMINI_OUTPUT_USD_PER_M) * 10_000) / 10_000;
}

const Answer = z.object({
  items: z.array(z.object({
    category: z.string(),
    severity: z.enum(['low', 'medium', 'high']),
    text: z.string().min(1),
  })).max(50),
});

const unknownOf = (reason: string, httpStatus: number | null = null, errorStatus: string | null = null): GeminiResult => ({ kind: 'unknown', httpStatus, errorStatus, reason: reason.slice(0, 300) });

function errorOf(text: string): { status: string | null; message: string | null } {
  try {
    const e = (JSON.parse(text) as { error?: { status?: unknown; message?: unknown } } | null)?.error;
    return { status: typeof e?.status === 'string' ? e.status.slice(0, 80) : null, message: typeof e?.message === 'string' ? e.message.slice(0, 200) : null };
  } catch {
    return { status: null, message: null };
  }
}

export async function callGemini(
  deps: { fetch: typeof fetch; apiKey: string; model?: string; timeoutMs?: number },
  packetContent: string,
): Promise<GeminiResult> {
  const model = deps.model || DEFAULT_GEMINI_MODEL;
  const body = {
    systemInstruction: { parts: [{ text: REVIEWER_INSTRUCTION }] },
    contents: [{ role: 'user', parts: [{ text: packetContent }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: { items: { type: 'ARRAY', items: { type: 'OBJECT', properties: { category: { type: 'STRING' }, severity: { type: 'STRING', enum: ['low', 'medium', 'high'] }, text: { type: 'STRING' } }, required: ['category', 'severity', 'text'] } } },
        required: ['items'],
      },
      temperature: 0.2,
    },
  };
  let httpStatus: number | null = null;
  try {
    const res = await deps.fetch(`${GEMINI_HOST}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': deps.apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deps.timeoutMs ?? GEMINI_TIMEOUT_MS),
    });
    httpStatus = res.status;
    const text = (await res.text().catch(() => '')).slice(0, 2_000_000);
    if (res.status !== 200) {
      const e = errorOf(text);
      return unknownOf(e.message ?? 'no error body', res.status, e.status);
    }
    let j: { candidates?: { finishReason?: string; content?: { parts?: { text?: unknown }[] } }[]; usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown } };
    try { j = JSON.parse(text); } catch { return unknownOf('response is not JSON', httpStatus); }
    const cand = j.candidates?.[0];
    if (!cand) return unknownOf('no candidate in the response', httpStatus);
    if (cand.finishReason && cand.finishReason !== 'STOP') return unknownOf(`finishReason ${cand.finishReason}`, httpStatus);
    const part = cand.content?.parts?.[0]?.text;
    if (typeof part !== 'string') return unknownOf('no text part in the candidate', httpStatus);
    let parsed: z.infer<typeof Answer>;
    try { parsed = Answer.parse(JSON.parse(part)); } catch { return unknownOf('the answer is not the expected JSON', httpStatus); }
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
    const items = parsed.items.slice(0, 10).map((i) => {
      const c = i.category.trim().toLowerCase();
      return { category: (REVIEW_CATEGORIES as readonly string[]).includes(c) ? c : 'other', severity: i.severity, text: i.text.slice(0, 2000) };
    });
    return { kind: 'ok', items, inputTokens: num(j.usageMetadata?.promptTokenCount), outputTokens: num(j.usageMetadata?.candidatesTokenCount), model };
  } catch (e) {
    const name = (e as Error).name;
    return unknownOf(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network error', httpStatus);
  }
}
