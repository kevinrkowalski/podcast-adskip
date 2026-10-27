/**
 * Up Next queue: module-level store persisted to AsyncStorage, shared by the
 * player context, feed refresh (auto-add) and UI via useQueue().
 */
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { hydratePlayed, isPlayed, subscribePlayed } from '@/src/played/playedStore';
import type { Episode } from '@/src/types';
import { triggerQueueAnalysis } from './queueAnalyzer';
import {
  addOnPlay,
  addToQueue as addPure,
  dropPlayed,
  detectNewEpisodes,
  enableAutoQueueState,
  moveInQueue,
  normalizeQueue,
  playNext as playNextPure,
  removeFromQueue as removePure,
  takeNext,
  upNextCount,
  type AutoQueueState,
} from './queueLogic';

const QUEUE_KEY = '@podcast-adskip/queue';
const AUTO_QUEUE_KEY = '@podcast-adskip/autoQueue';

let queue: Episode[] = [];
let hydrated = false;
let hydrating: Promise<void> | null = null;
const listeners = new Set<() => void>();
/** Episode currently loaded in the player (kept at index 0 of the queue). */
let currentGuid: string | null = null;

function slim(ep: Episode): Episode {
  // Show notes can be huge; the player refetches descriptions when needed.
  const { description: _description, podcastDescription: _podcastDescription, ...rest } = ep;
  return rest;
}

function setQueue(input: Episode[]) {
  // Played episodes never stay queued (except the one still playing at index 0).
  const next = dropPlayed(input, isPlayed, currentGuid);
  if (next === queue) return;
  queue = next;
  listeners.forEach((l) => l());
  // Until the stored queue has been read, writing would overwrite it with a partial
  // list; in-memory changes are merged in when hydration succeeds.
  if (!hydrated) return;
  void AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue)).catch((e) =>
    console.warn('[queue] persist failed:', e),
  );
}

function parseStoredQueue(raw: string | null): Episode[] {
  if (!raw) return [];
  try {
    return normalizeQueue(JSON.parse(raw));
  } catch {
    console.warn('[queue] stored queue is corrupt; starting empty');
    return [];
  }
}

export function hydrateQueue(): Promise<void> {
  if (hydrated) return Promise.resolve();
  if (!hydrating) {
    hydrating = (async () => {
      let raw: string | null;
      try {
        raw = await AsyncStorage.getItem(QUEUE_KEY);
      } catch (e) {
        // Read failed (not "no data"): stay unhydrated so nothing overwrites the stored
        // queue, and retry on the next call.
        console.warn('[queue] hydrate failed; will retry:', e);
        hydrating = null;
        return;
      }
      try {
        const stored = parseStoredQueue(raw);
        // Keep anything queued before hydration finished, after the stored items.
        let merged = stored;
        for (const ep of queue) merged = addPure(merged, ep);
        queue = merged;
        // One-time cleanup: drop episodes already marked played.
        await hydratePlayed();
        queue = dropPlayed(queue, isPlayed, currentGuid);
        // Persist if cleanup or items added before hydration changed anything.
        if (queue.length !== stored.length || queue.some((e, i) => e.guid !== stored[i]?.guid)) {
          void AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue)).catch(() => {});
        }
      } catch (e) {
        console.warn('[queue] hydrate failed:', e);
      } finally {
        hydrated = true;
        listeners.forEach((l) => l());
      }
    })();
  }
  return hydrating;
}

export function getQueue(): Episode[] {
  return queue;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useQueue(): Episode[] {
  return useSyncExternalStore(subscribe, getQueue, getQueue);
}

export function setCurrentQueueGuid(guid: string | null) {
  if (guid === currentGuid) return;
  currentGuid = guid;
  listeners.forEach((l) => l());
  // The previous episode may have been marked played while it was playing.
  if (hydrated) setQueue(queue);
}

// Marking an episode played (auto or manual) removes it from the queue live.
// Unmarking never re-adds.
subscribePlayed(() => {
  if (hydrated) setQueue(queue);
});

export function getCurrentQueueGuid(): string | null {
  return currentGuid;
}

/** Badge/label count: queued episodes excluding the playing one at index 0. */
export function useUpNextCount(): number {
  const q = useQueue();
  const playing = useSyncExternalStore(subscribe, getCurrentQueueGuid, getCurrentQueueGuid);
  return upNextCount(q, playing);
}

/** An episode started (any path): it becomes / stays index 0. */
export async function markPlaying(ep: Episode) {
  setCurrentQueueGuid(ep.guid);
  await hydrateQueue();
  setQueue(addOnPlay(queue, slim(ep)));
}

export async function addToQueue(ep: Episode) {
  await hydrateQueue();
  setQueue(addPure(queue, slim(ep)));
  // Trigger background analysis for newly queued episodes
  triggerQueueAnalysis(true);
}

export async function playNext(ep: Episode) {
  await hydrateQueue();
  setQueue(playNextPure(queue, slim(ep), currentGuid));
  // Trigger background analysis for newly queued episodes
  triggerQueueAnalysis(true);
}

export async function removeFromQueue(guid: string) {
  await hydrateQueue();
  setQueue(removePure(queue, guid));
}

export async function moveQueueItem(index: number, delta: number) {
  await hydrateQueue();
  setQueue(moveInQueue(queue, index, delta, currentGuid));
}

/** Clear Up Next; the playing episode at index 0 stays. */
export async function clearQueue() {
  await hydrateQueue();
  setQueue(currentGuid && queue[0]?.guid === currentGuid ? [queue[0]] : []);
}

/** Auto-advance: remove the finished episode; the returned next one is now index 0. */
export async function popNext(finishedGuid?: string | null): Promise<Episode | null> {
  await hydrateQueue();
  const { next, rest } = takeNext(queue, finishedGuid);
  setQueue(rest);
  return next;
}

// ---- Per-show "Auto-add new episodes to Up Next" ----

type AutoQueueAll = Record<string, AutoQueueState>;

export type ShowTarget = { collectionId?: number; feedUrl?: string };

function showKey(target: ShowTarget): string | null {
  if (target.collectionId != null && Number.isFinite(target.collectionId)) {
    return `collection:${target.collectionId}`;
  }
  const feed = target.feedUrl?.trim();
  return feed ? `feed:${feed}` : null;
}

/**
 * Throws when storage can't be read, so callers that write the whole blob back never
 * replace every show's settings with an empty object. Corrupt JSON reads as empty.
 */
async function readAutoQueue(): Promise<AutoQueueAll> {
  const raw = await AsyncStorage.getItem(AUTO_QUEUE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as AutoQueueAll) : {};
  } catch {
    console.warn('[queue] auto-add settings are corrupt; starting empty');
    return {};
  }
}

let autoQueueChain: Promise<unknown> = Promise.resolve();

/** Run read-modify-write operations on the auto-add blob one at a time. */
function serializeAutoQueue<T>(task: () => Promise<T>): Promise<T> {
  const run = autoQueueChain.then(task, task);
  autoQueueChain = run.catch(() => undefined);
  return run;
}

async function writeAutoQueue(all: AutoQueueAll) {
  await AsyncStorage.setItem(AUTO_QUEUE_KEY, JSON.stringify(all));
}

/** Missing value = off (covers every existing subscription). */
export async function isAutoQueueEnabled(target: ShowTarget): Promise<boolean> {
  const key = showKey(target);
  if (!key) return false;
  try {
    return (await readAutoQueue())[key]?.enabled === true;
  } catch (e) {
    console.warn('[queue] could not read auto-add settings:', e);
    return false;
  }
}

/** Turning on records the currently known episodes as seen (no backfill). */
export async function setAutoQueueEnabled(
  target: ShowTarget,
  enabled: boolean,
  knownEpisodes: Episode[],
): Promise<void> {
  const key = showKey(target);
  if (!key) return;
  // Serialized with feed processing, which would otherwise write back a stale copy
  // (silently undoing this toggle).
  await serializeAutoQueue(async () => {
    const all = await readAutoQueue();
    if (enabled) {
      all[key] = enableAutoQueueState(knownEpisodes, Date.now());
    } else if (all[key]) {
      all[key] = { ...all[key], enabled: false };
    }
    await writeAutoQueue(all);
  });
}

/** Called after a feed refresh: append newly published episodes when enabled. Resolves to the number added. */
export function processFeedForAutoQueue(target: ShowTarget, feedEpisodes: Episode[]): Promise<number> {
  // Serialize so concurrent refreshes don't double-add or lose seen state.
  return serializeAutoQueue(async (): Promise<number> => {
    const key = showKey(target);
    if (!key || !feedEpisodes.length) return 0;
    const all = await readAutoQueue();
    const state = all[key];
    if (!state?.enabled) return 0;
    const { toAdd, state: nextState } = detectNewEpisodes(state, feedEpisodes);
    all[key] = nextState;
    await writeAutoQueue(all);
    if (!toAdd.length) return 0;
    await hydrateQueue();
    const before = queue.length;
    let next = queue;
    for (const ep of toAdd) next = addPure(next, slim(ep));
    setQueue(next);
    console.log('[queue] auto-added', next.length - before, 'new episode(s) for', key);
    // Trigger background analysis for auto-added episodes
    triggerQueueAnalysis(true);
    return next.length - before;
  }).catch((e) => {
    console.warn('[queue] auto-add failed:', e);
    return 0;
  });
}

/** Shows with auto-add on (for the periodic subscription refresh). */
export async function getAutoQueueShowKeys(): Promise<string[]> {
  const all = await readAutoQueue();
  return Object.keys(all).filter((k) => all[k]?.enabled);
}

export { showKey as autoQueueShowKey };
