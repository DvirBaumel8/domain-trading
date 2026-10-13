// v4.0.0 (CR-049 item 1): the Spaceship SellerHub client. Listing only: create, re-price and delete a for-sale listing, read the listings and the sold report.
// Auth is the header pair X-API-Key / X-API-Secret (scopes sellerhub:read and sellerhub:write). The key and secret are never logged, never in an error text, never returned.
// The shapes follow docs.spaceship.dev: a price is {amount: "1488.00", currency: "USD"}; POST/PATCH /v1/sellerhub/domains take the name in the body; DELETE /v1/sellerhub/domains/{domain}.
export interface SellerHubItem {
  name: string; unicodeName?: string; status?: string; binPriceEnabled?: boolean; minPriceEnabled?: boolean;
  binPrice?: { amount: string; currency: string } | null; minPrice?: { amount: string; currency: string } | null;
}
export interface SellerHubSold { name: string; unicodeName?: string; saleDateTime?: string; salePrice?: { amount: string; currency: string } }
export class SellerHubError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'SellerHubError'; }
}
export interface ListingBody { binCents: number | null; minCents: number | null }

const PAGE = 100;
export const amountOf = (cents: number): string => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
/** "1488.00" -> 148800. Null for anything that is not a plain decimal. */
export const centsOfAmount = (a: string | undefined | null): number | null => {
  if (typeof a !== 'string') return null;
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(a);
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0) : null;
};

export class SellerHubClient {
  constructor(private readonly o: { fetch: typeof fetch; baseUrl: string; apiKey: string; apiSecret: string; timeoutMs?: number }) {}

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.o.fetch(`${this.o.baseUrl}${path}`, {
        method, headers: { 'x-api-key': this.o.apiKey, 'x-api-secret': this.o.apiSecret, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
      });
    } catch (e) {
      throw new SellerHubError(0, `SellerHub unreachable (${(e as { name?: string }).name ?? 'error'})`);
    }
    if (res.status === 204) return null;
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new SellerHubError(res.status, `SellerHub ${method} ${path.split('?')[0]} answered ${res.status}`);
    try { return text ? JSON.parse(text) : null; } catch { throw new SellerHubError(res.status, 'SellerHub answered with a body that is not JSON'); }
  }

  private payload(name: string, l: ListingBody) {
    return {
      name, binPriceEnabled: l.binCents !== null, ...(l.binCents !== null ? { binPrice: { amount: amountOf(l.binCents), currency: 'USD' } } : {}),
      minPriceEnabled: l.minCents !== null, ...(l.minCents !== null ? { minPrice: { amount: amountOf(l.minCents), currency: 'USD' } } : {}),
    };
  }

  async list(): Promise<SellerHubItem[]> {
    const out: SellerHubItem[] = [];
    for (let skip = 0; skip < 1000; skip += PAGE) {
      const r = (await this.call('GET', `/v1/sellerhub/domains?take=${PAGE}&skip=${skip}`)) as { items?: SellerHubItem[]; total?: number } | null;
      const items = r?.items ?? [];
      out.push(...items);
      if (items.length < PAGE) break;
    }
    return out;
  }

  async create(name: string, l: ListingBody): Promise<void> { await this.call('POST', '/v1/sellerhub/domains', this.payload(name, l)); }
  async update(name: string, l: ListingBody): Promise<void> { await this.call('PATCH', '/v1/sellerhub/domains', this.payload(name, l)); }
  async remove(name: string): Promise<void> { await this.call('DELETE', `/v1/sellerhub/domains/${encodeURIComponent(name)}`); }
  async sold(): Promise<SellerHubSold[]> {
    const r = (await this.call('GET', `/v1/sellerhub/domains/reports/sold?take=${PAGE}`)) as { items?: SellerHubSold[] } | null;
    return r?.items ?? [];
  }
}
