/// <reference types="jest" />
const mockUrls: string[] = [];
let mockEntries: unknown[] = [];
jest.mock('./http', () => ({
  fetchWithTimeout: async (url: string, _init: unknown, _ms: number, read: (res: unknown) => unknown) => {
    mockUrls.push(url);
    return read({ ok: true, status: 200, json: async () => ({ feed: { entry: mockEntries } }) });
  },
}));
import { fetchTopPodcasts } from './itunes';

const entry = (id: number, name: string) => ({
  id: { attributes: { 'im:id': String(id) } },
  'im:name': { label: name },
  'im:artist': { label: 'Artist' },
});

beforeEach(() => {
  mockUrls.length = 0;
});

test('asks for the whole chart (200) and keeps the first of any repeated show', async () => {
  mockEntries = [entry(1, 'One'), entry(2, 'Two'), entry(1, 'One again'), entry(3, 'Three')];
  const shows = await fetchTopPodcasts(1303, 200);
  expect(mockUrls[0]).toBe('https://itunes.apple.com/us/rss/toppodcasts/limit=200/genre=1303/json');
  expect(shows.map((s) => [s.collectionId, s.collectionName])).toEqual([
    [1, 'One'],
    [2, 'Two'],
    [3, 'Three'],
  ]);
});

test('never asks Apple for more than its 200 maximum', async () => {
  mockEntries = [];
  await fetchTopPodcasts(null, 500);
  expect(mockUrls[0]).toBe('https://itunes.apple.com/us/rss/toppodcasts/limit=200/json');
});
