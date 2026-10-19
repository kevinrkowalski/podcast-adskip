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
import { resolveAudioUrl } from '@/src/api/backend';

export function isRedirectError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /follow-up requests|too many redirects|redirect/i.test(msg);
}

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
/** Filesystems cap names at 255 bytes; keep well under it. */
const MAX_CACHE_BASENAME = 150;

function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function getCacheFileName(episodeGuid: string, audioUrl: string): string {
  const urlSuffix = audioUrl.split('?')[0].split('#')[0].split('/').pop() || 'audio.mp3';
  const rawExtension = urlSuffix.includes('.') ? urlSuffix.split('.').pop() ?? '' : '';
  const extension = /^[a-zA-Z0-9]{1,5}$/.test(rawExtension) ? rawExtension : 'mp3';
  const sanitized = episodeGuid.replace(/[^a-zA-Z0-9-_.]/g, '_');
  // Short names are unchanged (existing downloads keep matching); very long GUIDs
  // (often URLs) are truncated with a hash so the download doesn't fail.
  const base =
    sanitized.length > MAX_CACHE_BASENAME
      ? `${sanitized.slice(0, MAX_CACHE_BASENAME - 9)}-${fnv1aHex(episodeGuid)}`
      : sanitized;
  return `${base}.${extension}`;
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

  // Download to a temp file and move it into place only once it's complete and the
  // server returned success; otherwise an error page or a truncated file would be
  // cached (and reused) as the episode's audio.
  const partPath = `${localPath}.part`;
  const discardPart = () => FileSystem.deleteAsync(partPath, { idempotent: true }).catch(() => {});
  const startDownload = (url: string) =>
    FileSystem.createDownloadResumable(
      url,
      partPath,
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
    ).downloadAsync();

  let result: Awaited<ReturnType<typeof startDownload>>;
  try {
    try {
      result = await startDownload(audioUrl);
    } catch (error) {
      if (!isRedirectError(error)) throw error;
      // Tracking chains (podtrac -> pscrb.fm IPv4/IPv6 bounce -> simplecast) can loop on
      // some phone networks. Let the server follow the chain, then fetch the final URL.
      console.warn('[audio-download] Redirect failure, resolving via API:', error);
      await discardPart();
      const finalUrl = await resolveAudioUrl(audioUrl);
      console.log('[audio-download] Resolved audio URL:', finalUrl);
      result = await startDownload(finalUrl);
    }
    if (!result) {
      throw new Error('Download failed');
    }
    // downloadAsync resolves (and writes the body) for HTTP error responses too.
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`Audio download failed: HTTP ${result.status}`);
    }
    await FileSystem.moveAsync({ from: partPath, to: localPath });
  } catch (error) {
    await discardPart();
    throw error;
  }

  let audioMd5: string | undefined;
  try {
    audioMd5 = await calculateAudioMd5(localPath);
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
  console.log('[audio-download] Downloaded to:', localPath);
  return localPath;
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
    podcastTitle?: string;
    podcastDescription?: string;
    episodeDescription?: string;
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
  if (metadata.podcastTitle) formData.append('podcast_title', metadata.podcastTitle.slice(0, 300));
  if (metadata.podcastDescription) {
    formData.append('podcast_description', metadata.podcastDescription.slice(0, 5000));
  }
  if (metadata.episodeDescription) {
    formData.append('episode_description', metadata.episodeDescription.slice(0, 5000));
  }
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
      // RN's HTTP client has no timeouts: abort if the upload makes no progress (and the
      // server doesn't answer) for this long, instead of hanging Prepare forever.
      const IDLE_TIMEOUT_MS = 120_000;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let timedOut = false;
      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          timedOut = true;
          xhr.abort();
        }, IDLE_TIMEOUT_MS);
      };
      const stopIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = null;
      };
      xhr.addEventListener('loadend', stopIdle);
      
      xhr.upload.addEventListener('progress', (e) => {
        resetIdle();
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
        reject(
          new Error(
            timedOut
              ? `Upload stalled (no progress for ${IDLE_TIMEOUT_MS / 1000}s). Check the connection and try again.`
              : 'Upload was cancelled before the server responded.',
          ),
        );
      });

      xhr.open('POST', uploadUrl);
      
      // Set headers
      Object.entries(headers).forEach(([key, value]) => {
        xhr.setRequestHeader(key, value);
      });

      resetIdle();
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
 * Local file paths for the episodes that have a downloaded copy, keyed by guid.
 * Lists the cache directory once instead of stat-ing every episode.
 */
export async function getCachedAudioPaths(
  episodes: { guid: string; enclosureUrl?: string }[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const info = await FileSystem.getInfoAsync(AUDIO_CACHE_DIR);
    if (!info.exists) return out;
    const files = new Set(await FileSystem.readDirectoryAsync(AUDIO_CACHE_DIR));
    for (const ep of episodes) {
      if (!ep.guid || !ep.enclosureUrl) continue;
      const fileName = getCacheFileName(ep.guid, ep.enclosureUrl);
      if (files.has(fileName)) out[ep.guid] = `${AUDIO_CACHE_DIR}${fileName}`;
    }
  } catch (error) {
    console.warn('[audio-cache] Failed to list cached audio:', error);
  }
  return out;
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
