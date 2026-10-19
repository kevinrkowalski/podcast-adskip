/// <reference types="jest" />
// Play-while-downloading: the player saves the episode as it plays. Prepare and the skip-map
// flow must wait for that copy (the bytes being heard) instead of downloading another one,
// which could carry different dynamically inserted ads.

const mockFs = {
  files: new Set<string>(),
  downloads: [] as string[],
  saved: [] as { fileName: string; audioMd5?: string }[],
};

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  getInfoAsync: async (path: string) =>
    mockFs.files.has(path)
      ? { exists: true, isDirectory: false, size: 10 }
      : { exists: path.endsWith('/'), isDirectory: path.endsWith('/') },
  makeDirectoryAsync: async () => {},
  deleteAsync: async (path: string) => {
    mockFs.files.delete(path);
  },
  moveAsync: async () => {},
  createDownloadResumable: (url: string) => ({
    downloadAsync: () => {
      mockFs.downloads.push(url);
      return new Promise(() => {});
    },
  }),
}));
jest.mock('@/src/db/storage', () => ({
  getAllAudioCacheMetadata: async () => [],
  getAudioCacheMetadata: async () => null,
  getCachedSkipMaps: async () => [],
  removeAllAudioCacheMetadata: async () => {},
  removeAudioCacheMetadata: async () => {},
  removeCachedSkipMap: async () => {},
  saveAudioCacheMetadata: async (entry: { fileName: string; audioMd5?: string }) => {
    mockFs.saved.push(entry);
  },
}));
jest.mock('@/src/api/backend', () => ({ resolveAudioUrl: async (u: string) => u }));

import {
  abandonStreamCacheDownloads,
  beginStreamCacheDownload,
  completeStreamCacheDownload,
  downloadAudioForAnalysis,
  failStreamCacheDownload,
  isStreamCacheInFlight,
  prepareStreamCachePath,
} from './audioUpload';

const URL1 = 'https://cdn.example.com/ep1.mp3';

beforeEach(() => {
  mockFs.files.clear();
  mockFs.downloads = [];
  mockFs.saved = [];
  abandonStreamCacheDownloads(null);
});

test('Prepare waits for the copy the player is saving, then it is fingerprinted', async () => {
  const path = await prepareStreamCachePath('ep-1', URL1);
  expect(path).toBe('file:///cache/podcast-audio/ep-1.mp3');
  const done = beginStreamCacheDownload('ep-1', URL1);
  expect(beginStreamCacheDownload('ep-1', URL1)).toBe(done);
  expect(isStreamCacheInFlight('ep-1', URL1)).toBe(true);

  const prepare = downloadAudioForAnalysis('ep-1', URL1);
  await Promise.resolve();
  expect(mockFs.downloads).toHaveLength(0);

  // Native service renamed the finished file into place.
  mockFs.files.add(path);
  await expect(completeStreamCacheDownload('ep-1', URL1, 'ABCDEF')).resolves.toBe(true);
  await expect(done).resolves.toBe(path);
  await expect(prepare).resolves.toBe(path);
  expect(mockFs.saved).toEqual([expect.objectContaining({ fileName: 'ep-1.mp3', audioMd5: 'abcdef' })]);
  expect(isStreamCacheInFlight('ep-1', URL1)).toBe(false);
  // Repeated "complete" heartbeats are ignored.
  await expect(completeStreamCacheDownload('ep-1', URL1, 'abcdef')).resolves.toBe(false);
});

test('a failed save rejects waiters and is reported once', async () => {
  const done = beginStreamCacheDownload('ep-1', URL1);
  expect(failStreamCacheDownload('ep-1', URL1, 'HTTP 403')).toBe(true);
  await expect(done).rejects.toThrow('HTTP 403');
  expect(failStreamCacheDownload('ep-1', URL1, 'HTTP 403')).toBe(false);
});

test('complete without the file on disk rejects (nothing to analyze)', async () => {
  const done = beginStreamCacheDownload('ep-1', URL1);
  await expect(completeStreamCacheDownload('ep-1', URL1, 'abc')).resolves.toBe(true);
  await expect(done).rejects.toThrow('missing');
});

test('starting another episode abandons other saves only', async () => {
  const one = beginStreamCacheDownload('ep-1', URL1);
  const two = beginStreamCacheDownload('ep-2', 'https://cdn.example.com/ep2.mp3');
  abandonStreamCacheDownloads('ep-2');
  await expect(one).rejects.toThrow('another episode');
  expect(isStreamCacheInFlight('ep-2', 'https://cdn.example.com/ep2.mp3')).toBe(true);
  void two;
});
