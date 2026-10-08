// CAP-12 site classification (Task 2): pure, no network. The pages are synthetic (tests/fixtures/screening/sites/synthetic-*.html).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SELECTION_VALUES } from '../../src/modules/selection/settings.js';
import { classifySite, phraseUse, robotsAllows, type PageFetch } from '../../src/modules/selection/site.js';

const S = DEFAULT_SELECTION_VALUES.same_name;
const lists = { parked: ['parked:this domain is parked', 'parked:coming soon'], forsale: ['forsale:this domain is for sale', 'forsale:afternic.com'] };
const read = (n: string) => readFileSync(new URL(`../fixtures/screening/sites/${n}`, import.meta.url), 'utf8');
const ok = (html: string, finalUrl = 'https://promptinjectionaudit.net/'): PageFetch => ({ ok: true, finalUrl, status: 200, html, truncated: false });
const P = ['prompt', 'injection', 'audit'];
const cls = (page: PageFetch) => classifySite(page, 'promptinjectionaudit.net', 'promptinjectionaudit.com', P, lists, S);

describe('classifySite (CAP-12)', () => {
  it('business_name: og:site_name / title is our exact name', () => {
    expect(cls(ok(read('synthetic-business-title.html')))).toMatchObject({ site_state: 'in_use', business_use: 'business_name', business_name: 'Prompt Injection Audit', final_url: 'https://promptinjectionaudit.net/' });
  });
  it('service_description and product_name come from the running text of an in-use page', () => {
    expect(cls(ok(read('synthetic-service.html')))).toMatchObject({ site_state: 'in_use', business_use: 'service_description', business_name: null });
    expect(cls(ok(read('synthetic-product.html')))).toMatchObject({ site_state: 'in_use', business_use: 'product_name' });
    expect(cls(ok(read('synthetic-unrelated.html')))).toMatchObject({ site_state: 'in_use', business_use: 'none' });
  });
  it('parked/for-sale page -> parked_or_for_sale; thin page -> registered_no_site; off-domain final URL -> redirect_off_domain', () => {
    expect(cls(ok(read('synthetic-parked.html')))).toMatchObject({ site_state: 'parked_or_for_sale', business_use: null });
    expect(cls(ok(read('synthetic-thin.html')))).toMatchObject({ site_state: 'registered_no_site', business_use: null });
    expect(cls(ok(read('synthetic-business-title.html'), 'https://www.other-site.example/x'))).toMatchObject({ site_state: 'redirect_off_domain', final_url: 'https://www.other-site.example/x' });
    expect(cls(ok(read('synthetic-business-title.html'), 'https://www.promptinjectionaudit.net/home'))).toMatchObject({ site_state: 'in_use' });
  });
  it('a quick meta refresh to another site is redirect_off_domain, not a thin page', () => {
    const html = '<html><head><meta http-equiv="refresh" content="0; url=https://elsewhere.example/landing"></head><body></body></html>';
    expect(cls(ok(html))).toMatchObject({ site_state: 'redirect_off_domain' });
  });
  it('fail closed: every ok:false kind "unknown" -> site_state unknown, business_use null', () => {
    for (const reasonCode of ['TIMEOUT', 'HTTP_5XX', 'TLS_ERROR', 'ROBOTS_DISALLOWED', 'TOO_MANY_REDIRECTS', 'TRUNCATED', 'SOURCE_ERROR'] as const) {
      expect(classifySite({ ok: false, kind: 'unknown', reasonCode, finalUrl: null }, 'x.net', 'x.com', P, lists, S)).toMatchObject({ site_state: 'unknown', business_use: null, reason_code: reasonCode });
    }
  });
  it('DNS NXDOMAIN / connection refused / 4xx -> registered_no_site (a determinate "no site", never "free")', () => {
    for (const reasonCode of ['DNS_NXDOMAIN', 'CONNECTION_REFUSED', 'HTTP_4XX'] as const) {
      expect(classifySite({ ok: false, kind: 'no_site', reasonCode, finalUrl: null }, 'x.net', 'x.com', P, lists, S)).toMatchObject({ site_state: 'registered_no_site', business_use: null, reason_code: reasonCode });
    }
  });
});

describe('classifySite order and name matching (fix round 1)', () => {
  it('legal suffixes are ignored and every title segment is compared with our name', () => {
    expect(cls(ok(read('synthetic-business-ltd.html')))).toMatchObject({ site_state: 'in_use', business_use: 'business_name', business_name: 'Prompt Injection Audit Ltd' });
    expect(cls(ok(read('synthetic-business-segment.html')))).toMatchObject({ site_state: 'in_use', business_use: 'business_name', business_name: 'Prompt Injection Audit' });
    for (const t of ['Prompt Injection Audit, LLC', 'Prompt Injection Audit GmbH', 'Prompt Injection Audit Pty Ltd', 'Welcome to Prompt Injection Audit Inc.']) {
      const html = `<html><head><title>${t}</title></head><body>${'We test your systems every quarter and write it down. '.repeat(10)}</body></html>`;
      expect(cls(ok(html)), t).toMatchObject({ business_use: 'business_name' });
    }
    const other = '<html><head><title>Prompt Injection Audit Services Group</title></head><body>' + 'We test your systems every quarter and write it down. '.repeat(10) + '</body></html>';
    expect(cls(ok(other)).business_use).not.toBe('business_name');
  });
  it('a thin page whose own name is our name is still an operator', () => {
    expect(cls(ok('<html><head><title>Prompt Injection Audit</title></head><body><p>Coming soon.</p></body></html>')).site_state).toBe('parked_or_for_sale'); // parked signature wins on a thin page
    expect(cls(ok('<html><head><title>Prompt Injection Audit</title></head><body><p>Hello.</p></body></html>'))).toMatchObject({ site_state: 'in_use', business_use: 'business_name' });
  });
  it('a thin page drawn by scripts is unknown CLIENT_RENDERED, not "no site"', () => {
    expect(cls(ok(read('synthetic-client-rendered.html')))).toMatchObject({ site_state: 'unknown', business_use: null, reason_code: 'CLIENT_RENDERED' });
    expect(cls(ok(read('synthetic-thin.html')))).toMatchObject({ site_state: 'registered_no_site' }); // no script: truly empty
  });
  it('parked / for-sale signatures count only on a page of at most parked_max_text_chars', () => {
    const page = ok(read('synthetic-long-marketplace.html'));
    const textLen = 1000;
    expect(textLen).toBeLessThan(S.parked_max_text_chars);
    expect(cls(page).site_state).toBe('parked_or_for_sale'); // within the cap
    expect(classifySite(page, 'promptinjectionaudit.net', 'promptinjectionaudit.com', P, lists, { ...S, parked_max_text_chars: 300 })).toMatchObject({ site_state: 'in_use', business_use: 'none' });
  });
});

describe('phraseUse', () => {
  it('service_description: the phrase in running lowercase text', () => {
    expect(phraseUse('We run a prompt injection audit of your LLM app every quarter.', P, S.product_markers)).toBe('service_description');
  });
  it('product_name only: Title Case or a TM/R marker on every occurrence (CR-001 CAP-15 test 7)', () => {
    expect(phraseUse('Try Prompt Injection Audit™ today. Prompt Injection Audit plans from $9.', P, S.product_markers)).toBe('product_name');
    expect(phraseUse('our prompt injection audit(tm) is fast', P, S.product_markers)).toBe('product_name');
  });
  it('one plain occurrence among product-style ones makes it a service description', () => {
    expect(phraseUse('Prompt Injection Audit™ is great. We do a prompt injection audit for you.', P, S.product_markers)).toBe('service_description');
  });
  it('none when the phrase is absent; whole words only ("audits" is not "audit")', () => {
    expect(phraseUse('prompt injection audits for teams', P, S.product_markers)).toBe('none');
    expect(phraseUse('nothing here', P, S.product_markers)).toBe('none');
    expect(phraseUse('anything', [], S.product_markers)).toBe('none');
  });
  it('the joined form counts (handle style)', () => {
    expect(phraseUse('follow promptinjectionaudit on social', P, S.product_markers)).toBe('service_description');
    expect(phraseUse('visit PromptInjectionAudit now', P, S.product_markers)).toBe('product_name');
  });
  it('is linear on hostile text', () => {
    const t0 = Date.now();
    phraseUse(`${'prompt '.repeat(60_000)}${' '.repeat(50_000)}`, P, S.product_markers);
    phraseUse('prompt injection '.repeat(12_000), P, S.product_markers);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('classifySite timing on hostile HTML', () => {
  it('a large page of unterminated tags and quotes is classified quickly', () => {
    const html = `<html><body>${'<a href="'.repeat(20_000)}${'<<<>>> prompt '.repeat(10_000)}</body></html>`;
    const t0 = Date.now();
    cls(ok(html));
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('robotsAllows', () => {
  const UA = 'domain-trading-api';
  it('Disallow: / for * blocks; for another agent does not; empty file allows', () => {
    expect(robotsAllows('User-agent: *\nDisallow: /', UA, '/')).toBe(false);
    expect(robotsAllows('User-agent: otherbot\nDisallow: /', UA, '/')).toBe(true);
    expect(robotsAllows('', UA, '/')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow:', UA, '/')).toBe(true);
  });
  it('the specific group wins over *; Allow with the longer match wins; Allow wins a tie', () => {
    expect(robotsAllows('User-agent: *\nDisallow: /\n\nUser-agent: domain-trading-api\nAllow: /', UA, '/')).toBe(true);
    expect(robotsAllows('User-agent: *\nAllow: /\nUser-agent: Domain-Trading-API\nDisallow: /', UA, '/')).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow: /\nAllow: /public', UA, '/public/page')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /private\nAllow: /private', UA, '/private')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /private', UA, '/')).toBe(true);
  });
  it('the group is matched by the exact product token, never a substring (RFC 9309)', () => {
    expect(robotsAllows('User-agent: ai\nDisallow: /', UA, '/')).toBe(true);
    expect(robotsAllows('User-agent: domain\nDisallow: /', UA, '/')).toBe(true);
    expect(robotsAllows('User-agent: domain-trading-api-extra\nDisallow: /', UA, '/')).toBe(true);
    expect(robotsAllows('User-agent: DOMAIN-TRADING-API\nDisallow: /', UA, '/')).toBe(false);
  });
  it('rules and path length are capped', () => {
    const many = `User-agent: *\n${'Disallow: /a\n'.repeat(3000)}Disallow: /zzz\n`;
    expect(robotsAllows(many, UA, '/zzz')).toBe(true); // rule 3,001 is never read
    expect(robotsAllows('User-agent: *\nDisallow: /*b$', UA, '/' + 'a'.repeat(600) + 'b')).toBe(true); // the path is cut to 512 characters before matching
  });
  it('several user-agent lines share a group; comments, wildcards and $ work', () => {
    expect(robotsAllows('User-agent: a\nUser-agent: domain-trading-api # us\nDisallow: /x', UA, '/x/y')).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow: /*.pdf$', UA, '/doc.pdf')).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow: /*.pdf$', UA, '/doc.pdf?x=1')).toBe(true);
  });
  it('is linear on hostile patterns', () => {
    const t0 = Date.now();
    robotsAllows(`User-agent: *\nDisallow: /${'*a'.repeat(5_000)}b`, UA, `/${'a'.repeat(5_000)}`);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
