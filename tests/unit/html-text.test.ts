import { describe, expect, it } from 'vitest';
import { decodeEntities, metaRefreshTarget, ogSiteName, titleOf, visibleText } from '../../src/screening/html-text.js';

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
    expect(visibleText('')).toMatchObject({ title: null, text: '' });
    expect(visibleText('plain text, no markup').text).toBe('plain text, no markup');
  });

  it('reads og:site_name in either attribute order', () => {
    expect(ogSiteName('<meta property="og:site_name" content="Acme &amp; Co">')).toBe('Acme & Co');
    expect(ogSiteName("<meta content='Beta LLC' name='og:site_name'>")).toBe('Beta LLC');
    expect(ogSiteName('<meta property="og:title" content="x">')).toBeNull();
    expect(ogSiteName('<meta property="og:site_name" content="">')).toBeNull();
  });

  it('case folding never shifts offsets: a dotted capital I before a script or comment does not leak its text', () => {
    const I10 = '\u0130'.repeat(10);
    expect(visibleText(`<p>${I10}</p><script>var x="casino poker";</script>`).text).toBe(I10);
    expect(visibleText(`<p>${I10}</p><!-- hidden casino poker --><p>ok</p>`).text).toBe(`${I10} ok`);
    expect(visibleText('<TITLE>\u0130\u0130 x</TITLE><P>y</P>').title).toBe('\u0130\u0130 x');
  });

  it('a real tag scanner: quoted attribute values are skipped, blocks close case-insensitively', () => {
    expect(visibleText('<a title="<script>">viagra casino pills</a>').text).toBe('viagra casino pills');
    expect(visibleText('<a title="a>b">x</a>').text).toBe('x');
    expect(visibleText("<a title='<style>'>kept</a>").text).toBe('kept');
    expect(visibleText('<p>a <script2>b</script2> c</p>').text).toBe('a b c');
    expect(visibleText('<p>1</p><SCRIPT>hide()</ScRiPt><p>2</p>').text).toBe('1 2');
    expect(visibleText('<p>1</p><script>a="</scripts>";</script><p>2</p>').text).toBe('1 2');
  });

  it('<!--> is an empty comment', () => {
    expect(visibleText('visible<!-->more').text).toBe('visible more');
    expect(visibleText('visible<!--->more').text).toBe('visible more');
    expect(visibleText('a<!-- x --> b').text).toBe('a b');
  });

  it('an unclosed script or style block is reported (the text after it is unknown, not empty); a closed one is not', () => {
    expect(visibleText('<p>before</p><script src="a.js"').truncatedMarkup).toBe(false);
    expect(visibleText('<p>before</p><script>var x = 1;').truncatedMarkup).toBe(true);
    expect(visibleText('<p>before</p><style>p{').truncatedMarkup).toBe(true);
    expect(visibleText('<p>before</p><script>1</script><p>after</p>')).toMatchObject({ truncatedMarkup: false, text: 'before after' });
    expect(visibleText('<p>x</p><noscript>never closed').truncatedMarkup).toBe(false);
  });

  it('metaRefreshTarget reads N;url=target by position and is fast on adversarial content', () => {
    expect(metaRefreshTarget('<meta http-equiv="refresh" content="0; url=http://a.example/x">')).toBe('http://a.example/x');
    expect(metaRefreshTarget('<meta http-equiv="Refresh" content="3;URL=\'/next\'">')).toBe('/next');
    expect(metaRefreshTarget('<meta http-equiv="refresh" content="30;url=/slow">')).toBeNull();
    expect(metaRefreshTarget('<meta http-equiv="refresh" content="0">')).toBeNull();
    const t = performance.now();
    metaRefreshTarget(`<meta http-equiv="refresh" content="0;${' '.repeat(100000)}'">`);
    metaRefreshTarget(`<meta http-equiv="refresh" content="0;url=${' '.repeat(100000)}'x">`);
    metaRefreshTarget(`<meta http-equiv="refresh" content="0;${" '".repeat(50000)}">`);
    expect(performance.now() - t).toBeLessThan(200);
  });
});
