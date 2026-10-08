import { describe, expect, it } from 'vitest';
import { AFTERNIC_HEADER, afternicRow, sedoRow, toCsv, type ExportDomain, type SedoTemplate } from '../../src/modules/listing/export.js';

const d = (over: Partial<ExportDomain>): ExportDomain => ({
  domain: 'example.com', display_name: null, listing_mode: 'bin', bin_cents: 39900, floor_cents: 39900, min_offer_cents: 39900, lto_max_months: null, ...over,
});
const cells = (r: ReturnType<typeof afternicRow>) => ('cells' in r.row ? r.row.cells.join(',') : `SKIP:${r.row.skip}`);

describe('Afternic rows (listing-strategy §6)', () => {
  it('E-1: header byte for byte', () => {
    expect(AFTERNIC_HEADER.join(',')).toBe('Domain,Buy Now Price,Floor Price,Min Offer,Lease to Own,Max Lease Period,Sale Lander,Show Buy Now Option,Show Lease to Own Option,Show Make Offer Option,Hidden');
  });
  it('LX-1: bin 399', () => expect(cells(afternicRow(d({})))).toBe('example.com,399,399,399,N,,Buy It Now,Y,N,N,N'));
  it('LX-2: offer min 500, no floor', () =>
    expect(cells(afternicRow(d({ listing_mode: 'offer', bin_cents: null, floor_cents: null, min_offer_cents: 50000 })))).toBe('example.com,0,,500,N,,Custom Lander,N,N,Y,N'));
  it('LX-3: hybrid 1995/950/950, no LTO', () =>
    expect(cells(afternicRow(d({ listing_mode: 'hybrid', bin_cents: 199500, floor_cents: 95000, min_offer_cents: 95000 })))).toBe('example.com,1995,950,950,N,,Custom Lander,Y,N,Y,N'));
  it('LX-4: hybrid + LTO 24, BIN 4999', () =>
    expect(cells(afternicRow(d({ listing_mode: 'hybrid', bin_cents: 499900, floor_cents: 250000, min_offer_cents: 100000, lto_max_months: 24 })))).toBe('example.com,4999,2500,1000,Y,24,Custom Lander,Y,Y,Y,N'));
  it('LX-7: offer mode writes 0 for Buy Now Price, never blank', () =>
    expect(cells(afternicRow(d({ listing_mode: 'offer', bin_cents: null, floor_cents: 60000, min_offer_cents: 50000 })))).toBe('example.com,0,600,500,N,,Custom Lander,N,N,Y,N'));
  it('E-4: integer USD, no symbol or separator', () =>
    expect(cells(afternicRow(d({ listing_mode: 'hybrid', bin_cents: 12345600, floor_cents: 1000000, min_offer_cents: 500000 })))).toBe('example.com,123456,10000,5000,N,,Custom Lander,Y,N,Y,N'));
  it('cents round DOWN with AFTERNIC_ROUNDS_DOWN', () => {
    const r = afternicRow(d({ bin_cents: 39950, floor_cents: 39950, min_offer_cents: 39950 }));
    expect(cells(r)).toBe('example.com,399,399,399,N,,Buy It Now,Y,N,N,N');
    expect(r.warnings).toEqual(['example.com:AFTERNIC_ROUNDS_DOWN']);
  });
  it('a display name that is not the domain in ASCII case is ignored with a warning (Kelvin sign)', () => {
    const r = afternicRow(d({ domain: 'kelvin.com', display_name: '\u212Aelvin.com' }));
    expect(cells(r)).toBe('kelvin.com,399,399,399,N,,Buy It Now,Y,N,N,N');
    expect(r.warnings).toEqual(['DISPLAY_NAME_IGNORED:kelvin.com']);
    expect(afternicRow(d({ domain: 'kelvin.com', display_name: 'KelVin.com' })).warnings).toEqual([]);
  });
  it('E-3/LX-6: Min Offer below 20 → skipped with a warning', () => {
    const r = afternicRow(d({ listing_mode: 'offer', bin_cents: null, floor_cents: null, min_offer_cents: 1999 }));
    expect(cells(r)).toBe('SKIP:MIN_OFFER_BELOW_20');
    expect(r.warnings).toEqual(['example.com:MIN_OFFER_BELOW_20']);
  });
  it('uses display_name when set', () => expect(cells(afternicRow(d({ domain: 'examplecityroofing.com', display_name: 'ExampleCityRoofing.com' })))).toMatch(/^ExampleCityRoofing\.com,/));
  it('no listing mode → skipped', () => expect(cells(afternicRow(d({ listing_mode: null })))).toBe('SKIP:NOT_LISTED'));
});

describe('toCsv (RFC 4180)', () => {
  it('CRLF, quotes fields with comma/quote/CR/LF, doubles quotes', () => {
    expect(toCsv([['a', 'b,c', 'd"e', 'f\ng'], ['1', '', '2', '3']])).toBe('a,"b,c","d""e","f\ng"\r\n1,,2,3\r\n');
  });
});

const T: SedoTemplate = {
  headers: ['Domain Name', 'Option', 'Sale', 'Price', 'Min', 'Cur', 'Action', 'Notes'],
  map: { domain: 'Domain Name', selling_option: 'Option', for_sale: 'Sale', price: 'Price', min_price: 'Min', currency: 'Cur', action: 'Action' },
  values: { buy_now: 'FIXED', make_offer: 'OFFER', for_sale_yes: 'yes', usd: 'USD', action_add: 'ADD' },
};

describe('Sedo rows (LX-5)', () => {
  it('bin (geo) → make offer, price = BIN, min = BIN', () => expect(sedoRow(d({}), T, 'make_offer')).toEqual(['example.com', 'OFFER', 'yes', '399', '399', 'USD', 'ADD', '']));
  it('offer → make offer + min, no price', () =>
    expect(sedoRow(d({ listing_mode: 'offer', bin_cents: null, floor_cents: null, min_offer_cents: 50000 }), T, 'buy_now')).toEqual(['example.com', 'OFFER', 'yes', '', '500', 'USD', 'ADD', '']));
  it('hybrid with sedo_hybrid_as buy_now → fixed + BIN + no min', () =>
    expect(sedoRow(d({ listing_mode: 'hybrid', bin_cents: 199500, floor_cents: 95000, min_offer_cents: 95000 }), T, 'buy_now')).toEqual(['example.com', 'FIXED', 'yes', '1995', '', 'USD', 'ADD', '']));
  it('hybrid make_offer → make offer + price expectation + min', () =>
    expect(sedoRow(d({ listing_mode: 'hybrid', bin_cents: 199500, floor_cents: 95000, min_offer_cents: 95000 }), T, 'make_offer')).toEqual(['example.com', 'OFFER', 'yes', '1995', '950', 'USD', 'ADD', '']));
});
