import type { Episode, SkipMap } from '@/src/types';

/**
 * Detect if the current playback audio likely differs from the analyzed audio.
 * Podcast RSS feeds often use dynamic ad insertion where the same URL serves
 * different files with ads inserted/removed based on request time, headers, etc.
 */

export interface AudioMismatchWarning {
  type: 'url_query_params' | 'url_different' | 'duration_mismatch' | 'stale_analysis';
  severity: 'high' | 'medium' | 'low';
  message: string;
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split('?')[0].split('#')[0];
  }
}

function hasTimestampQueryParams(url: string): boolean {
  try {
    const parsed = new URL(url);
    const params = Array.from(parsed.searchParams.keys()).join('|').toLowerCase();
    return /timestamp|token|expires|ttl|_ts|nonce/.test(params);
  } catch {
    return url.includes('timestamp') || url.includes('token') || url.includes('expires');
  }
}

/**
 * Check if the skip map might be stale or inaccurate for the current audio.
 * Returns warnings if mismatch is likely.
 */
export function detectAudioMismatch(
  episode: Episode,
  skipMap: SkipMap | null,
): AudioMismatchWarning[] {
  if (!skipMap || skipMap.status !== 'ready' || !skipMap.segments.length) {
    return [];
  }

  const warnings: AudioMismatchWarning[] = [];
  const currentUrl = episode.enclosureUrl;
  const analyzedUrl = skipMap.audio_url;

  if (!currentUrl) {
    return warnings;
  }

  // Warning 1: URL has changed completely (base path differs)
  if (analyzedUrl && normalizeUrl(currentUrl) !== normalizeUrl(analyzedUrl)) {
    warnings.push({
      type: 'url_different',
      severity: 'high',
      message: 'Audio URL has changed since analysis. Skip map may be inaccurate.',
    });
  }

  // Warning 2: URL has time-based query params (dynamic ad insertion)
  if (hasTimestampQueryParams(currentUrl)) {
    warnings.push({
      type: 'url_query_params',
      severity: 'medium',
      message:
        'Audio URL contains time-based parameters. Podcast may use dynamic ad insertion.',
    });
  }

  // Warning 3: Duration mismatch (significant difference)
  if (
    episode.durationMs &&
    skipMap.analyzed_audio_duration_ms &&
    Math.abs(episode.durationMs - skipMap.analyzed_audio_duration_ms) > 5000
  ) {
    warnings.push({
      type: 'duration_mismatch',
      severity: 'high',
      message: `Duration mismatch: RSS shows ${Math.round(episode.durationMs / 1000)}s, analyzed ${Math.round(skipMap.analyzed_audio_duration_ms / 1000)}s. Audio may differ.`,
    });
  }

  // Warning 4: Analysis is old (>24 hours for dynamic ad insertion)
  if (skipMap.analyzed_at && hasTimestampQueryParams(currentUrl)) {
    const analyzedMs = new Date(skipMap.analyzed_at).getTime();
    const ageHours = (Date.now() - analyzedMs) / (1000 * 60 * 60);
    if (ageHours > 24) {
      warnings.push({
        type: 'stale_analysis',
        severity: 'low',
        message: `Analysis is ${Math.round(ageHours)}h old. Ads may have changed.`,
      });
    }
  }

  return warnings;
}

/**
 * Get a user-facing summary of mismatch warnings.
 */
export function formatMismatchSummary(warnings: AudioMismatchWarning[]): string | null {
  if (!warnings.length) return null;

  const high = warnings.filter((w) => w.severity === 'high');
  if (high.length > 0) {
    return high[0].message;
  }

  const medium = warnings.filter((w) => w.severity === 'medium');
  if (medium.length > 0) {
    return medium[0].message;
  }

  return warnings[0].message;
}
