// The whole-phrase signature matcher and the bounded body reader shared by the business-site fetcher (site.ts).
import { describe, expect, it } from 'vitest';
import { makeMatcher, readCapped } from '../../../../src/modules/selection/capped-read.js';

describe('makeMatcher', () => {
  it('matches whole words only, case-insensitively, runs of spaces equal', () => {
    expect(makeMatcher(['adult:xxx'])('the maxxxim pharma')).toEqual([]);
    expect(makeMatcher(['adult:xxx'])('a XXX site')).toEqual(['adult:xxx']);
    expect(makeMatcher(['pbn:buy backlinks'])('buy   backlinks   today')).toEqual(['pbn:buy backlinks']);
  });
});

describe('readCapped', () => {
  it('cuts a body at the cap and says so; honours the declared charset', async () => {
    const r = await readCapped(new Response('x'.repeat(100)), 10);
    expect(r).toEqual({ text: 'x'.repeat(10), cut: true });
    const latin = await readCapped(new Response(Buffer.from([0x63, 0x61, 0x66, 0xe9]), { headers: { 'content-type': 'text/html; charset=ISO-8859-1' } }), 100);
    expect(latin).toEqual({ text: 'café', cut: false });
  });
});
