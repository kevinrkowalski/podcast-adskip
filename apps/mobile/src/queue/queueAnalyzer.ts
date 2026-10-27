/**
 * Background auto-analysis for the Up Next queue.
 *
 * Queued episodes are analyzed one at a time when global ad detection (Settings) and the
 * show's own ad detection are both on. The injected analyze function is the same
 * download + upload flow used by Prepare / play, so the analyzed bytes (MD5) are exactly
 * the cached file that will later be played.
 *
 * Bounds:
 * - Never runs before STARTUP_DELAY_MS after start (PR #49 fixed a startup freeze).
 * - One download/upload at a time, and at most one server job in flight: after an upload
 *   comes back queued/pending, the next episode waits until that job finishes (polled
 *   every SERVER_POLL_MS, given up after SERVER_WAIT_MAX_MS).
 * - Failed episodes are retried at most MAX_RETRIES times, RETRY_DELAY_MS apart.
 * - The currently loaded / playing episode is left to the player's own flow.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Episode, SkipMap } from '@/src/types';
import { getAutoSkipEnabled, getCachedSkipMap, isPodcastAdDetectionEnabled } from '@/src/db/storage';
import { getCachedAudioMd5, getCachedAudioPath } from '@/src/api/audioUpload';
import { getSkipMap } from '@/src/api/backend';

const ANALYZER_STATE_KEY = '@podcast-adskip/queueAnalyzerState';
export const STARTUP_DELAY_MS = 5_000;
export const TRIGGER_DEBOUNCE_MS = 1_000;
export const RETRY_DELAY_MS = 30_000;
export const MAX_RETRIES = 3;
export const SERVER_POLL_MS = 30_000;
export const SERVER_WAIT_MAX_MS = 30 * 60_000;

type AnalyzerState = {
  /** guid → failed attempts. */
  failed: Record<string, number>;
  /** guid → time of the last failure (ms). */
  failedAt: Record<string, number>;
};

/** Server job started by the analyzer that hasn't finished yet. */
type ServerJob = { guid: string; audioMd5: string | null; sinceMs: number };

let state: AnalyzerState = { failed: {}, failedAt: {} };
let hydrated = false;
let running = false;
/** A trigger arrived during a pass: run again when it finishes. */
let rerunRequested = false;
let started = false;
let earliestRunMs = 0;
let serverJob: ServerJob | null = null;
/** Guids whose analysis succeeded this session: never re-uploaded by the analyzer. */
const analyzedThisSession = new Set<string>();
let scheduleTimer: ReturnType<typeof setTimeout> | null = null;

/** Same analyze flow as Prepare/play (download, fingerprint, upload). Injected by PlaybackContext. */
export type AnalyzeFunction = (ep: Episode) => Promise<SkipMap | { status: string; audio_md5?: string | null } | null>;
export type GetQueueFunction = () => Episode[];
/** Guids the player owns right now (loaded / playing episode); never analyzed here. */
export type GetCurrentGuidsFunction = () => (string | null | undefined)[];

let analyzeFunction: AnalyzeFunction | null = null;
let getQueueFunction: GetQueueFunction | null = null;
let getCurrentGuidsFunction: GetCurrentGuidsFunction = () => [];

const BUSY = new Set(['pending', 'queued']);

async function hydrateState(): Promise<void> {
  if (hydrated) return;
  try {
    const raw = await AsyncStorage.getItem(ANALYZER_STATE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      state = {
        failed: parsed.failed && typeof parsed.failed === 'object' ? parsed.failed : {},
        failedAt: parsed.failedAt && typeof parsed.failedAt === 'object' ? parsed.failedAt : {},
      };
    }
  } catch (e) {
    console.warn('[queueAnalyzer] Failed to hydrate state:', e);
  }
  hydrated = true;
}

async function persistState(): Promise<void> {
  if (!hydrated) return;
  // Only keep entries for episodes still queued.
  const queued = new Set((getQueueFunction?.() ?? []).map((e) => e.guid));
  for (const guid of Object.keys(state.failed)) {
    if (!queued.has(guid)) {
      delete state.failed[guid];
      delete state.failedAt[guid];
    }
  }
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

function schedule(delayMs: number): void {
  if (!started) return;
  clearSchedule();
  const delay = Math.max(delayMs, earliestRunMs - Date.now(), 0);
  scheduleTimer = setTimeout(() => {
    scheduleTimer = null;
    void analyzeNext();
  }, delay);
}

/** True when this episode already has (or is getting) an analysis for the bytes we'd play. */
async function hasExistingAnalysis(ep: Episode): Promise<boolean> {
  if (!ep.enclosureUrl) return true; // nothing to analyze
  try {
    const localPath = await getCachedAudioPath(ep.guid, ep.enclosureUrl);
    const audioMd5 = localPath ? await getCachedAudioMd5(ep.guid, ep.enclosureUrl) : null;
    if (audioMd5) {
      const cached = await getCachedSkipMap(ep.guid, ep.enclosureUrl);
      if (cached?.status === 'ready' && cached.audio_md5?.toLowerCase() === audioMd5) return true;
    }
    // With no download yet, the server can only answer by guid; a ready map for other bytes
    // reports "missing", so we still download (needed for skips anyway) and upload; the
    // server reuses its result when the bytes match.
    const map = await getSkipMap(ep.guid, audioMd5);
    return map.status === 'ready' || BUSY.has(map.status);
  } catch (e) {
    // Network/API trouble: try again on a later trigger rather than hammering.
    console.warn('[queueAnalyzer] Could not check existing analysis for', ep.guid, e);
    return true;
  }
}

type Pick = { episode: Episode | null; retryInMs: number | null };

async function findNextEpisode(): Promise<Pick> {
  const none: Pick = { episode: null, retryInMs: null };
  if (!getQueueFunction) return none;
  if (!(await getAutoSkipEnabled())) return none; // global Settings kill-switch

  const current = new Set(getCurrentGuidsFunction().filter((g): g is string => !!g));
  let retryInMs: number | null = null;
  for (const ep of getQueueFunction()) {
    if (!started) return none;
    if (current.has(ep.guid) || analyzedThisSession.has(ep.guid)) continue;
    const retries = state.failed[ep.guid] ?? 0;
    if (retries >= MAX_RETRIES) continue;
    if (retries > 0) {
      const wait = (state.failedAt[ep.guid] ?? 0) + RETRY_DELAY_MS - Date.now();
      if (wait > 0) {
        retryInMs = retryInMs == null ? wait : Math.min(retryInMs, wait);
        continue;
      }
    }
    const enabled = await isPodcastAdDetectionEnabled({
      collectionId: ep.collectionId,
      feedUrl: ep.feedUrl,
    });
    if (!enabled) continue;
    if (await hasExistingAnalysis(ep)) continue;
    return { episode: ep, retryInMs: null };
  }
  return { episode: null, retryInMs };
}

/** While our last upload is still being processed by the server, don't start another. */
async function waitingOnServer(): Promise<boolean> {
  if (!serverJob) return false;
  if (Date.now() - serverJob.sinceMs > SERVER_WAIT_MAX_MS) {
    console.warn('[queueAnalyzer] Server job still unfinished; moving on:', serverJob.guid);
    serverJob = null;
    return false;
  }
  try {
    const map = await getSkipMap(serverJob.guid, serverJob.audioMd5);
    if (BUSY.has(map.status)) return true;
  } catch (e) {
    console.warn('[queueAnalyzer] Could not poll server job', serverJob.guid, e);
    return true;
  }
  serverJob = null;
  return false;
}

function recordFailure(guid: string): void {
  state.failed[guid] = (state.failed[guid] ?? 0) + 1;
  state.failedAt[guid] = Date.now();
}

async function analyzeNext(): Promise<void> {
  if (running || !started || !analyzeFunction || !getQueueFunction) return;
  running = true;
  rerunRequested = false;
  let nextDelay: number | null = null;
  try {
    await hydrateState();
    if (await waitingOnServer()) {
      nextDelay = SERVER_POLL_MS;
      return;
    }
    const pick = await findNextEpisode();
    const episode = pick.episode;
    if (!episode || !started || !analyzeFunction) {
      nextDelay = pick.retryInMs;
      return;
    }

    console.log('[queueAnalyzer] Background analysis for queued episode:', episode.guid);
    try {
      const result = await analyzeFunction(episode);
      if (!result || result.status === 'error' || result.status === 'missing') {
        recordFailure(episode.guid);
        console.warn('[queueAnalyzer] Analysis failed:', episode.guid, 'attempts:', state.failed[episode.guid]);
      } else {
        analyzedThisSession.add(episode.guid);
        delete state.failed[episode.guid];
        delete state.failedAt[episode.guid];
        if (BUSY.has(result.status)) {
          const md5 = typeof result.audio_md5 === 'string' ? result.audio_md5.toLowerCase() : null;
          serverJob = { guid: episode.guid, audioMd5: md5, sinceMs: Date.now() };
        }
        console.log('[queueAnalyzer] Analyzed:', episode.guid, 'status:', result.status);
      }
    } catch (error) {
      recordFailure(episode.guid);
      console.warn('[queueAnalyzer] Error analyzing', episode.guid, error);
    }
    await persistState();
    // Look for the next one (waitingOnServer() holds it back while the server works).
    nextDelay = serverJob ? SERVER_POLL_MS : TRIGGER_DEBOUNCE_MS;
  } catch (e) {
    console.warn('[queueAnalyzer] Pass failed:', e);
  } finally {
    running = false;
    if (rerunRequested && nextDelay == null) nextDelay = TRIGGER_DEBOUNCE_MS;
    rerunRequested = false;
    if (nextDelay != null && started) schedule(nextDelay);
  }
}

/** Queue changed or a setting turned on: check for work soon (never before the startup delay). */
export function triggerQueueAnalysis(): void {
  if (!started) return;
  if (running) {
    rerunRequested = true; // the running pass reschedules itself
    return;
  }
  // Don't cut short a wait on the server job / retry with a sooner poll than needed.
  if (serverJob) return;
  schedule(TRIGGER_DEBOUNCE_MS);
}

/** Start the analyzer (once, from PlaybackContext). Returns a stop function. */
export function startQueueAnalyzer(
  analyze: AnalyzeFunction,
  getQueue: GetQueueFunction,
  getCurrentGuids: GetCurrentGuidsFunction = () => [],
): () => void {
  analyzeFunction = analyze;
  getQueueFunction = getQueue;
  getCurrentGuidsFunction = getCurrentGuids;
  started = true;
  earliestRunMs = Date.now() + STARTUP_DELAY_MS;
  schedule(STARTUP_DELAY_MS);
  return () => {
    started = false;
    clearSchedule();
    analyzeFunction = null;
    getQueueFunction = null;
    getCurrentGuidsFunction = () => [];
  };
}

/** Reset module state for tests (doesn't touch storage). */
export function __resetForTesting(): void {
  clearSchedule();
  started = false;
  running = false;
  rerunRequested = false;
  hydrated = false;
  serverJob = null;
  analyzedThisSession.clear();
  earliestRunMs = 0;
  analyzeFunction = null;
  getQueueFunction = null;
  getCurrentGuidsFunction = () => [];
  state = { failed: {}, failedAt: {} };
}
