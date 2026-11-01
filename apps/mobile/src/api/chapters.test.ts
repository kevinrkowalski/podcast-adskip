/// <reference types="jest" />
jest.mock('@/src/db/storage', () => ({}));
jest.mock('@/src/player/androidAutoCatalog', () => ({}));
jest.mock('@/src/queue/queueStore', () => ({}));
const mockFetch = jest.fn();
jest.mock('./http', () => ({
  fetchWithTimeout: (url: string, _init: unknown, _ms: number, read: (res: unknown) => unknown) => mockFetch(url, read),
}));
import { clearCachedRssXml, findEpisodeChapters, parseJsonChapters, parseNptMs } from './rss';
import { currentChapterIndex } from '@/src/player/chapters';

const feed = (items: string) => `<rss><channel><title>Show</title>${items}</channel></rss>`;
const jsonFile = {
  version: '1.2.0',
  chapters: [
    { startTime: 754.5, title: 'Listener mail' },
    { startTime: 0, title: 'Intro', img: 'https://x/i.jpg' },
    { startTime: 300, title: 'Hidden art change', toc: false },
    { startTime: 120, title: 'Main topic', url: 'https://x/link' },
  ],
};

function serve(routes: Record<string, unknown>) {
  mockFetch.mockImplementation(async (url: string, read: (res: unknown) => unknown) => {
    const body = routes[url];
    if (body === undefined) throw new Error(`unexpected fetch ${url}`);
    return read({
      ok: true,
      status: 200,
      text: async () => body,
      json: async () => body,
    });
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  clearCachedRssXml();
});

test('Podcasting 2.0: fetches the JSON chapters file linked from the item', async () => {
  serve({
    'https://feed': feed(
      '<item><guid>g1</guid><title>Ep</title><podcast:chapters url="https://x/ch.json" type="application/json+chapters"/></item>',
    ),
    'https://x/ch.json': jsonFile,
  });
  const chapters = await findEpisodeChapters('https://feed', 'g1');
  expect(chapters.map((c) => [c.startMs, c.title])).toEqual([
    [0, 'Intro'],
    [120_000, 'Main topic'],
    [754_500, 'Listener mail'],
  ]);
  expect(chapters[1].url).toBe('https://x/link');
  expect(chapters[0].imageUrl).toBe('https://x/i.jpg');
});

test('Podlove Simple Chapters listed in the item', async () => {
  serve({
    'https://feed': feed(
      '<item><guid>g2</guid><title>Ep</title><psc:chapters version="1.2">' +
        '<psc:chapter start="00:00:00.000" title="Start"/>' +
        '<psc:chapter start="12:34.5" title="Interview &amp; Q&amp;A" href="https://x/q"/>' +
        '<psc:chapter start="01:02:03" title="Wrap-up"/>' +
        '</psc:chapters></item>',
    ),
  });
  const chapters = await findEpisodeChapters('https://feed', 'g2');
  expect(chapters.map((c) => [c.startMs, c.title])).toEqual([
    [0, 'Start'],
    [754_500, 'Interview & Q&A'],
    [3_723_000, 'Wrap-up'],
  ]);
});

test('an episode without chapters gets none (and no extra fetch)', async () => {
  serve({ 'https://feed': feed('<item><guid>g3</guid><title>Ep</title></item>') });
  expect(await findEpisodeChapters('https://feed', 'g3')).toEqual([]);
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

test('the JSON file is fetched once and remembered', async () => {
  serve({
    'https://feed': feed('<item><guid>g4</guid><podcast:chapters url="https://x/once.json"/></item>'),
    'https://x/once.json': jsonFile,
  });
  await findEpisodeChapters('https://feed', 'g4');
  await findEpisodeChapters('https://feed', 'g4');
  expect(mockFetch.mock.calls.filter(([url]) => url === 'https://x/once.json')).toHaveLength(1);
});

test('malformed JSON chapter entries are skipped', () => {
  expect(parseJsonChapters({ chapters: [{ title: 'no start' }, { startTime: 5 }, { startTime: -1, title: 'x' }] })).toEqual([]);
  expect(parseJsonChapters(null)).toEqual([]);
  expect(parseJsonChapters({ chapters: 'nope' })).toEqual([]);
});

test('normal play time parsing', () => {
  expect(parseNptMs('90')).toBe(90_000);
  expect(parseNptMs('1:30')).toBe(90_000);
  expect(parseNptMs('01:00:00.250')).toBe(3_600_250);
  expect(parseNptMs('x:10')).toBeUndefined();
  expect(parseNptMs('')).toBeUndefined();
});

test('the current chapter is the last one started', () => {
  const chapters = [
    { startMs: 0, title: 'a' },
    { startMs: 60_000, title: 'b' },
    { startMs: 120_000, title: 'c' },
  ];
  expect(currentChapterIndex(chapters, 0)).toBe(0);
  expect(currentChapterIndex(chapters, 59_999)).toBe(0);
  expect(currentChapterIndex(chapters, 60_000)).toBe(1);
  expect(currentChapterIndex(chapters, 999_999)).toBe(2);
  expect(currentChapterIndex([{ startMs: 5_000, title: 'late start' }], 1_000)).toBe(-1);
  expect(currentChapterIndex([], 1_000)).toBe(-1);
});
