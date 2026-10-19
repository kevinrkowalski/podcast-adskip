import type { SkipMap } from '@/src/types';

/**
 * Where an episode should play from.
 *
 * Ad segment times only line up with the exact bytes that were analyzed. Podcast CDNs
 * insert ads dynamically, so a fresh stream can carry different ads at different times
 * than the downloaded copy. Whenever ad skipping can apply to an episode, skips therefore
 * only ever use the downloaded file's times, never a separately fetched stream.
 *
 * - 'local': a downloaded copy exists; play it.
 * - 'download': ad skipping applies but there's no copy yet. On Android it plays right
 *   away while the player saves exactly the bytes it plays (streamCache.ts); skips start
 *   once that copy is complete and fingerprinted. Elsewhere: download, then play it.
 * - 'stream': ad skipping can't apply (Ad-skip off, or detection off for the show and
 *   nothing prepared); streaming is fine because nothing will be skipped.
 */
export type PlaybackSource = 'local' | 'download' | 'stream';

export function decidePlaybackSource(opts: {
  hasLocalFile: boolean;
  hasEnclosureUrl: boolean;
  /** Global Ad-skip setting. */
  globalAutoSkip: boolean;
  /** Per-show "ad detection" setting (auto-analyze on play). */
  podcastDetectionEnabled: boolean;
  /** The server has (or is making) a skip map for this episode, e.g. a manual Prepare. */
  hasPreparedAnalysis: boolean;
}): PlaybackSource {
  if (opts.hasLocalFile) return 'local';
  if (!opts.hasEnclosureUrl) return 'stream';
  if (!opts.globalAutoSkip) return 'stream';
  if (opts.podcastDetectionEnabled || opts.hasPreparedAnalysis) return 'download';
  return 'stream';
}

/**
 * Whether a skip-map lookup made without a fingerprint shows the episode was analyzed
 * (or is being analyzed) from some download. Older servers returned the ready map
 * itself; newer ones return "missing" plus analysis_for_other_audio.
 */
export function serverHasAnalysis(map: SkipMap | null | undefined): boolean {
  if (!map) return false;
  if (map.status === 'ready' || map.status === 'pending' || map.status === 'queued') return true;
  return map.analysis_for_other_audio === true;
}

/**
 * The server's map was made from different bytes than our local file: its times can't
 * be trusted for this copy, so the local file must be analyzed instead.
 */
export function needsReanalysisForLocalFile(map: SkipMap | null | undefined): boolean {
  return !!map && map.status === 'missing' && map.analysis_for_other_audio === true;
}

/** Message shown when the download needed for ad skipping fails. */
export function downloadFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const offline = /network|offline|internet|unable to resolve host|failed to connect|timeout|timed out|unreachable/i.test(
    raw,
  );
  const reason = offline ? 'You appear to be offline.' : raw.trim() || 'The download failed.';
  return `Couldn't download this episode for ad skipping. ${reason}`;
}
