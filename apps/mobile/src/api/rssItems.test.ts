/// <reference types="jest" />
jest.mock('@/src/db/storage', () => ({}));
jest.mock('@/src/player/androidAutoCatalog', () => ({}));
jest.mock('@/src/queue/queueStore', () => ({}));
import { parseRssXml } from './rss';

const item = (n: number, date: string, extra = '') =>
  `<item><guid>g${n}</guid><title>Ep ${n}</title><pubDate>${date}</pubDate>` +
  `<enclosure url="https://x/${n}.mp3" type="audio/mpeg"/>${extra}</item>`;

const wrap = (items: string) => `<rss><channel><title>Show</title>${items}</channel></rss>`;

test('splits items the same way as the old single-regex scan', () => {
  const xml = wrap(
    item(1, 'Tue, 02 Jan 2024 00:00:00 GMT') +
      '<itemized>not an item</itemized>' +
      `<ITEM><guid>g2</guid><title>Upper</title></ITEM>` +
      `<item><guid>g3</guid><title>Has <item-ish> text</title></item>`,
  );
  expect(parseRssXml(xml, 'f').episodes.map((e) => e.guid)).toEqual(['g1', 'g2', 'g3']);
});

test('an unterminated trailing item is ignored', () => {
  const xml = wrap(item(1, 'Tue, 02 Jan 2024 00:00:00 GMT') + '<item><guid>g2</guid><title>cut');
  expect(parseRssXml(xml, 'f').episodes.map((e) => e.guid)).toEqual(['g1']);
});

test('newestFirst takes the newest items from oldest-first feeds, and file order otherwise', () => {
  const oldestFirst = wrap(
    [1, 2, 3, 4].map((n) => item(n, `Mon, 0${n} Jan 2024 00:00:00 GMT`)).join(''),
  );
  expect(
    parseRssXml(oldestFirst, 'f', undefined, { maxItems: 2, newestFirst: true }).episodes.map((e) => e.guid),
  ).toEqual(['g4', 'g3']);
  const newestFirst = wrap(
    [4, 3, 2, 1].map((n) => item(n, `Mon, 0${n} Jan 2024 00:00:00 GMT`)).join(''),
  );
  const parsed = parseRssXml(newestFirst, 'f', undefined, { maxItems: 2, newestFirst: true });
  expect(parsed.episodes.map((e) => e.guid)).toEqual(['g4', 'g3']);
  expect(parsed.truncated).toBe(true);
});

test('a large archive (1,500 items with long show notes) parses the newest 20 quickly', () => {
  const notes = `<content:encoded><![CDATA[<p>${'Show notes with links and sponsors. '.repeat(250)}</p>]]></content:encoded>`;
  const items: string[] = [];
  for (let n = 0; n < 1500; n++) {
    const d = new Date(Date.UTC(2020, 0, 1) + n * 86_400_000).toUTCString();
    items.push(item(n, d, notes));
  }
  const xml = wrap(items.join(''));
  expect(xml.length).toBeGreaterThan(10_000_000);
  const t0 = Date.now();
  const parsed = parseRssXml(xml, 'f', undefined, { maxItems: 20, newestFirst: true });
  const ms = Date.now() - t0;
  expect(parsed.episodes[0].guid).toBe('g1499');
  expect(parsed.episodes).toHaveLength(20);
  expect(ms).toBeLessThan(2_000);
});
