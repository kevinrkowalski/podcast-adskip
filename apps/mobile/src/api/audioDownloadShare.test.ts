/// <reference types="jest" />
// Play (download-first), Prepare and the queue prefetch can all ask for the same
// episode at once. They must share one download: two writers on one .part file
// would corrupt the copy that gets analyzed and played.

const mockFs = {
  files: new Set<string>(),
  downloads: [] as { url: string; to: string; resolve: () => void; progress: (p: any) => void }[],
};

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  getInfoAsync: async (path: string, opts?: { md5?: boolean }) =>
    mockFs.files.has(path)
      ? { exists: true, isDirectory: false, size: 10, md5: opts?.md5 ? 'abc' : undefined }
      : { exists: path.endsWith('/'), isDirectory: path.endsWith('/') },
  makeDirectoryAsync: async () => {},
  deleteAsync: async (path: string) => {
    mockFs.files.delete(path);
  },
  moveAsync: async ({ from, to }: { from: string; to: string }) => {
    mockFs.files.delete(from);
    mockFs.files.add(to);
  },
  createDownloadResumable: (url: string, to: string, _opts: unknown, progress: (p: any) => void) => ({
    downloadAsync: () =>
      new Promise((resolve) => {
        mockFs.downloads.push({
          url,
          to,
          progress,
          resolve: () => {
            mockFs.files.add(to);
            resolve({ status: 200 });
          },
        });
      }),
  }),
}));
jest.mock('@/src/db/storage', () => ({
  getAllAudioCacheMetadata: async () => [],
  getAudioCacheMetadata: async () => null,
  getCachedSkipMaps: async () => [],
  removeAllAudioCacheMetadata: async () => {},
  removeAudioCacheMetadata: async () => {},
  removeCachedSkipMap: async () => {},
  saveAudioCacheMetadata: async () => {},
}));
jest.mock('@/src/api/backend', () => ({ resolveAudioUrl: async (u: string) => u }));

import { downloadAudioForAnalysis, isAudioDownloadInFlight } from './audioUpload';

test('concurrent requests for one episode share a single download', async () => {
  const seenA: number[] = [];
  const seenB: number[] = [];
  const a = downloadAudioForAnalysis('ep-1', 'https://cdn.example.com/ep1.mp3', (p) =>
    seenA.push(p.totalBytesWritten),
  );
  const b = downloadAudioForAnalysis('ep-1', 'https://cdn.example.com/ep1.mp3', (p) =>
    seenB.push(p.totalBytesWritten),
  );
  expect(isAudioDownloadInFlight('ep-1', 'https://cdn.example.com/ep1.mp3')).toBe(true);
  // Let the first call reach createDownloadResumable.
  for (let i = 0; i < 10 && mockFs.downloads.length === 0; i++) await Promise.resolve();
  expect(mockFs.downloads).toHaveLength(1);
  mockFs.downloads[0].progress({ totalBytesWritten: 5, totalBytesExpectedToWrite: 10 });
  expect(seenA).toEqual([5]);
  expect(seenB).toEqual([5]);
  mockFs.downloads[0].resolve();
  const [pathA, pathB] = await Promise.all([a, b]);
  expect(pathA).toBe('file:///cache/podcast-audio/ep-1.mp3');
  expect(pathB).toBe(pathA);
  expect(mockFs.downloads).toHaveLength(1);
  expect(isAudioDownloadInFlight('ep-1', 'https://cdn.example.com/ep1.mp3')).toBe(false);

  // Already downloaded: reused, no new download.
  await expect(downloadAudioForAnalysis('ep-1', 'https://cdn.example.com/ep1.mp3')).resolves.toBe(pathA);
  expect(mockFs.downloads).toHaveLength(1);
});
