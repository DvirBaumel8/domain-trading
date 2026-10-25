// CR-078 rule 1 (founder rule 9): the knowledge base stores, deduplicates and computes in plain code. No model or AI client may appear in the module.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));

describe('knowledge module has no AI (CR-078)', () => {
  it('KB543-23: src/modules/knowledge imports and mentions no model or AI client (gemini, openai, anthropic, generativelanguage, langchain)', () => {
    const list = files('src/modules/knowledge');
    expect(list.length).toBeGreaterThan(5);
    const hits = list.filter((f) => /gemini|openai|anthropic|generativelanguage|langchain|llm/i.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
