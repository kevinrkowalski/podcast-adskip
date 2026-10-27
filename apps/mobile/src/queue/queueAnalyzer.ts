/**
 * Background auto-analysis for Up Next queue.
 *
 * Episodes in the queue are analyzed one at a time if their podcast has ad detection
 * enabled. Analysis is keyed to the exact audio bytes (MD5) and skips episodes that
 * already have a skip map or are being analyzed.
 *
 * Runs with bounded retries, persisted state, and throttled execution to avoid heavy
 * work at app open (PR #49 fixed a startup freeze).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Episode } from '@/src/types';
import { isPodcastAdDetectionEnabled } from '@/src/db/storage';
import { getAutoSkipEnabled } from '@/src/db/storage';
import { getCachedAudioMd5, getCachedAudioPath } from '@/src/api/audioUpload';
import { getSkipMap } from '@/src/api/backend';

const ANALYZER_STATE_KEY = '@podcast-adskip/queueAnalyzerState';
const STARTUP_DELAY_MS = 5_000; // Don't analyze immediately at app open
const RETRY_DELAY_MS = 30_000; // Wait 30s before retrying a failed episode
const MAX_RETRIES = 3;

type AnalyzerState = {
  /** Episode currently being analyzed (or failed). */
  current: string | null;
  /** Guids that failed analysis: guid → retry count. */
  failed: Record<string, number>;
  /** Last activity timestamp (for throttling). */
  lastActivityMs: number;
};

let state: AnalyzerState = {
  current: null,
  failed: {},
  lastActivityMs: 0,
};

let hydrated = false;
let analyzing = false;
let stopRequested = false;
let scheduleTimer: NodeJS.Timeout | null = null;

/**
 * Function that requests analysis for an episode. Injected by PlaybackContext
 * to avoid circular dependencies. Returns the analysis result.
 */
type AnalyzeFunction = (ep: Episode) => Promise<{ status: string } | null>;
let analyzeFunction: AnalyzeFunction | null = null;

/**
 * Function that returns the current queue. Injected to avoid circular dependencies.
 */
type GetQueueFunction = () => Episode[];
let getQueueFunction: GetQueueFunction | null = null;

async function hydrateState(): Promise<void> {
  if (hydrated) return;
  try {
    const raw = await AsyncStorage.getItem(ANALYZER_STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        state = {
          current: parsed.current ?? null,
          failed: parsed.failed || {},
          lastActivityMs: parsed.lastActivityMs || 0,
        };
      }
    }
  } catch (e) {
    console.warn('[queueAnalyzer] Failed to hydrate state:', e);
  }
  hydrated = true;
}

async function persistState(): Promise<void> {
  if (!hydrated) return;
  try {
    await AsyncStorage.setItem(ANALYZER_STATE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('[queueAnalyzer] Failed to persist state:', e);
  }
}

function clearSchedule(): void {
  if (scheduleTimer) {
    clearTimeout(scheduleTimer);
    scheduleTimer = null;
  }
}

/**
 * Check if an episode already has a skip map or is being analyzed.
 * Returns true if we should skip analyzing this episode.
 */
async function hasExistingAnalysis(ep: Episode): Promise<boolean> {
  if (!ep.enclosureUrl) return true; // Can't analyze without audio URL

  try {
    // Check if there's a local file with MD5
    const localPath = await getCachedAudioPath(ep.guid, ep.enclosureUrl);
    if (localPath) {
      const audioMd5 = await getCachedAudioMd5(ep.guid, ep.enclosureUrl);
      if (audioMd5) {
        // Check server for a ready map with this fingerprint
        const map = await getSkipMap(ep.guid, audioMd5);
        if (map.status === 'ready' || map.status === 'pending' || map.status === 'queued') {
          return true;
        }
      }
    } else {
      // No local file: check server without fingerprint
      const map = await getSkipMap(ep.guid, null);
      if (map.status === 'ready' || map.status === 'pending' || map.status === 'queued') {
        return true;
      }
    }
  } catch (e) {
    // Network error or API unavailable: skip this episode for now
    console.warn('[queueAnalyzer] Failed to check existing analysis for', ep.guid, ':', e);
    return true;
  }

  return false;
}

/**
 * Find the next episode in the queue that needs analysis.
 * Returns null if no episodes need analysis or if auto-skip is disabled.
 */
async function findNextEpisode(): Promise<Episode | null> {
  if (stopRequested || !getQueueFunction) return null;

  // Check global auto-skip setting
  const globalAutoSkip = await getAutoSkipEnabled();
  if (!globalAutoSkip) return null;

  const queue = getQueueFunction();
  
  // Skip the first episode if it's currently playing (index 0)
  for (const ep of queue.slice(1)) {
    // Skip if currently analyzing this one
    if (state.current === ep.guid) continue;

    // Skip if failed too many times
    const retries = state.failed[ep.guid] || 0;
    if (retries >= MAX_RETRIES) continue;

    // Skip if failed recently (within retry delay)
    if (retries > 0) {
      const timeSinceLastActivity = Date.now() - state.lastActivityMs;
      if (timeSinceLastActivity < RETRY_DELAY_MS) continue;
    }

    // Check if podcast has ad detection enabled
    const detectionEnabled = await isPodcastAdDetectionEnabled({
      collectionId: ep.collectionId,
      feedUrl: ep.feedUrl,
    });
    if (!detectionEnabled) continue;

    // Check if already has analysis or is being analyzed
    const hasAnalysis = await hasExistingAnalysis(ep);
    if (hasAnalysis) continue;

    return ep;
  }

  return null;
}

/**
 * Analyze one episode from the queue.
 */
async function analyzeNext(): Promise<void> {
  if (analyzing || stopRequested || !analyzeFunction || !getQueueFunction) return;

  await hydrateState();

  const episode = await findNextEpisode();
  if (!episode) {
    state.current = null;
    await persistState();
    return;
  }

  analyzing = true;
  state.current = episode.guid;
  state.lastActivityMs = Date.now();
  await persistState();

  console.log('[queueAnalyzer] Starting background analysis for queued episode:', episode.guid);

  try {
    const result = await analyzeFunction(episode);
    
    if (!result) {
      throw new Error('Analysis returned null');
    }

    if (result.status === 'ready' || result.status === 'queued' || result.status === 'pending') {
      // Success: clear any failure count
      delete state.failed[episode.guid];
      console.log('[queueAnalyzer] Successfully analyzed:', episode.guid, 'status:', result.status);
    } else if (result.status === 'error' || result.status === 'missing') {
      // Failed: increment retry count
      state.failed[episode.guid] = (state.failed[episode.guid] || 0) + 1;
      console.warn('[queueAnalyzer] Analysis failed for:', episode.guid, 'retries:', state.failed[episode.guid]);
    }
  } catch (error) {
    state.failed[episode.guid] = (state.failed[episode.guid] || 0) + 1;
    console.error('[queueAnalyzer] Error analyzing episode:', episode.guid, error);
  } finally {
    analyzing = false;
    state.current = null;
    state.lastActivityMs = Date.now();
    await persistState();

    // Continue with next episode if not stopped and still initialized
    if (!stopRequested && analyzeFunction && getQueueFunction) {
      scheduleNext();
    }
  }
}

/**
 * Schedule the next analysis check.
 */
function scheduleNext(): void {
  clearSchedule();
  
  if (stopRequested) return;

  // Small delay to avoid tight loops
  scheduleTimer = setTimeout(() => {
    void analyzeNext();
  }, 1000);
}

/**
 * Trigger a queue analysis check. Throttled to avoid heavy work at app open.
 */
export function triggerQueueAnalysis(immediate = false): void {
  if (stopRequested) return;

  clearSchedule();

  const delay = immediate ? 0 : STARTUP_DELAY_MS;
  
  scheduleTimer = setTimeout(() => {
    void analyzeNext();
  }, delay);
}

/**
 * Initialize the queue analyzer. Must be called once at app start.
 */
export function startQueueAnalyzer(
  analyze: AnalyzeFunction,
  getQueue: GetQueueFunction,
): () => void {
  analyzeFunction = analyze;
  getQueueFunction = getQueue;
  stopRequested = false;

  // Start with a delay to avoid startup freeze
  triggerQueueAnalysis(false);

  return () => {
    stopRequested = true;
    clearSchedule();
    analyzeFunction = null;
    getQueueFunction = null;
  };
}

/**
 * Clear the analyzer state (for testing or manual reset).
 */
export async function resetQueueAnalyzer(): Promise<void> {
  clearSchedule();
  stopRequested = true;
  await hydrateState();
  state = {
    current: null,
    failed: {},
    lastActivityMs: 0,
  };
  await persistState();
  stopRequested = false;
  console.log('[queueAnalyzer] State reset');
}

/**
 * Reset module state for testing (synchronous, doesn't touch storage).
 */
export function __resetForTesting(): void {
  clearSchedule();
  stopRequested = false;
  analyzing = false;
  analyzeFunction = null;
  getQueueFunction = null;
  hydrated = false;
  state = {
    current: null,
    failed: {},
    lastActivityMs: 0,
  };
}
