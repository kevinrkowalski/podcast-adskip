/// <reference types="jest" />
const mockDeleted: string[] = [];
let mockDirFiles: string[] = [];
const mockRemovedMaps: string[] = [];
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
  getInfoAsync: async () => ({ exists: true, isDirectory: true }),
  readDirectoryAsync: async () => mockDirFiles,
}));
jest.mock('@/src/db/storage', () => ({
  getAllAudioCacheMetadata: async () => mockMetadata,
  removeAudioCacheMetadata: async () => {},
  getCachedSkipMaps: async () => [],
  removeCachedSkipMap: async (guid: string) => {
    mockRemovedMaps.push(guid);
  },
}));
jest.mock('@/src/api/backend', () => ({}));
import {
  beginStreamCacheDownload,
  clearAudioCache,
  deletePlayedEpisodeAudio,
  failStreamCacheDownload,
  parseRetryAfterMs,
} from './audioUpload';

beforeEach(() => {
  mockDeleted.length = 0;
  mockRemovedMaps.length = 0;
});

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

describe('clearAudioCache', () => {
  test('keeps the loaded episode and anything still downloading', async () => {
    mockDirFiles = ['played.mp3', 'loaded.mp3', 'queued.mp3', 'streaming.mp3.stream.part', 'old.mp3.part'];
    void beginStreamCacheDownload('streaming', 'https://cdn/streaming.mp3');
    try {
      const removed = await clearAudioCache([{ episodeGuid: 'loaded', audioUrl: 'https://cdn/loaded.mp3' }]);
      expect(removed).toBe(3);
      expect(mockDeleted.sort()).toEqual([
        'file:///cache/podcast-audio/old.mp3.part',
        'file:///cache/podcast-audio/played.mp3',
        'file:///cache/podcast-audio/queued.mp3',
      ]);
      expect(mockRemovedMaps).not.toContain('loaded');
      expect(mockRemovedMaps).toEqual(expect.arrayContaining(['played', 'queued']));
    } finally {
      failStreamCacheDownload('streaming', 'https://cdn/streaming.mp3', 'test over');
    }
  });
});
