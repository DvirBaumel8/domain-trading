import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe('founder rule 9: no LLM calls inside the service (static)', () => {
  it('no LLM SDK dependency in package.json', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies?: Record<string, string> };
    const banned = /anthropic|openai|@google\/(genai|generative-ai)|@mistralai|cohere|langchain|ollama|llamaindex|@ai-sdk|\bai$/i;
    expect(Object.keys(pkg.dependencies ?? {}).filter((d) => banned.test(d))).toEqual([]);
  });

  it('no source file names an LLM provider host or SDK import', () => {
    const banned = /api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|api\.mistral\.ai|api\.cohere\.(ai|com)|openrouter\.ai|from ['"](@anthropic-ai|openai|@google\/genai|@ai-sdk)/i;
    const hits = files('src').filter((f) => banned.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
