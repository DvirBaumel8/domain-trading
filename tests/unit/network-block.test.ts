import { describe, expect, it } from 'vitest';

describe('network blocking', () => {
  it('fails any unmocked outbound HTTP request', async () => {
    await expect(fetch('https://api.porkbun.com/api/json/v3/ping')).rejects.toThrow(/unhandled|MSW/i);
  });

  it('also blocks URLs MSW treats as static assets (.csv, .json, .zip): the popularity list and the IANA bootstrap', async () => {
    for (const url of ['https://downloads.majestic.com/majestic_million.csv', 'https://data.iana.org/rdap/dns.json', 'https://example.com/a.zip']) {
      await expect(fetch(url)).rejects.toThrow();
    }
  });
});
