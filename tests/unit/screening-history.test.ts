// Pure parts of the history check (CAP-07): the CDX reader, the decisive-capture picker, the classifier and the business-name reader.
import { describe, expect, it } from 'vitest';
import { businessNameCandidate, nameTokens, pickBusinessName } from '../../src/modules/selection/prior-business.js';
import { hiddenSignals, metaRefreshTarget, visibleText } from '../../src/modules/selection/html-text.js';
import { failClassOf } from '../../src/modules/selection/checks/history.js';
import { classifyCapture, matchSignatures, parseCdx, pickDecisive, redirectTarget, scanPaths, timestampMs, toTimestamp, type Capture, type SignatureLists } from '../../src/modules/selection/wayback.js';

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
    expect(parseCdx('[]\n')).toEqual([]);
  });
  it('anything else is not CDX: an EMPTY body (a proxy answering nothing), an HTML error page, wrong shape, missing columns, non-string cells', () => {
    expect(parseCdx('')).toBeNull();
    expect(parseCdx('  \n')).toBeNull();
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
  it('over the cap with few years: free slots go to the other content changes, not left unused', () => {
    const same = [c('20100101000000'), c('20100201000000'), c('20100301000000'), c('20100401000000'), c('20100501000000'), c('20110101000000')];
    const got = pickDecisive(same, 'example.com', 5).map((x) => x.timestamp);
    expect(got).toHaveLength(5);
    expect(got[0]).toBe('20100101000000');
    expect(got.at(-1)).toBe('20110101000000');
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
  it('200: strong beats weak beats a full-page for-sale line beats content; thin pages are not content', () => {
    expect(cls(200, `${long} Buy VIAGRA now`)).toMatchObject({ cls: 'harmful_strong', matched: ['pharma:viagra'] });
    expect(cls(200, `${long} online casino bonus`)).toMatchObject({ cls: 'harmful_weak', matched: ['gambling:casino'] });
    expect(cls(200, 'This domain name is for sale. not yet connected')).toMatchObject({ cls: 'forsale' });
    expect(cls(200, 'This domain is not yet connected to a website.')).toMatchObject({ cls: 'parked' });
    expect(cls(200, long)).toMatchObject({ cls: 'content', matched: [] });
    expect(cls(200, 'hello')).toMatchObject({ cls: 'error' });
  });
  it('parked and for-sale come BEFORE harmful: ads on a placeholder are adMatches (a FLAG), never harmful_strong', () => {
    expect(cls(200, 'This domain is not yet connected. Sponsored: buy viagra, xxx')).toMatchObject({ cls: 'parked', adMatches: ['adult:xxx', 'pharma:viagra'] });
    expect(cls(200, 'This domain name is for sale. Related: viagra')).toMatchObject({ cls: 'forsale', adMatches: ['pharma:viagra'] });
    // the override needs a THIN page for both signatures: a long page with a parking phrase or a for-sale line is judged on its content
    expect(cls(200, `${long.repeat(20)} not yet connected viagra`)).toMatchObject({ cls: 'harmful_strong' });
    expect(cls(200, `${long.repeat(20)} this domain name is for sale. Buy viagra`)).toMatchObject({ cls: 'harmful_strong' });
    expect(cls(200, `${long.repeat(20)} not yet connected`)).toMatchObject({ cls: 'content' });
    // the threshold is a setting
    expect(classifyCapture({ status: 200, location: null, text: `${long} this domain name is for sale. viagra`, domain: 'example.com' }, lists, 200, 100_000)).toMatchObject({ cls: 'forsale', adMatches: ['pharma:viagra'] });
    expect(classifyCapture({ status: 200, location: null, text: `${long} this domain name is for sale. viagra`, domain: 'example.com' }, lists, 200, 50)).toMatchObject({ cls: 'harmful_strong' });
  });
  it('meta description, keywords and alt text (extra) feed only the weak list', () => {
    const c = (extra: string) => classifyCapture({ status: 200, location: null, text: long, domain: 'example.com', extra }, lists, 200);
    expect(c('online casino bonus')).toMatchObject({ cls: 'harmful_weak' });
    expect(c('buy viagra xxx')).toMatchObject({ cls: 'content' });
  });
  it('matches whole words only', () => {
    expect(matchSignatures('the maxxxim pharma', ['adult:xxx'])).toEqual([]);
    expect(matchSignatures('a XXX site', ['adult:xxx'])).toEqual(['adult:xxx']);
    expect(matchSignatures('buy   backlinks   today', ['pbn:buy backlinks'])).toEqual(['pbn:buy backlinks']);
  });
});

describe('scanPaths (no-fetch scan of archived URLs)', () => {
  const row = (original: string): Capture => ({ timestamp: '20190101000000', original, statuscode: '200', mimetype: 'text/html', digest: original });
  const l = { strong: ['pharma:buy xanax'], weak: ['gambling:casino'] };
  it('flags subdomain labels and path words that match the signature phrases or the URL terms, as whole words', () => {
    const hits = scanPaths([row('http://example.com/'), row('http://example.com/cheap-viagra-online'), row('http://casino.example.com/'), row('http://example.com/buy-xanax/page'), row('http://example.com/about'), row('http://example.com/xxxl-sizes')], 'example.com', l, ['viagra', 'xxx']);
    expect(hits.map((h) => h.url)).toEqual(['http://example.com/cheap-viagra-online', 'http://casino.example.com/', 'http://example.com/buy-xanax/page']);
    expect(hits[0]!.matched).toEqual(['url:viagra']);
  });
  it('is bounded', () => {
    const many = Array.from({ length: 100 }, (_, i) => row(`http://example.com/viagra-${i}`));
    expect(scanPaths(many, 'example.com', l, ['viagra'])).toHaveLength(20);
  });
});

describe('prior business name', () => {
  const read = (html: string, domain = 'example.com') => { const v = visibleText(html); return businessNameCandidate({ html, title: v.title, text: v.text, timestamp: '20150101000000' }, domain); };
  it('og:site_name first, then the title\'s first non-generic segment', () => {
    expect(read('<title>Home | Foo</title><meta property="og:site_name" content="Acme Roofing LLC">')).toMatchObject({ name: 'Acme Roofing LLC', source: 'og_site_name' });
    expect(read('<title>Home | Office Prep Solutions Inc</title>')).toMatchObject({ name: 'Office Prep Solutions Inc', source: 'title' });
    expect(read('<title>Acme Plumbing - Best plumber in town</title>')).toMatchObject({ name: 'Acme Plumbing', source: 'title' });
  });
  it.each([
    'Index of /', 'Index of /uploads', '403 Forbidden', '404 Not Found', 'Forbidden', 'Account Suspended', 'This Account has been suspended', 'Hello world!', 'Coming Soon',
    'Contact Us', 'Privacy Policy', 'Terms of Service', 'Home', 'Welcome', 'Error 404', 'Apache2 Ubuntu Default Page', 'Under Construction', 'Default Web Site Page',
  ])('the error, placeholder or navigation title %j is not a name', (t) => {
    expect(read(`<title>${t}</title><p>x</p>`)).toBeNull();
  });
  it('a sentence-length title is not a name', () => {
    expect(read('<title>This is a very long sentence that is clearly not a name at all</title>')).toBeNull();
  });
  it('a title segment equal to the domain\'s own name is used, flagged name_is_domain', () => {
    expect(read('<title>Welcome to example.com</title><p>hi</p>')).toMatchObject({ name: 'example.com', source: 'title', nameIsDomain: true });
    expect(read('<title>Example | Home</title>')).toMatchObject({ name: 'Example', nameIsDomain: true });
    expect(read('<title>Other Name</title>')).toMatchObject({ nameIsDomain: false });
  });
  it('falls back to a company-suffix or copyright line (a text candidate; the picker decides whether it is enough)', () => {
    expect(read('<body><p>Contact Blue Ridge Plumbing Co for help</p></body>')).toMatchObject({ name: 'Blue Ridge Plumbing Co', source: 'text_line' });
    expect(read('<body><p>\u00a9 2014 Sunrise Dental Group. All rights reserved.</p></body>')).toMatchObject({ name: 'Sunrise Dental Group', source: 'text_line' });
    expect(read('<body><p>Copyright 2010-2014 Sunrise Dental Inc, all rights reserved</p></body>')).toMatchObject({ name: 'Sunrise Dental Inc' });
    expect(read('<body><p>(c) Blue Sky All Rights Reserved</p></body>')).toMatchObject({ name: 'Blue Sky' });
    expect(read('<body><p>just words with no capitals here</p></body>')).toBeNull();
  });
  const c = (name: string, source: 'og_site_name' | 'title' | 'text_line', ts: string) => ({ name, source, timestamp: ts });
  it('picks the most frequent name; a tie in rank goes to the more explicit source, then the later capture', () => {
    expect(pickBusinessName([c('Acme', 'title', '2010'), c('Beta', 'title', '2012'), c('acme', 'title', '2014')])).toMatchObject({ name: 'acme', confident: true });
    expect(pickBusinessName([c('Acme', 'title', '2010'), c('Acme', 'og_site_name', '2012'), c('Beta', 'title', '2014')])).toMatchObject({ name: 'Acme', confident: true });
    expect(nameTokens('Acme & Sons, Inc.')).toEqual(['acme', 'sons', 'inc']);
  });
  it('low confidence is no name: only a text line, or captures that disagree (no strict majority), or nothing', () => {
    expect(pickBusinessName([c('Acme Inc', 'text_line', '2010'), c('Acme Inc', 'text_line', '2012')])).toMatchObject({ name: null, confident: false, reason: 'text_line_only' });
    expect(pickBusinessName([c('Acme', 'title', '2010'), c('Beta', 'title', '2012')])).toMatchObject({ name: null, reason: 'conflict' });
    expect(pickBusinessName([c('Acme', 'title', '2010'), c('Beta', 'title', '2012'), c('Gamma', 'title', '2014')])).toMatchObject({ name: null, reason: 'conflict' });
    expect(pickBusinessName([])).toMatchObject({ name: null, reason: 'none' });
    expect(pickBusinessName([c('Acme', 'title', '2010')])).toMatchObject({ name: 'Acme', confident: true });
  });
});

describe('hostile input stays fast (linear scans, no backtracking)', () => {
  const ms = (fn: () => void) => { const t = performance.now(); fn(); return performance.now() - t; };
  it.each([
    ['a long copyright run', () => { const t = `\u00a9 ${'A'.repeat(5000)}!`; businessNameCandidate({ html: '', title: null, text: t, timestamp: '2015' }, 'example.com'); }],
    ['a long copyright run of tokens', () => { const t = `\u00a9 ${'Aa '.repeat(20000)}!`; businessNameCandidate({ html: '', title: null, text: t, timestamp: '2015' }, 'example.com'); }],
    ['40,000 unclosed script tags', () => visibleText('<script '.repeat(40000))],
    ['40,000 unclosed meta tags', () => { const h = '<meta '.repeat(40000); visibleText(h); businessNameCandidate({ html: h, title: null, text: '', timestamp: '2015' }, 'example.com'); hiddenSignals(h); metaRefreshTarget(h); }],
    ['40,000 unclosed comments', () => visibleText('<!-- '.repeat(40000))],
    ['40,000 unclosed title tags', () => visibleText('<title '.repeat(40000))],
    ['40,000 open tags without >', () => visibleText('<a '.repeat(40000))],
    ['a long suffix run', () => businessNameCandidate({ html: '', title: null, text: 'Aa '.repeat(30000) + 'Inc', timestamp: '2015' }, 'example.com')],
    ['40,000 img tags', () => hiddenSignals('<img alt="x" '.repeat(40000))],
  ])('%s finishes in under 200 ms', (_name, fn) => {
    expect(ms(fn)).toBeLessThan(200);
  });
});

describe('failClassOf', () => {
  it('maps the signature classes; an unmapped custom class is spam, never null on a match', () => {
    expect(failClassOf(['malware:x', 'pharma:y'])).toBe('malware_phishing');
    expect(failClassOf(['trademark:x'])).toBe('trademark_abuse');
    expect(failClassOf(['custom:x'])).toBe('spam');
    expect(failClassOf([])).toBeNull();
  });
});
