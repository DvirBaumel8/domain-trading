// CR-050 part 1 (v4.1.0): pure parts of the sibling scan (contact page, lead points mapping, settings defaults). No DB, no network.
import { describe, expect, it } from 'vitest';
import { RDAP_FALLBACK_BASES } from '../../../../src/core/rdap.js';
import { lookalikeNames, wordHyphenNames } from '../../../../src/modules/selection/checks/lookalikes.js';
import { anchorLinks } from '../../../../src/modules/selection/html-text.js';
import { DEFAULT_SELECTION_VALUES, SelectionValues, SIBLINGS_DEFAULT } from '../../../../src/modules/selection/settings.js';
import { contactUrlOf, isDefaultPageTitle, leadPointsOf } from '../../../../src/modules/selection/sibling-scan.js';

const S = DEFAULT_SELECTION_VALUES.siblings;
const live = { live_business: true, site_state: 'in_use' };
const parked = { live_business: false, site_state: 'parked_or_for_sale' };
const none = { live_business: false, site_state: null };

describe('CR-050 contact page', () => {
  const base = 'https://acme.net/';
  it('SIB-U1 a /contact link on the same site is returned as a URL without query or fragment', () => {
    expect(contactUrlOf('<a href="/about">About</a><a href="/contact-us?ref=x#top">Reach us</a>', base)).toBe('https://acme.net/contact-us');
  });
  it('SIB-U2 a link whose text says contact counts even when the path does not', () => {
    expect(contactUrlOf('<a class="b" href="/get-in-touch">Contact us</a>', base)).toBe('https://acme.net/get-in-touch');
  });
  it('SIB-U3 www and relative links resolve against the final URL; another site, mailto: and credentials are never taken', () => {
    expect(contactUrlOf('<a href="https://other.example/contact">Contact</a><a href="mailto:jane@acme.net">Contact</a><a href="https://u:p@acme.net/contact">Contact</a>', base)).toBeNull();
    expect(contactUrlOf('<a href="https://www.acme.net/contact">Contact</a>', base)).toBe('https://www.acme.net/contact');
  });
  it('SIB-U4 no contact link gives null; a page with an email address in the text gives no email', () => {
    expect(contactUrlOf('<p>Write to jane@acme.net</p><a href="/pricing">Pricing</a>', base)).toBeNull();
  });
  it('SIB-U5 anchorLinks reads href and text by forward scan and ignores <abbr>, <article> and unterminated tags', () => {
    const links = anchorLinks('<abbr title="x">a</abbr><article>t</article><a href=\'/x\'>One <b>two</b></a><a href="/y"');
    expect(links).toEqual([{ href: '/x', text: 'One two' }]);
  });
});

describe('CR-050 lead points', () => {
  it('SIB-U6 0 when nothing is registered', () => {
    expect(leadPointsOf([none, none], S)).toMatchObject({ points: 0, live_n: 0, parked_n: 0 });
  });
  it('SIB-U7 10 per live sibling and 2 per registered-but-parked one', () => {
    expect(leadPointsOf([live, parked], S)).toMatchObject({ points: 12, live_n: 1, parked_n: 1 });
    expect(leadPointsOf([live, live, parked, parked], S)).toMatchObject({ points: 24, live_n: 2, parked_n: 2 });
  });
  it('SIB-U8 live counts up to 3 (30), parked up to 3 (6), the total is capped at max (30)', () => {
    expect(leadPointsOf([live, live, live, live, live], S)).toMatchObject({ points: 30, live_n: 5 });
    expect(leadPointsOf([live, live, live, parked, parked, parked, parked], S)).toMatchObject({ points: 30, live_n: 3, parked_n: 4 });
    expect(leadPointsOf([live, live, parked, parked, parked, parked, parked], S).points).toBe(26); // 20 + 3 x 2
  });
  it('SIB-U9 the weights are the settings: nothing is hard-coded', () => {
    const t = { ...S, points_live: 7, points_parked: 1, max: 12, live_counted_max: 5, parked_counted_max: 5 };
    expect(leadPointsOf([live, live, live, parked], t)).toMatchObject({ points: 12 }); // 22 capped at 12
    expect(leadPointsOf([live, parked, parked], { ...t, max: 100 }).points).toBe(9);
  });
  it('SIB-U10 the formula states the mapping with the counts', () => {
    expect(leadPointsOf([live, parked], S).formula).toBe('min(30, 10 x 1 live (of 1, counted up to 3) + 2 x 1 parked (of 1, counted up to 3)) = 12');
  });
  it('SIB-U11 a redirect off the site counts as registered-but-not-live (2); unknown and not registered add nothing', () => {
    const r = { live_business: false, site_state: 'redirect_off_domain' };
    const u = { live_business: null, site_state: null };
    expect(leadPointsOf([r, u, none], S)).toMatchObject({ points: 2, live_n: 0, parked_n: 1 });
  });
});

describe('CR-050 settings', () => {
  it('SIB-U12 the defaults: points 10 / 2, max 30, endings net org io co ai us co.uk', () => {
    expect(DEFAULT_SELECTION_VALUES.siblings).toBe(SIBLINGS_DEFAULT);
    expect(S).toMatchObject({ points_live: 10, points_parked: 2, max: 30, endings: ['net', 'org', 'io', 'co', 'ai', 'us', 'co.uk'] });
  });
  it('SIB-U13 a stored settings document without a siblings key parses to the defaults; a wrong type is refused', () => {
    const { siblings: _drop, ...old } = DEFAULT_SELECTION_VALUES;
    expect(SelectionValues.parse(old).siblings).toEqual(SIBLINGS_DEFAULT);
    expect(SelectionValues.safeParse({ ...old, siblings: { ...SIBLINGS_DEFAULT, points_live: 'x' } }).success).toBe(false);
    expect(SelectionValues.safeParse({ ...old, siblings: { ...SIBLINGS_DEFAULT, extra: 1 } }).success).toBe(false);
  });
});

describe('CR-052 hyphen forms and RDAP fallbacks (v4.2.1)', () => {
  const dict = new Set(['compliance', 'labeling', 'audit', 'testing', 'consulting', 'roofing', 'agent', 'voice']);
  const hy = (sld: string, tokens: string[] = []) => lookalikeNames(sld, tokens, { endings: [], prefixes: [] }, dict).map((n) => n.domain);

  it('SIB-U20 the hyphen goes before the longest word ending the name, so an acronym stays whole (drs-compliance, not dr-sc-om-pl-ian-ce)', () => {
    expect(hy('drscompliance', ['dr', 'sc', 'om', 'pl', 'ian', 'ce'])).toEqual(['drs-compliance.com']);
    expect(hy('ppwrlabelling')).toEqual(['ppwr-labelling.com']); // British double l
  });
  it('SIB-U21 an acronym with its number stays whole; the letter/number split is only in the all-points form', () => {
    expect(hy('fsma204audit')).toEqual(['fsma204-audit.com', 'fsma-204-audit.com']);
    expect(hy('ets2compliance')).toEqual(['ets2-compliance.com', 'ets-2-compliance.com']);
  });
  it('SIB-U22 a word starting the name, both points, and the form split when it has at most three pieces', () => {
    expect(hy('roofingvoiceagent', ['roofing', 'voice', 'agent'])).toEqual(['roofing-voiceagent.com', 'roofingvoice-agent.com', 'roofing-voice-agent.com']);
    expect(wordHyphenNames('abcxyz', dict)).toEqual([]);
  });
  it('SIB-U23 co, us and io have RDAP servers although IANA lists none', () => {
    expect(Object.keys(RDAP_FALLBACK_BASES).sort()).toEqual(['co', 'io', 'us']);
    for (const b of Object.values(RDAP_FALLBACK_BASES)) expect(b).toMatch(/^https:\/\/[a-z.]+\/([a-z]+\/)?$/);
  });
});

describe('CR-052 follow-up (v4.2.2)', () => {
  it('SIB-U24 hosting default and placeholder page titles are recognised; real business titles are not', () => {
    for (const t of ['Default Site - Home', 'Welcome to nginx!', 'Apache2 Ubuntu Default Page: It works', 'Index of /', 'Coming Soon', 'Site under construction', 'Future home of something quite cool'])
      expect(isDefaultPageTitle(t), t).toBe(true);
    for (const t of ['DRS Compliance | Deposit Return Scheme consultants', 'Acme Roofing - Home', 'Default Risk Analytics Ltd'])
      expect(isDefaultPageTitle(t), t).toBe(false);
  });
  it('SIB-U25 a default page counts as registered-but-not-live (parked points), never live', () => {
    expect(leadPointsOf([{ live_business: false, site_state: 'default_page' }], S)).toMatchObject({ live_n: 0, parked_n: 1, points: 2 });
  });
  it('SIB-U26 with a dictionary, a form split with a piece under 3 letters is not used (no ppwr-la-belling)', () => {
    const dict = new Set(['labeling', 'belling']);
    expect(lookalikeNames('ppwrlabelling', ['ppwr', 'la', 'belling'], { endings: [], prefixes: [] }, dict).map((n) => n.domain)).toEqual(['ppwr-labelling.com']);
  });
});
