import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

const BANNED_HOSTS = /api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|api\.mistral\.ai|api\.cohere\.(ai|com)|openrouter\.ai/gi;
const BANNED_SDK = /from ['"](@anthropic-ai|openai|@google\/genai|@google\/generative-ai|@ai-sdk)/i;

/** Returns what is wrong with one source file, or null. */
function violation(file: string, source: string): string | null {
  if (BANNED_SDK.test(source)) return `${file}: imports an AI SDK`;
  const hosts = [...new Set((source.match(BANNED_HOSTS) ?? []).map((h) => h.toLowerCase()))];
  return hosts.length === 0 ? null : `${file}: names a provider host (${hosts.join(', ')})`;
}

describe('founder rule 9: no AI calls inside the service (static; the outside review was removed on 26 Oct 2026)', () => {
  it('no LLM SDK dependency in package.json', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies?: Record<string, string> };
    const banned = /anthropic|openai|@google\/(genai|generative-ai)|@mistralai|cohere|langchain|ollama|llamaindex|@ai-sdk|\bai$/i;
    expect(Object.keys(pkg.dependencies ?? {}).filter((d) => banned.test(d))).toEqual([]);
  });

  it('no provider host and no SDK import anywhere in src/', () => {
    const problems = files('src').map((f) => violation(f, readFileSync(f, 'utf8'))).filter((x) => x !== null);
    expect(problems).toEqual([]);
  });

  it('the checker fails a provider host and an SDK import', () => {
    expect(violation('src/other.ts', "fetch('https://generativelanguage.googleapis.com/x')")).toMatch(/provider host/);
    expect(violation('src/other.ts', "const u = 'https://api.openai.com/v1'")).toMatch(/provider host/);
    expect(violation('src/x.ts', "import OpenAI from 'openai'")).toMatch(/SDK/);
    expect(violation('src/x.ts', 'const a = 1')).toBeNull();
  });
});
