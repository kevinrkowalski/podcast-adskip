/// <reference types="jest" />
jest.mock('@/src/db/storage', () => ({}));
jest.mock('@/src/player/androidAutoCatalog', () => ({}));
jest.mock('@/src/queue/queueStore', () => ({}));
import { attr, decodeXmlEntities, parseDurationMs, parseRssXml, pickEpisodeNotes, textBetween } from './rss';

const feed = (item: string) =>
  `<rss><channel><title>Show</title><item><guid>g1</guid><title>Ep</title><enclosure url="https://x/a.mp3" type="audio/mpeg"/>${item}</item></channel></rss>`;

test('prefers content:encoded with whitespace around CDATA (Megaphone: Syntax, Money Guy)', () => {
  const xml = feed(`<description>Short teaser…</description>
    <content:encoded>
        <![CDATA[<p>Short teaser and the full show notes with <a href="https://x">links</a>.</p><ul><li>One</li></ul>]]>
      </content:encoded>`);
  const d = parseRssXml(xml, 'f').episodes[0].description!;
  expect(d).toContain('<p>Short teaser and the full show notes');
  expect(d).not.toContain('CDATA');
});

test('falls back through description, itunes:summary, itunes:subtitle', () => {
  expect(pickEpisodeNotes('<description></description><itunes:summary>Sum</itunes:summary>')).toBe('Sum');
  expect(pickEpisodeNotes('<itunes:subtitle>Sub</itunes:subtitle>')).toBe('Sub');
  expect(pickEpisodeNotes('<description>Desc text</description><itunes:subtitle>Desc</itunes:subtitle>')).toBe('Desc text');
  expect(pickEpisodeNotes('<title>x</title>')).toBeUndefined();
});

test('decodes escaped HTML and CDATA descriptions', () => {
  expect(pickEpisodeNotes('<description>&lt;p&gt;Hi &amp;amp; bye&lt;/p&gt;</description>')).toBe('<p>Hi &amp; bye</p>');
  expect(pickEpisodeNotes('<description><![CDATA[<p>Daily</p>]]></description>')).toBe('<p>Daily</p>');
  expect(pickEpisodeNotes('<description>&amp;lt;b&amp;gt;x&amp;lt;/b&amp;gt;</description>')).toBe('<b>x</b>');
});

test('does not confuse itunes:summary with description', () => {
  expect(pickEpisodeNotes('<itunes:summary>Only summary here</itunes:summary>')).toBe('Only summary here');
});

test('decodes entities once and tolerates invalid code points', () => {
  expect(decodeXmlEntities('A &amp;lt; B')).toBe('A &lt; B');
  expect(decodeXmlEntities('Tom &amp;quot;T&amp;quot;')).toBe('Tom &quot;T&quot;');
  expect(decodeXmlEntities('bad &#99999999; ok &#x1F600;')).toBe('bad &#99999999; ok \u{1F600}');
  expect(() => parseRssXml(feed('<description>&#99999999;</description>'), 'f')).not.toThrow();
});

test('textBetween uses the first element even when a later one is CDATA', () => {
  const head = '<title>Show</title><image><title><![CDATA[Logo]]></title></image>';
  expect(textBetween(head, 'title')).toBe('Show');
  expect(textBetween('<title><![CDATA[A & B]]></title>', 'title')).toBe('A & B');
  expect(textBetween('<titles>x</titles><title>y</title>', 'title')).toBe('y');
});

test('attr keeps apostrophes inside double-quoted values', () => {
  expect(attr(`<enclosure url="https://x/Don't.mp3" type='audio/mpeg'/>`, 'url')).toBe("https://x/Don't.mp3");
  expect(attr(`<enclosure url="https://x/a.mp3" type='audio/mpeg'/>`, 'type')).toBe('audio/mpeg');
});

test('parses decimal-second durations', () => {
  expect(parseDurationMs('3600.5')).toBe(3_600_500);
  expect(parseDurationMs('1:02:03')).toBe(3_723_000);
  expect(parseDurationMs('02:03.5')).toBe(123_500);
  expect(parseDurationMs('abc')).toBeUndefined();
});

test('newestFirst takes the newest items from oldest-first feeds', () => {
  const item = (g: string, d: string) =>
    `<item><guid>${g}</guid><pubDate>${d}</pubDate><enclosure url="https://x/${g}.mp3"/></item>`;
  const oldestFirst = `<rss><channel><title>S</title>${item('e1', 'Mon, 01 Jan 2024 00:00:00 GMT')}${item('e2', 'Tue, 02 Jan 2024 00:00:00 GMT')}${item('e3', 'Wed, 03 Jan 2024 00:00:00 GMT')}</channel></rss>`;
  expect(parseRssXml(oldestFirst, 'f', undefined, { maxItems: 2 }).episodes.map((e) => e.guid)).toEqual(['e1', 'e2']);
  expect(
    parseRssXml(oldestFirst, 'f', undefined, { maxItems: 2, newestFirst: true }).episodes.map((e) => e.guid),
  ).toEqual(['e3', 'e2']);
});
