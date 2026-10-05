import { describe, expect, it } from 'vitest';
import { classify, type OfferSnapshot } from '../../src/services/offer-rules.js';

const d001: OfferSnapshot = { mode: 'hybrid', binCents: 199500, floorCents: 129500, walkawayCents: 95000, minOfferCents: 10000, listingHistoryId: 1, listedAtReceipt: true };
const geo: OfferSnapshot = { mode: 'bin', binCents: 39900, floorCents: null, walkawayCents: null, minOfferCents: 39900, listingHistoryId: 2, listedAtReceipt: true };

describe('offer classifier', () => {
  it('OF-1: below walk-away on afternic is auto-declined, no Gate D', () => {
    const r = classify(d001, 45000, 'afternic');
    expect(r).toMatchObject({ band: 'below_walkaway', routing: 'auto_decline', outcome: 'declined_auto' });
    expect(r.nextStep).toContain('no Gate D');
  });
  it('OF-2: mid-range goes to Dvir', () => {
    expect(classify(d001, 100000, 'afternic')).toMatchObject({ band: 'mid_range', routing: 'dvir', outcome: 'open' });
  });
  it('OF-3: at or above floor', () => {
    const r = classify(d001, 129500, 'afternic');
    expect(r).toMatchObject({ band: 'at_or_above_floor', routing: 'auto_accept' });
    expect(r.warnings).toContain('OFFER_AT_OR_ABOVE_FLOOR');
    expect(classify(d001, 199500, 'afternic').band).toBe('at_or_above_bin');
  });
  it('OF-4: boundaries', () => {
    const b = (a: number) => classify(d001, a, 'afternic').band;
    expect(b(9900)).toBe('below_min');
    expect(b(10000)).toBe('below_walkaway');
    expect(b(94900)).toBe('below_walkaway');
    expect(b(95000)).toBe('mid_range');
    expect(b(129400)).toBe('mid_range');
  });
  it('OF-5: email routing', () => {
    expect(classify(d001, 120000, 'email_inbound').routing).toBe('dvir');
    expect(classify(d001, 60000, 'email_inbound').routing).toBe('auto_decline');
    expect(classify(d001, 60000, 'email_inbound').nextStep).toContain('Dvir sends it');
    expect(classify(d001, 199500, 'outbound_reply').routing).toBe('dvir');
  });
  it('OF-6: geo fixed price', () => {
    const r = classify(geo, 35000, 'afternic');
    expect(r).toMatchObject({ band: 'geo_below_bin', routing: 'auto_decline', outcome: 'declined_auto' });
    expect(r.nextStep).toContain('$399');
    expect(classify(geo, 39900, 'afternic').band).toBe('at_or_above_bin');
  });
  it('O1/O2 rows', () => {
    const offer: OfferSnapshot = { mode: 'offer', binCents: null, floorCents: null, walkawayCents: null, minOfferCents: 50000, listingHistoryId: 3, listedAtReceipt: true };
    expect(classify(offer, 40000, 'sedo').band).toBe('below_min');
    expect(classify(offer, 60000, 'sedo').band).toBe('mid_range');
    const bin: OfferSnapshot = { mode: 'bin', binCents: 99900, floorCents: null, walkawayCents: null, minOfferCents: 99900, listingHistoryId: 4, listedAtReceipt: true };
    expect(classify(bin, 90000, 'sedo').band).toBe('geo_below_bin');
    expect(classify(bin, 90000, 'sedo').nextStep).toContain('$999');
    const none: OfferSnapshot = { mode: null, binCents: null, floorCents: null, walkawayCents: null, minOfferCents: null, listingHistoryId: null, listedAtReceipt: false };
    expect(classify(none, 50000, 'afternic')).toMatchObject({ band: 'unpriced', routing: 'dvir', outcome: 'open', nextStep: 'No prices in force: ask Dvir.' });
    expect(classify(d001, 130000, 'sedo')).toMatchObject({ routing: 'accept_preapproved', warnings: [] });
    expect(classify(d001, 199500, 'email_inbound').routing).toBe('dvir');
  });
  it('unlisted warning', () => {
    expect(classify({ ...d001, listedAtReceipt: false }, 100000, 'afternic').warnings).toContain('OFFER_ON_UNLISTED');
  });
});
