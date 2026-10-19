/**
 * Play-while-downloading (Android playback service, see StreamCache.kt).
 *
 * When an episode that uses ad skipping has no downloaded copy, playback starts right away
 * from a single download that the player reads as it is saved, so the saved file is
 * byte-for-byte what you hear (dynamically inserted ads differ per fetch, so a separate
 * download could carry other ads). Skip times only apply once that file is complete and
 * its fingerprint (MD5) has a matching analysis.
 */

export type StreamCacheState = 'downloading' | 'complete' | 'failed' | 'canceled';

/** Native report for the current item's play-while-downloading session. */
export type StreamCacheStatus = {
  state: StreamCacheState;
  guid: string | null;
  bytes: number;
  /** 0 when the size isn't known yet. */
  total: number;
  md5?: string | null;
  error?: string | null;
  /** Complete, and every byte played came from the saved file. */
  verified?: boolean;
};

/** Whether to play right away while saving the stream, instead of downloading first. */
export function shouldPlayWhileDownloading(opts: {
  /** decidePlaybackSource() said the episode needs a download for ad skipping. */
  needsDownload: boolean;
  hasEnclosureUrl: boolean;
  /** The native playback service (Android) is available; it does the saving. */
  nativeAvailable: boolean;
  /**
   * A regular download (queue prefetch, Prepare) is already running for this episode.
   * Its copy is what will be analyzed, so wait for it rather than fetch a second copy.
   */
  regularDownloadInFlight: boolean;
}): boolean {
  return (
    opts.needsDownload && opts.hasEnclosureUrl && opts.nativeAvailable && !opts.regularDownloadInFlight
  );
}

export function streamCacheProgressPct(status: Pick<StreamCacheStatus, 'bytes' | 'total' | 'state'>): number | null {
  if (status.state === 'complete') return 100;
  if (!(status.total > 0)) return null;
  return Math.max(0, Math.min(99, Math.floor((status.bytes / status.total) * 100)));
}

/** Subtle player status while the episode plays and downloads. */
export function streamCacheNotice(progressPct: number | null): string {
  return `Ad skip ready after download${progressPct != null ? ` (${progressPct}%)` : ''}`;
}

/** What the app should do with a native report for `guid`. */
export function streamCacheOutcome(
  status: StreamCacheStatus | null | undefined,
  guid: string | null | undefined,
): 'none' | 'progress' | 'ready' | 'failed' {
  if (!status || !guid || status.guid !== guid) return 'none';
  if (status.state === 'downloading') return 'progress';
  if (status.state === 'complete') {
    // Skips need the exact bytes heard; an unverified or unfingerprinted copy can't be used.
    return status.verified && !!status.md5 ? 'ready' : 'failed';
  }
  return 'failed';
}

/**
 * Local file the loaded episode now plays from, after a native report. Only a complete,
 * verified save of the episode being played counts; anything else keeps the current value.
 */
export function localPathAfterStreamCache(
  current: string | null,
  target: { guid: string; path: string } | null,
  status: StreamCacheStatus | null | undefined,
  loadedGuid: string | null | undefined,
): string | null {
  if (current || !target || target.guid !== loadedGuid) return current;
  return streamCacheOutcome(status, target.guid) === 'ready' ? target.path : current;
}

export function streamCacheFailureMessage(error: string | null | undefined): string {
  const raw = (error ?? '').trim();
  const offline = /network|offline|internet|unable to resolve host|failed to connect|timeout|timed out|unreachable/i.test(
    raw,
  );
  const reason = offline ? "the connection dropped" : raw || 'the download stopped';
  return `Ad skipping is off for this play: ${reason}.`;
}
