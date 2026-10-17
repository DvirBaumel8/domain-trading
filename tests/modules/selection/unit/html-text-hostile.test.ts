// Hostile markup stays fast (linear scans, no backtracking) in the page-text helpers used by the business-site fetcher.
import { describe, expect, it } from 'vitest';
import { hiddenSignals, metaRefreshTarget, visibleText } from '../../../../src/modules/selection/html-text.js';

describe('hostile input stays fast (linear scans, no backtracking)', () => {
  const ms = (fn: () => void) => { const t = performance.now(); fn(); return performance.now() - t; };
  it.each([
    ['40,000 unclosed script tags', () => visibleText('<script '.repeat(40000))],
    ['40,000 unclosed meta tags', () => { const h = '<meta '.repeat(40000); visibleText(h); hiddenSignals(h); metaRefreshTarget(h); }],
    ['40,000 unclosed comments', () => visibleText('<!-- '.repeat(40000))],
    ['40,000 unclosed title tags', () => visibleText('<title '.repeat(40000))],
    ['40,000 open tags without >', () => visibleText('<a '.repeat(40000))],
    ['40,000 img tags', () => hiddenSignals('<img alt="x" '.repeat(40000))],
  ])('%s finishes in under 200 ms', (_name, fn) => {
    expect(ms(fn)).toBeLessThan(200);
  });
});
