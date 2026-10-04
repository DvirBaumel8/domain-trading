import { describe, expect, it } from 'vitest';

describe('network blocking', () => {
  it('fails any unmocked outbound HTTP request', async () => {
    await expect(fetch('https://api.porkbun.com/api/json/v3/ping')).rejects.toThrow(/unhandled|MSW/i);
  });
});
