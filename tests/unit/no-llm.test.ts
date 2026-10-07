import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

/** The one file allowed to name an AI provider host, and the only host it may name (founder rule 9, changed 7 Oct 2026). */
const GEMINI_FILE = join('src', 'services', 'review', 'gemini.ts');
const BANNED_HOSTS = /api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|api\.mistral\.ai|api\.cohere\.(ai|com)|openrouter\.ai/gi;
const BANNED_SDK = /from ['"](@anthropic-ai|openai|@google\/genai|@google\/generative-ai|@ai-sdk)/i;

/** Returns what is wrong with one source file, or null. */
function violation(file: string, source: string): string | null {
  if (BANNED_SDK.test(source)) return `${file}: imports an AI SDK`;
  const hosts = [...new Set((source.match(BANNED_HOSTS) ?? []).map((h) => h.toLowerCase()))];
  if (hosts.length === 0) return null;
  if (file !== GEMINI_FILE) return `${file}: names a provider host (${hosts.join(', ')})`;
  const other = hosts.filter((h) => h !== 'generativelanguage.googleapis.com');
  return other.length > 0 ? `${file}: names a host other than Gemini (${other.join(', ')})` : null;
}

describe('founder rule 9: one AI call only, the outside review (static)', () => {
  it('no LLM SDK dependency in package.json', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies?: Record<string, string> };
    const banned = /anthropic|openai|@google\/(genai|generative-ai)|@mistralai|cohere|langchain|ollama|llamaindex|@ai-sdk|\bai$/i;
    expect(Object.keys(pkg.dependencies ?? {}).filter((d) => banned.test(d))).toEqual([]);
  });

  it('provider hosts appear only in src/services/review/gemini.ts, and only the Gemini host there; no SDK import anywhere', () => {
    const problems = files('src').map((f) => violation(f, readFileSync(f, 'utf8'))).filter((x) => x !== null);
    expect(problems).toEqual([]);
    expect(readFileSync(GEMINI_FILE, 'utf8')).toContain('generativelanguage.googleapis.com');
  });

  it('the checker fails a provider host in another file, a second host in gemini.ts, and an SDK import', () => {
    expect(violation('src/other.ts', "fetch('https://generativelanguage.googleapis.com/x')")).toMatch(/provider host/);
    expect(violation('src/other.ts', "const u = 'https://api.openai.com/v1'")).toMatch(/provider host/);
    expect(violation(GEMINI_FILE, "'https://api.anthropic.com' + 'https://generativelanguage.googleapis.com'")).toMatch(/other than Gemini/);
    expect(violation('src/x.ts', "import OpenAI from 'openai'")).toMatch(/SDK/);
    expect(violation(GEMINI_FILE, "const H = 'https://generativelanguage.googleapis.com'")).toBeNull();
    expect(violation('src/x.ts', 'const a = 1')).toBeNull();
  });
});
