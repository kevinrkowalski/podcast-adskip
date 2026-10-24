import type { SkipMap } from '@/src/types';

/**
 * The server can add ad skips to a ready map a little later (its "quiet-gap second pass").
 * While it runs the map says `gap_pass_pending: true`; these helpers refetch that same map
 * (same audio fingerprint) until the pass finishes, then hand back the updated map.
 */

export const GAP_PASS_FIRST_CHECK_MS = 15_000;
export const GAP_PASS_POLL_INTERVAL_MS = 20_000;
export const GAP_PASS_MAX_WAIT_MS = 30 * 60_000;

export function needsGapPassRefresh(map: SkipMap | null | undefined): map is SkipMap {
  return !!map && map.status === 'ready' && map.gap_pass_pending === true && !!map.audio_md5;
}

/** The refetched map if it is the same analysis (episode + audio bytes) and ready; else null. */
export function acceptRefreshedMap(current: SkipMap, fresh: SkipMap | null | undefined): SkipMap | null {
  if (!fresh || fresh.status !== 'ready') return null;
  if (fresh.episode_guid !== current.episode_guid) return null;
  const a = current.audio_md5?.toLowerCase();
  const b = fresh.audio_md5?.toLowerCase();
  if (!a || a !== b) return null;
  return fresh;
}

function segmentsKey(map: SkipMap): string {
  return JSON.stringify((map.segments ?? []).map((s) => [s.start_ms, s.end_ms, s.type, s.confidence]));
}

export function segmentsChanged(a: SkipMap, b: SkipMap): boolean {
  return segmentsKey(a) !== segmentsKey(b);
}

export type GapPassPollOptions = {
  fetchMap: (episodeGuid: string, audioMd5: string) => Promise<SkipMap>;
  /** False once the user moved to another episode (or the map was replaced). */
  isCurrent: () => boolean;
  /** Called with the finished map (and with interim maps whose segments changed). */
  onUpdate: (map: SkipMap) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  firstCheckMs?: number;
  intervalMs?: number;
  maxWaitMs?: number;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll until the gap pass is done, the map changes underneath us, or we give up.
 * Returns the final map applied, or null. Never throws (network errors just retry later).
 */
export async function pollGapPass(start: SkipMap, opts: GapPassPollOptions): Promise<SkipMap | null> {
  if (!needsGapPassRefresh(start)) return null;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.maxWaitMs ?? GAP_PASS_MAX_WAIT_MS);
  const md5 = start.audio_md5 as string;
  let latest = start;
  let wait = opts.firstCheckMs ?? GAP_PASS_FIRST_CHECK_MS;
  while (now() + wait <= deadline) {
    await sleep(wait);
    wait = opts.intervalMs ?? GAP_PASS_POLL_INTERVAL_MS;
    if (!opts.isCurrent()) return null;
    let fresh: SkipMap | null = null;
    try {
      fresh = acceptRefreshedMap(latest, await opts.fetchMap(start.episode_guid, md5));
    } catch {
      continue;
    }
    if (!opts.isCurrent()) return null;
    if (!fresh) return null; // re-analyzed, other audio, or gone: stop, keep what we have
    if (!fresh.gap_pass_pending || segmentsChanged(latest, fresh)) {
      await opts.onUpdate(fresh);
      latest = fresh;
    }
    if (!fresh.gap_pass_pending) return fresh;
  }
  return null;
}
