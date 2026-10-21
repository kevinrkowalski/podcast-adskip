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
