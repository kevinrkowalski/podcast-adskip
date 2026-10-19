/// <reference types="jest" />
import { normalizeFeedUrl, parseOpml } from './opml';

test('outline attributes may contain ">"', () => {
  const xml = `<opml><body>
    <outline text="News > Tech" type="rss" xmlUrl="https://a.example/feed"/>
    <outline type="rss" text='A > B' xmlUrl="https://b.example/feed"></outline>
  </body></opml>`;
  const parsed = parseOpml(xml);
  expect(parsed.feeds.map((f) => f.xmlUrl)).toEqual(['https://a.example/feed', 'https://b.example/feed']);
  expect(parsed.feeds[0].title).toBe('News > Tech');
  expect(parsed.missingFeedUrl).toBe(0);
});

test('an invalid numeric entity does not fail the import', () => {
  const xml = `<opml><body><outline text="Bad &#99999999;" type="rss" xmlUrl="https://a.example/feed"/></body></opml>`;
  expect(() => parseOpml(xml)).not.toThrow();
  expect(parseOpml(xml).feeds).toHaveLength(1);
});

test('feeds on different ports are different feeds', () => {
  expect(normalizeFeedUrl('http://h.example:8080/feed')).not.toBe(normalizeFeedUrl('http://h.example/feed'));
  expect(normalizeFeedUrl('HTTPS://H.example/feed/')).toBe(normalizeFeedUrl('https://h.example/feed'));
});
