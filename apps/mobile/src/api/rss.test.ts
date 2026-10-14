/// <reference types="jest" />
jest.mock('@/src/db/storage', () => ({}));
jest.mock('@/src/player/androidAutoCatalog', () => ({}));
jest.mock('@/src/queue/queueStore', () => ({}));
import { parseRssXml, pickEpisodeNotes } from './rss';

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
