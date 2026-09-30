/**
 * Client-side audio download and upload for analysis.
 * 
 * This ensures the analyzed audio matches what the player will play,
 * avoiding dynamic ad insertion mismatches.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

const AUDIO_CACHE_DIR = `${FileSystem.cacheDirectory}podcast-audio/`;

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
function getCachePath(episodeGuid: string, audioUrl: string): string {
  const urlSuffix = audioUrl.split('?')[0].split('/').pop() || 'audio.mp3';
  const extension = urlSuffix.includes('.') ? urlSuffix.split('.').pop() : 'mp3';
  // Use guid as filename to avoid collisions
  const sanitized = episodeGuid.replace(/[^a-zA-Z0-9-_.]/g, '_');
  return `${AUDIO_CACHE_DIR}${sanitized}.${extension}`;
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
    console.log('[audio-download] Using cached audio:', localPath);
    return localPath;
  }

  console.log('[audio-download] Downloading audio for analysis:', audioUrl);

  const downloadResumable = FileSystem.createDownloadResumable(
    audioUrl,
    localPath,
    {},
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
          reject(new Error(`Upload failed: ${xhr.status}`));
        }
      });

      xhr.addEventListener('error', () => {
        reject(new Error('Upload failed'));
      });

      xhr.open('POST', `${apiBaseUrl}/v1/analyze-episode-upload`);
      
      // Set headers
      Object.entries(headers).forEach(([key, value]) => {
        xhr.setRequestHeader(key, value);
      });

      xhr.send(formData as any);
    });
  }

  // Fallback to fetch (web or no progress tracking)
  const response = await fetch(`${apiBaseUrl}/v1/analyze-episode-upload`, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status}`);
  }

  return response.json();
}

/**
 * Check if an episode has a cached audio file.
 * Returns the local file path if cached, null otherwise.
 */
export async function getCachedAudioPath(
  episodeGuid: string,
  audioUrl: string,
): Promise<string | null> {
  try {
    const localPath = getCachePath(episodeGuid, audioUrl);
    const info = await FileSystem.getInfoAsync(localPath);
    if (info.exists) {
      return localPath;
    }
    return null;
  } catch (err) {
    console.warn('[audio-cache] Failed to check cached audio:', err);
    return null;
  }
}

/**
 * Clean up cached audio files.
 */
export async function clearAudioCache(): Promise<void> {
  const info = await FileSystem.getInfoAsync(AUDIO_CACHE_DIR);
  if (info.exists) {
    await FileSystem.deleteAsync(AUDIO_CACHE_DIR, { idempotent: true });
  }
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
