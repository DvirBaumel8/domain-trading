import { describe, expect, it } from 'vitest';
import { decodeEntities, ogSiteName, titleOf, visibleText } from '../../src/screening/html-text.js';

describe('visibleText', () => {
  it('drops script, style, noscript, template and comments; keeps the words', () => {
    const html = '<html><head><style>.a{color:red}</style><script>var viagra=1;</script></head><body><!-- hidden cialis --><h1>Hello</h1>'
      + '<noscript>enable js</noscript><template><p>tpl</p></template><p>World</p><SCRIPT type="x">more()</SCRIPT></body></html>';
    expect(visibleText(html).text).toBe('Hello World');
  });

  it('reads the title (decoded, collapsed) and keeps it in the text', () => {
    const r = visibleText('<html><head><title>\n  Acme &amp; Sons  |  Home </title></head><body>x</body></html>');
    expect(r.title).toBe('Acme & Sons | Home');
    expect(r.text).toBe('Acme & Sons | Home x');
    expect(visibleText('<p>no title</p>').title).toBeNull();
    expect(visibleText('<title> </title><p>x</p>').title).toBeNull();
    expect(titleOf('<!-- <title>old</title> --><title>new</title>')).toBe('new');
  });

  it('decodes &amp; &lt; &gt; &quot; &#39; &nbsp; &#NNN; &#xHH; once, and leaves unknown references alone', () => {
    expect(decodeEntities('a &amp; b &lt;i&gt; &quot;q&quot; it&#39;s&nbsp;ok &#65;&#x42; &amp;lt; &bogus; &#0; &#xD800;')).toBe('a & b <i> "q" it\'s ok AB &lt; &bogus; &#0; &#xD800;');
    expect(visibleText('<p>Fish &amp; Chips&nbsp;&copy; 2020</p>').text).toBe('Fish & Chips © 2020');
  });

  it('turns tags into spaces so words never glue together, and collapses whitespace', () => {
    expect(visibleText('<p>one</p><p>two</p>\n\n<div>three<br>four</div>').text).toBe('one two three four');
  });

  it('tolerates malformed markup: unclosed tags and blocks, stray < and >, empty input', () => {
    expect(visibleText('<p>a < b and c > d</p>').text).toBe('a < b and c > d');
    expect(visibleText('<p>kept</p><script>never closed var x = 1;').text).toBe('kept');
    expect(visibleText('<p>kept</p><!-- never closed').text).toBe('kept');
    expect(visibleText('<div>kept</div><div class="x').text).toBe('kept');
    expect(visibleText('<p>x</p></').text).toBe('x');
    expect(visibleText('')).toEqual({ title: null, text: '' });
    expect(visibleText('plain text, no markup').text).toBe('plain text, no markup');
  });

  it('reads og:site_name in either attribute order', () => {
    expect(ogSiteName('<meta property="og:site_name" content="Acme &amp; Co">')).toBe('Acme & Co');
    expect(ogSiteName("<meta content='Beta LLC' name='og:site_name'>")).toBe('Beta LLC');
    expect(ogSiteName('<meta property="og:title" content="x">')).toBeNull();
    expect(ogSiteName('<meta property="og:site_name" content="">')).toBeNull();
  });
});
