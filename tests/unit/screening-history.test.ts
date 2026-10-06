// Pure parts of the history check (CAP-07): the CDX reader, the decisive-capture picker, the classifier and the business-name reader.
import { describe, expect, it } from 'vitest';
import { businessNameCandidate, nameTokens, pickBusinessName } from '../../src/screening/prior-business.js';
import { visibleText } from '../../src/screening/html-text.js';
import { classifyCapture, matchSignatures, parseCdx, pickDecisive, redirectTarget, timestampMs, toTimestamp, type Capture, type SignatureLists } from '../../src/screening/wayback.js';

const lists: SignatureLists = {
  strong: ['adult:xxx', 'pharma:viagra', 'pbn:buy backlinks'], weak: ['gambling:casino', 'pbn:guest post'],
  parked: ['parked:not yet connected', 'parked:alldomains.com'], forsale: ['forsale:this domain name is for sale', 'forsale:atom.com'],
};
const long = 'our team provides dependable service for homes and offices across the region with friendly staff and honest pricing '.repeat(3);
const cls = (status: number, text = long, location: string | null = null, domain = 'example.com') => classifyCapture({ status, location, text, domain }, lists, 200);

describe('timestamps', () => {
  it('reads a 14-digit UTC timestamp and refuses an impossible one', () => {
    expect(timestampMs('20181025100000')).toBe(Date.UTC(2018, 9, 25, 10));
    expect(timestampMs('20269999999999')).toBeNull();
    expect(timestampMs('2018')).toBeNull();
    expect(toTimestamp(Date.UTC(2026, 9, 4, 13, 16, 5))).toBe('20261004131605');
  });
});

describe('parseCdx', () => {
  const head = ['timestamp', 'original', 'statuscode', 'mimetype', 'digest'];
  it('reads rows by header name; an empty body is "no captures"', () => {
    expect(parseCdx(JSON.stringify([head, ['2018', 'http://a.com/', '200', 'text/html', 'D1']]))).toEqual([{ timestamp: '2018', original: 'http://a.com/', statuscode: '200', mimetype: 'text/html', digest: 'D1' }]);
    expect(parseCdx('')).toEqual([]);
    expect(parseCdx('[]\n')).toEqual([]);
  });
  it('anything else is not CDX: an HTML error page, wrong shape, missing columns, non-string cells', () => {
    expect(parseCdx('<html>error</html>')).toBeNull();
    expect(parseCdx('{"a":1}')).toBeNull();
    expect(parseCdx(JSON.stringify([['timestamp', 'original'], ['1', '2']]))).toBeNull();
    expect(parseCdx(JSON.stringify([head, [1, 2, 3, 4, 5]]))).toBeNull();
  });
});

describe('pickDecisive', () => {
  const c = (ts: string, st = '200', original = 'http://example.com/', mime = 'text/html', digest = `D${ts}`): Capture => ({ timestamp: ts, original, statuscode: st, mimetype: mime, digest });
  it('keeps only redirects and html pages of the name\'s own host, home page first', () => {
    const picked = pickDecisive([
      c('20100101000000'), c('20100102000000', '200', 'http://example.com/robots.txt', 'text/plain'), c('20100103000000', '404'),
      c('20100104000000', '301', 'http://www.example.com/'), c('20100105000000', '200', 'http://example.com/img.png', 'image/png'),
      c('20100106000000', '200', 'http://blog.example.com/'), c('20100107000000', '200', 'http://other.com/'), c('20100108000000', '200', 'http://example.com/about'),
    ], 'example.com', 6);
    expect(picked.map((x) => x.timestamp)).toEqual(['20100101000000', '20100104000000']);
    expect(pickDecisive([c('20100108000000', '200', 'http://example.com/about')], 'example.com', 6)).toHaveLength(1); // no home page: any page
  });
  it('dedupes by digest', () => {
    expect(pickDecisive([c('20100101000000', '200', undefined, undefined, 'SAME'), c('20110101000000', '200', undefined, undefined, 'SAME')], 'example.com', 6)).toHaveLength(1);
  });
  it('over the cap: earliest, latest, one per calendar year in between (thinned evenly), and never more than the cap', () => {
    const all = Array.from({ length: 10 }, (_, i) => c(`${2010 + i}0601000000`));
    expect(pickDecisive(all, 'example.com', 4).map((x) => x.timestamp.slice(0, 4))).toEqual(['2010', '2013', '2016', '2019']);
    expect(pickDecisive(all, 'example.com', 2).map((x) => x.timestamp.slice(0, 4))).toEqual(['2010', '2019']);
    expect(pickDecisive(all, 'example.com', 1).map((x) => x.timestamp.slice(0, 4))).toEqual(['2019']);
    expect(pickDecisive(all, 'example.com', 0)).toEqual([]);
    const sameYear = [c('20100101000000'), c('20100201000000'), c('20100301000000'), c('20100401000000')];
    expect(pickDecisive(sameYear, 'example.com', 3).map((x) => x.timestamp)).toEqual(['20100101000000', '20100201000000', '20100401000000']);
  });
});

describe('redirectTarget', () => {
  it('unwraps the archive\'s own Location form and resolves relative ones', () => {
    expect(redirectTarget('https://web.archive.org/web/20180807083604id_/http://www.other.com/x', 'http://example.com/')).toBe('http://www.other.com/x');
    expect(redirectTarget('/about', 'http://example.com/')).toBe('http://example.com/about');
    expect(redirectTarget('http://web.archive.org/web/2018/other.com/', 'http://example.com/')).toBe('http://other.com/');
    expect(redirectTarget('http://[bad', 'http://example.com/')).toBeNull();
  });
});

describe('classifyCapture', () => {
  it('3xx to another registrable domain is redirect_offsite; to the same site (www, https, a subdomain) is flagged for the caller to ignore', () => {
    expect(cls(302, '', 'https://web.archive.org/web/2018id_/http://thetrocheckgroup.com/')).toMatchObject({ cls: 'redirect_offsite' });
    expect(cls(301, '', 'https://web.archive.org/web/2018id_/https://www.example.com/')).toMatchObject({ sameSiteRedirect: true });
    expect(cls(301, '', '/home')).toMatchObject({ sameSiteRedirect: true });
    expect(cls(302, '', 'http://shop.example.com/')).toMatchObject({ sameSiteRedirect: true });
    expect(cls(302, '', 'http://notexample.com/')).toMatchObject({ cls: 'redirect_offsite' }); // not a subdomain
    expect(cls(302, '', null)).toMatchObject({ cls: 'error' });
  });
  it('a redirect to a for-sale marketplace or parking host is for-sale / parked history, not an off-site redirect', () => {
    expect(cls(302, '', 'http://domains.atom.com/lpd/name/example.com')).toMatchObject({ cls: 'forsale', matched: ['forsale:atom.com'] });
    expect(cls(302, '', 'http://comingsoon.alldomains.com/')).toMatchObject({ cls: 'parked' });
  });
  it('4xx/5xx is error', () => {
    expect(cls(404).cls).toBe('error');
    expect(cls(503).cls).toBe('error');
  });
  it('200: strong beats weak beats for-sale beats parked beats content; thin pages are not content', () => {
    expect(cls(200, `${long} Buy VIAGRA now`)).toMatchObject({ cls: 'harmful_strong', matched: ['pharma:viagra'] });
    expect(cls(200, `${long} online casino bonus`)).toMatchObject({ cls: 'harmful_weak', matched: ['gambling:casino'] });
    expect(cls(200, 'This domain name is for sale. not yet connected')).toMatchObject({ cls: 'forsale' });
    expect(cls(200, 'This domain is not yet connected to a website.')).toMatchObject({ cls: 'parked' });
    expect(cls(200, long)).toMatchObject({ cls: 'content', matched: [] });
    expect(cls(200, 'hello')).toMatchObject({ cls: 'error' });
  });
  it('matches whole words only', () => {
    expect(matchSignatures('the maxxxim pharma', ['adult:xxx'])).toEqual([]);
    expect(matchSignatures('a XXX site', ['adult:xxx'])).toEqual(['adult:xxx']);
    expect(matchSignatures('buy   backlinks   today', ['pbn:buy backlinks'])).toEqual(['pbn:buy backlinks']);
  });
});

describe('prior business name', () => {
  const read = (html: string, domain = 'example.com') => { const v = visibleText(html); return businessNameCandidate({ html, title: v.title, text: v.text, timestamp: '20150101000000' }, domain); };
  it('og:site_name first, then the title\'s first non-generic segment', () => {
    expect(read('<title>Home | Foo</title><meta property="og:site_name" content="Acme Roofing LLC">')).toMatchObject({ name: 'Acme Roofing LLC', source: 'og_site_name' });
    expect(read('<title>Home | Office Prep Solutions Inc</title>')).toMatchObject({ name: 'Office Prep Solutions Inc', source: 'title' });
    expect(read('<title>Acme Plumbing - Best plumber in town</title>')).toMatchObject({ name: 'Acme Plumbing', source: 'title' });
  });
  it('generic titles, the domain itself and sentence-length titles are not names', () => {
    expect(read('<title>Welcome to example.com</title><p>hi</p>')).toBeNull();
    expect(read('<title>Under Construction</title>')).toBeNull();
    expect(read('<title>Home</title>')).toBeNull();
    expect(read('<title>This is a very long sentence that is clearly not a name at all</title>')).toBeNull();
  });
  it('falls back to a company-suffix or copyright line', () => {
    expect(read('<body><p>Contact Blue Ridge Plumbing Co for help</p></body>')).toMatchObject({ name: 'Blue Ridge Plumbing Co', source: 'text_line' });
    expect(read('<body><p>© 2014 Sunrise Dental Group. All rights reserved.</p></body>')).toMatchObject({ source: 'text_line' });
    expect(read('<body><p>just words with no capitals here</p></body>')).toBeNull();
  });
  it('picks the most frequent name; ties go to the more explicit source, then the later capture', () => {
    const c = (name: string, source: 'og_site_name' | 'title' | 'text_line', ts: string) => ({ name, source, timestamp: ts });
    expect(pickBusinessName([c('Acme', 'title', '2010'), c('Beta', 'title', '2012'), c('acme', 'title', '2014')])).toBe('acme');
    expect(pickBusinessName([c('Acme', 'title', '2010'), c('Beta', 'og_site_name', '2012')])).toBe('Beta');
    expect(pickBusinessName([c('Acme', 'title', '2010'), c('Beta', 'title', '2012')])).toBe('Beta');
    expect(pickBusinessName([])).toBeNull();
    expect(nameTokens('Acme & Sons, Inc.')).toEqual(['acme', 'sons', 'inc']);
  });
});
