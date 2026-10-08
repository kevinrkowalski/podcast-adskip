/**
 * Client-side audio download and upload for analysis.
 * 
 * This ensures the analyzed audio matches what the player will play,
 * avoiding dynamic ad insertion mismatches.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import {
  getAllAudioCacheMetadata,
  getAudioCacheMetadata,
  getCachedSkipMaps,
  removeAllAudioCacheMetadata,
  removeAudioCacheMetadata,
  removeCachedSkipMap,
  saveAudioCacheMetadata,
  type AudioCacheMetadata,
} from '@/src/db/storage';

const AUDIO_CACHE_DIR = `${FileSystem.cacheDirectory}podcast-audio/`;
const AUDIO_CACHE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Ensure audio cache directory exists.
 */
async function ensureCacheDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(AUDIO_CACHE_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(AUDIO_CACHE_DIR, { intermediates: true });
  }
}

/**
 * Get a stable cache path for an episode.
 */
function getCacheFileName(episodeGuid: string, audioUrl: string): string {
  const urlSuffix = audioUrl.split('?')[0].split('/').pop() || 'audio.mp3';
  const extension = urlSuffix.includes('.') ? urlSuffix.split('.').pop() : 'mp3';
  const sanitized = episodeGuid.replace(/[^a-zA-Z0-9-_.]/g, '_');
  return `${sanitized}.${extension}`;
}

function getCachePath(episodeGuid: string, audioUrl: string): string {
  return `${AUDIO_CACHE_DIR}${getCacheFileName(episodeGuid, audioUrl)}`;
}

function fileModificationTimeMs(info: { modificationTime?: number }): number | null {
  return typeof info.modificationTime === 'number' && info.modificationTime > 0
    ? info.modificationTime * 1000
    : null;
}

async function calculateAudioMd5(filePath: string): Promise<string> {
  const info = await FileSystem.getInfoAsync(filePath, { md5: true });
  if (!info.exists || typeof info.md5 !== 'string' || !info.md5) {
    throw new Error('Could not fingerprint cached audio file');
  }
  return info.md5.toLowerCase();
}

async function rememberAudioCache(
  fileName: string,
  episodeGuid: string,
  audioUrl: string,
  cachedAtMs: number,
  audioMd5?: string,
): Promise<void> {
  try {
    await saveAudioCacheMetadata({ fileName, episodeGuid, audioUrl, cachedAtMs, audioMd5 });
  } catch (error) {
    console.warn('[audio-cache] Failed to save cache metadata:', error);
  }
}

function mapsForAudioFiles(
  maps: Awaited<ReturnType<typeof getCachedSkipMaps>>,
  fileNames: Set<string>,
): AudioCacheMetadata[] {
  return maps.flatMap((map) => {
    if (!map.episode_guid || !map.audio_url) return [];
    const fileName = getCacheFileName(map.episode_guid, map.audio_url);
    return fileNames.has(fileName)
      ? [{ fileName, episodeGuid: map.episode_guid, audioUrl: map.audio_url, cachedAtMs: 0 }]
      : [];
  });
}

export interface DownloadProgress {
  totalBytesWritten: number;
  totalBytesExpectedToWrite: number;
}

export interface UploadProgress {
  totalBytesSent: number;
  totalBytesExpectedToSend: number;
}

/**
 * Download audio file for analysis.
 * Returns the local file path.
 */
export async function downloadAudioForAnalysis(
  episodeGuid: string,
  audioUrl: string,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<string> {
  await ensureCacheDir();
  const localPath = getCachePath(episodeGuid, audioUrl);

  // Check if already cached
  const info = await FileSystem.getInfoAsync(localPath);
  if (info.exists) {
    const fileName = getCacheFileName(episodeGuid, audioUrl);
    const existingMetadata = await getAudioCacheMetadata(fileName);
    if (!existingMetadata) {
      await rememberAudioCache(
        fileName,
        episodeGuid,
        audioUrl,
        fileModificationTimeMs(info) ?? Date.now(),
      );
    }
    try {
      await getCachedAudioMd5(episodeGuid, audioUrl);
    } catch (error) {
      console.warn('[audio-cache] Could not fingerprint cached audio:', error);
    }
    console.log('[audio-download] Using cached audio:', localPath);
    return localPath;
  }

  console.log('[audio-download] Downloading audio for analysis:', audioUrl);

  const downloadResumable = FileSystem.createDownloadResumable(
    audioUrl,
    localPath,
    {
      // Match playback UA so Simplecast/Podtrac DAI variants align with the player.
      headers: {
        'User-Agent': 'PodcastAdSkip/1.0 (Linux; Android) expo-audio',
      },
    },
    (progress) => {
      if (onProgress) {
        onProgress({
          totalBytesWritten: progress.totalBytesWritten,
          totalBytesExpectedToWrite: progress.totalBytesExpectedToWrite,
        });
      }
    },
  );

  const result = await downloadResumable.downloadAsync();
  if (!result) {
    throw new Error('Download failed');
  }

  let audioMd5: string | undefined;
  try {
    audioMd5 = await calculateAudioMd5(result.uri);
  } catch (error) {
    console.warn('[audio-cache] Could not fingerprint downloaded audio:', error);
  }
  await rememberAudioCache(
    getCacheFileName(episodeGuid, audioUrl),
    episodeGuid,
    audioUrl,
    Date.now(),
    audioMd5,
  );
  console.log('[audio-download] Downloaded to:', result.uri);
  return result.uri;
}

/**
 * Upload audio file to API for analysis.
 */
export async function uploadAudioForAnalysis(
  apiBaseUrl: string,
  appKey: string,
  localFilePath: string,
  metadata: {
    episodeGuid: string;
    audioUrl?: string;
    title?: string;
    durationMs?: number;
    feedUrl?: string;
    force?: boolean;
  },
  onProgress?: (progress: UploadProgress) => void,
): Promise<any> {
  console.log('[audio-upload] Uploading audio for analysis:', localFilePath);

  const formData = new FormData();
  
  // Add audio file
  const fileInfo = await FileSystem.getInfoAsync(localFilePath);
  if (!fileInfo.exists) {
    throw new Error('Audio file not found');
  }

  // For React Native, we need to use the file:// URI
  const filename = localFilePath.split('/').pop() || 'audio.mp3';
  
  // Web and mobile handle FormData differently
  if (Platform.OS === 'web') {
    // Web: fetch the blob
    const response = await fetch(localFilePath);
    const blob = await response.blob();
    formData.append('audio_file', blob, filename);
  } else {
    // React Native: use the file URI directly
    formData.append('audio_file', {
      uri: localFilePath,
      type: 'audio/mpeg',
      name: filename,
    } as any);
  }

  // Add metadata
  formData.append('episode_guid', metadata.episodeGuid);
  if (metadata.audioUrl) formData.append('audio_url', metadata.audioUrl);
  if (metadata.title) formData.append('title', metadata.title);
  if (metadata.durationMs) formData.append('duration_ms', metadata.durationMs.toString());
  if (metadata.feedUrl) formData.append('feed_url', metadata.feedUrl);
  if (metadata.force) formData.append('force', 'true');

  const headers: HeadersInit = {};
  if (appKey) {
    headers['X-App-Key'] = appKey;
  }
  const uploadUrl = `${apiBaseUrl.replace(/\/$/, '')}/v1/analyze-episode-upload`;

  // Use XMLHttpRequest for progress tracking on native
  if (Platform.OS !== 'web' && onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress({
            totalBytesSent: e.loaded,
            totalBytesExpectedToSend: e.total,
          });
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            resolve({ status: 'queued' });
          }
        } else {
          const detail = xhr.responseText?.trim().slice(0, 300);
          reject(new Error(`Upload failed: ${xhr.status}${detail ? ` — ${detail}` : ''}`));
        }
      });

      xhr.addEventListener('error', () => {
        reject(
          new Error(
            `Upload network error (status ${xhr.status || 0}; no HTTP response). Check that the device can reach the configured API.`,
          ),
        );
      });

      xhr.addEventListener('abort', () => {
        reject(new Error('Upload was cancelled before the server responded.'));
      });

      xhr.open('POST', uploadUrl);
      
      // Set headers
      Object.entries(headers).forEach(([key, value]) => {
        xhr.setRequestHeader(key, value);
      });

      xhr.send(formData as any);
    });
  }

  // Fallback to fetch (web or no progress tracking)
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!response.ok) {
    const detail = (await response.text()).trim().slice(0, 300);
    throw new Error(`Upload failed: ${response.status}${detail ? ` — ${detail}` : ''}`);
  }

  return response.json();
}

/**
 * Check if an episode has a cached audio file.
 * Returns the local file path if cached, null otherwise.
 */
export async function getCachedAudioMd5(
  episodeGuid: string,
  audioUrl: string,
): Promise<string | null> {
  try {
    const fileName = getCacheFileName(episodeGuid, audioUrl);
    const filePath = getCachePath(episodeGuid, audioUrl);
    const info = await FileSystem.getInfoAsync(filePath);
    if (!info.exists || info.isDirectory) return null;

    const metadata = await getAudioCacheMetadata(fileName);
    if (metadata?.audioMd5) return metadata.audioMd5.toLowerCase();

    const audioMd5 = await calculateAudioMd5(filePath);
    await rememberAudioCache(
      fileName,
      episodeGuid,
      audioUrl,
      metadata?.cachedAtMs ?? fileModificationTimeMs(info) ?? Date.now(),
      audioMd5,
    );
    return audioMd5;
  } catch (error) {
    console.warn('[audio-cache] Failed to get audio fingerprint:', error);
    return null;
  }
}

export async function getCachedAudioPath(
  episodeGuid: string,
  audioUrl: string,
): Promise<string | null> {
  try {
    const localPath = getCachePath(episodeGuid, audioUrl);
    const info = await FileSystem.getInfoAsync(localPath);
    if (info.exists) {
      const fileName = getCacheFileName(episodeGuid, audioUrl);
      const existingMetadata = await getAudioCacheMetadata(fileName);
      if (!existingMetadata) {
        await rememberAudioCache(
          fileName,
          episodeGuid,
          audioUrl,
          fileModificationTimeMs(info) ?? Date.now(),
        );
      }
      return localPath;
    }
    return null;
  } catch (err) {
    console.warn('[audio-cache] Failed to check cached audio:', err);
    return null;
  }
}

/**
 * Delete one cached episode download and its associated skip map.
 */
export async function deleteCachedEpisodeAudio(
  episodeGuid: string,
  audioUrl: string,
): Promise<void> {
  const fileName = getCacheFileName(episodeGuid, audioUrl);
  await FileSystem.deleteAsync(getCachePath(episodeGuid, audioUrl), { idempotent: true });
  await removeAudioCacheMetadata(fileName);

  const maps = await getCachedSkipMaps();
  const relatedMaps = mapsForAudioFiles(maps, new Set([fileName]));
  for (const map of relatedMaps) {
    await removeCachedSkipMap(map.episodeGuid, map.audioUrl);
  }
  await removeCachedSkipMap(episodeGuid, audioUrl);
}

/**
 * Delete cached audio downloads older than 14 days, along with their skip maps.
 * Runs at app startup; Android may also reclaim files in cacheDirectory sooner.
 */
export async function pruneExpiredAudioCache(now = Date.now()): Promise<number> {
  try {
    const directoryInfo = await FileSystem.getInfoAsync(AUDIO_CACHE_DIR);
    const files = directoryInfo.exists ? await FileSystem.readDirectoryAsync(AUDIO_CACHE_DIR) : [];
    const fileNames = new Set(files);
    const metadata = await getAllAudioCacheMetadata();
    const metadataByFileName = new Map(metadata.map((entry) => [entry.fileName, entry]));
    const maps = await getCachedSkipMaps();

    let removed = 0;
    for (const entry of metadata) {
      if (fileNames.has(entry.fileName)) continue;
      await removeCachedSkipMap(entry.episodeGuid, entry.audioUrl);
      await removeAudioCacheMetadata(entry.fileName);
    }

    for (const fileName of files) {
      const filePath = `${AUDIO_CACHE_DIR}${fileName}`;
      const info = await FileSystem.getInfoAsync(filePath);
      if (!info.exists || info.isDirectory) continue;

      let entry = metadataByFileName.get(fileName);
      const relatedMaps = mapsForAudioFiles(maps, new Set([fileName]));
      if (!entry && relatedMaps.length) {
        const cachedAtMs = fileModificationTimeMs(info) ?? now;
        entry = { ...relatedMaps[0], cachedAtMs };
        await rememberAudioCache(fileName, entry.episodeGuid, entry.audioUrl, cachedAtMs);
      }
      const cachedAtMs = entry?.cachedAtMs ?? fileModificationTimeMs(info) ?? now;
      if (now - cachedAtMs < AUDIO_CACHE_RETENTION_MS) continue;

      await FileSystem.deleteAsync(filePath, { idempotent: true });
      for (const map of relatedMaps) {
        await removeCachedSkipMap(map.episodeGuid, map.audioUrl);
      }
      if (entry) await removeCachedSkipMap(entry.episodeGuid, entry.audioUrl);
      await removeAudioCacheMetadata(fileName);
      removed += 1;
    }
    return removed;
  } catch (error) {
    console.warn('[audio-cache] Expired audio cleanup failed:', error);
    return 0;
  }
}

/**
 * Clear all downloaded audio and the skip maps associated with those downloads.
 */
export async function clearAudioCache(): Promise<void> {
  const metadata = await getAllAudioCacheMetadata();
  const info = await FileSystem.getInfoAsync(AUDIO_CACHE_DIR);
  const files = info.exists ? await FileSystem.readDirectoryAsync(AUDIO_CACHE_DIR) : [];
  const relatedMaps = mapsForAudioFiles(await getCachedSkipMaps(), new Set(files));

  for (const entry of metadata) {
    await removeCachedSkipMap(entry.episodeGuid, entry.audioUrl);
  }
  for (const map of relatedMaps) {
    await removeCachedSkipMap(map.episodeGuid, map.audioUrl);
  }
  if (info.exists) {
    await FileSystem.deleteAsync(AUDIO_CACHE_DIR, { idempotent: true });
  }
  await removeAllAudioCacheMetadata();
}

/**
 * Get the size of the audio cache.
 */
export async function getAudioCacheSize(): Promise<number> {
  const info = await FileSystem.getInfoAsync(AUDIO_CACHE_DIR);
  if (!info.exists) return 0;

  const files = await FileSystem.readDirectoryAsync(AUDIO_CACHE_DIR);
  let totalSize = 0;

  for (const file of files) {
    const filePath = `${AUDIO_CACHE_DIR}${file}`;
    const fileInfo = await FileSystem.getInfoAsync(filePath);
    if (fileInfo.exists && 'size' in fileInfo) {
      totalSize += fileInfo.size || 0;
    }
  }

  return totalSize;
}
