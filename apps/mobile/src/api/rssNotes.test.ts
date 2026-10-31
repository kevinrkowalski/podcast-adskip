/// <reference types="jest" />
jest.mock('@/src/db/storage', () => ({}));
jest.mock('@/src/player/androidAutoCatalog', () => ({}));
jest.mock('@/src/queue/queueStore', () => ({}));
const mockFetchWithTimeout = jest.fn();
jest.mock('./http', () => ({ fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args) }));
import { clearCachedRssXml, fetchRssXml, findEpisodeNotes } from './rss';

const item = (guid: string, notes: string) =>
  `<item><guid>${guid}</guid><title>${guid}</title><description>${notes}</description></item>`;

function serve(xml: string) {
  mockFetchWithTimeout.mockImplementation(async () => xml);
}

beforeEach(() => {
  mockFetchWithTimeout.mockReset();
  clearCachedRssXml();
});

test('finds notes for an episode past the first 150 items', async () => {
  const items = Array.from({ length: 400 }, (_, i) => item(`g${i}`, `Notes ${i}`)).join('');
  serve(`<rss><channel><title>Show</title>${items}</channel></rss>`);
  expect(await findEpisodeNotes('https://feed', 'g321')).toBe('Notes 321');
});

test('refetches when the cached feed predates the episode', async () => {
  serve(`<rss><channel>${item('old', 'Old notes')}</channel></rss>`);
  await fetchRssXml('https://feed');
  serve(`<rss><channel>${item('new', 'New notes')}${item('old', 'Old notes')}</channel></rss>`);
  expect(await findEpisodeNotes('https://feed', 'new')).toBe('New notes');
  expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
});

test('uses the cached feed without refetching when it has the episode', async () => {
  serve(`<rss><channel>${item('a', 'A notes')}</channel></rss>`);
  await fetchRssXml('https://feed');
  expect(await findEpisodeNotes('https://feed', 'a')).toBe('A notes');
  expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
});

test('falls back to the audio URL when the guid changed', async () => {
  serve(
    '<rss><channel><item><guid>new-guid</guid><title>Renamed</title>' +
      '<enclosure url="https://cdn/ep1.mp3?token=new" type="audio/mpeg"/>' +
      '<description>Ep 1 notes</description></item></channel></rss>',
  );
  expect(
    await findEpisodeNotes('https://feed', 'https://cdn/ep1.mp3?token=old', {
      enclosureUrl: 'https://cdn/ep1.mp3?token=old',
      title: 'Episode 1',
    }),
  ).toBe('Ep 1 notes');
});

test('falls back to the title when neither guid nor audio URL match', async () => {
  serve(`<rss><channel>${item('other', 'Other notes')}${item('Episode 2', 'Ep 2 notes')}</channel></rss>`);
  expect(await findEpisodeNotes('https://feed', 'gone', { title: 'Episode 2' })).toBe('Ep 2 notes');
});

test('prefers an exact guid match over fallbacks', async () => {
  serve(`<rss><channel>${item('Same title', 'Wrong')}${item('g1', 'Right')}</channel></rss>`);
  expect(await findEpisodeNotes('https://feed', 'g1', { title: 'Same title' })).toBe('Right');
});
