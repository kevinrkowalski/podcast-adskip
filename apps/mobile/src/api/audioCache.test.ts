/// <reference types="jest" />
const mockDeleted: string[] = [];
const mockMetadata = [
  { fileName: 'played.mp3', episodeGuid: 'played', audioUrl: 'https://cdn/played.mp3', cachedAtMs: 1 },
  { fileName: 'loaded.mp3', episodeGuid: 'loaded', audioUrl: 'https://cdn/loaded.mp3', cachedAtMs: 1 },
  { fileName: 'queued.mp3', episodeGuid: 'queued', audioUrl: 'https://cdn/queued.mp3', cachedAtMs: 1 },
];
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  deleteAsync: async (path: string) => {
    mockDeleted.push(path);
  },
}));
jest.mock('@/src/db/storage', () => ({
  getAllAudioCacheMetadata: async () => mockMetadata,
  removeAudioCacheMetadata: async () => {},
  getCachedSkipMaps: async () => [],
  removeCachedSkipMap: async () => {},
}));
jest.mock('@/src/api/backend', () => ({}));
import { deletePlayedEpisodeAudio, parseRetryAfterMs } from './audioUpload';

describe('parseRetryAfterMs', () => {
  test('reads Retry-After in seconds', () => {
    expect(parseRetryAfterMs('120')).toBe(120_000);
  });

  test('reads Retry-After as an HTTP date', () => {
    const now = Date.parse('2026-11-01T12:00:00Z');
    expect(parseRetryAfterMs('Sun, 01 Nov 2026 12:05:00 GMT', now)).toBe(5 * 60_000);
  });

  test('falls back to a default when the header is missing or garbage', () => {
    expect(parseRetryAfterMs(null)).toBe(10 * 60_000);
    expect(parseRetryAfterMs('soon')).toBe(10 * 60_000);
  });
});

describe('deletePlayedEpisodeAudio', () => {
  test('deletes played downloads only, keeping the loaded episode', async () => {
    const played = new Set(['played', 'loaded']);
    const removed = await deletePlayedEpisodeAudio((g) => played.has(g), ['loaded', null]);
    expect(removed).toBe(1);
    expect(mockDeleted).toEqual(['file:///cache/podcast-audio/played.mp3']);
  });
});
