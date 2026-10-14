/**
 * Up Next queue: module-level store persisted to AsyncStorage, shared by the
 * player context, feed refresh (auto-add) and UI via useQueue().
 */
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { hydratePlayed, isPlayed, subscribePlayed } from '@/src/played/playedStore';
import type { Episode } from '@/src/types';
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
  void AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue)).catch((e) =>
    console.warn('[queue] persist failed:', e),
  );
}

export function hydrateQueue(): Promise<void> {
  if (hydrated) return Promise.resolve();
  if (!hydrating) {
    hydrating = (async () => {
      try {
        const raw = await AsyncStorage.getItem(QUEUE_KEY);
        const stored = raw ? normalizeQueue(JSON.parse(raw)) : [];
        // Keep anything queued before hydration finished, after the stored items.
        let merged = stored;
        for (const ep of queue) merged = addPure(merged, ep);
        queue = merged;
        // One-time cleanup: drop episodes already marked played.
        await hydratePlayed();
        const cleaned = dropPlayed(queue, isPlayed, currentGuid);
        if (cleaned !== queue) {
          queue = cleaned;
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
}

export async function playNext(ep: Episode) {
  await hydrateQueue();
  setQueue(playNextPure(queue, slim(ep), currentGuid));
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

async function readAutoQueue(): Promise<AutoQueueAll> {
  try {
    const raw = await AsyncStorage.getItem(AUTO_QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as AutoQueueAll) : {};
  } catch {
    return {};
  }
}

async function writeAutoQueue(all: AutoQueueAll) {
  await AsyncStorage.setItem(AUTO_QUEUE_KEY, JSON.stringify(all));
}

/** Missing value = off (covers every existing subscription). */
export async function isAutoQueueEnabled(target: ShowTarget): Promise<boolean> {
  const key = showKey(target);
  if (!key) return false;
  return (await readAutoQueue())[key]?.enabled === true;
}

/** Turning on records the currently known episodes as seen (no backfill). */
export async function setAutoQueueEnabled(
  target: ShowTarget,
  enabled: boolean,
  knownEpisodes: Episode[],
): Promise<void> {
  const key = showKey(target);
  if (!key) return;
  const all = await readAutoQueue();
  if (enabled) {
    all[key] = enableAutoQueueState(knownEpisodes, Date.now());
  } else if (all[key]) {
    all[key] = { ...all[key], enabled: false };
  }
  await writeAutoQueue(all);
}

let autoQueueChain: Promise<unknown> = Promise.resolve();

/** Called after a feed refresh: append newly published episodes when enabled. Resolves to the number added. */
export function processFeedForAutoQueue(target: ShowTarget, feedEpisodes: Episode[]): Promise<number> {
  // Serialize so concurrent refreshes don't double-add or lose seen state.
  const run = autoQueueChain.then(async (): Promise<number> => {
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
    return next.length - before;
  }).catch((e) => {
    console.warn('[queue] auto-add failed:', e);
    return 0;
  });
  autoQueueChain = run;
  return run;
}

/** Shows with auto-add on (for the periodic subscription refresh). */
export async function getAutoQueueShowKeys(): Promise<string[]> {
  const all = await readAutoQueue();
  return Object.keys(all).filter((k) => all[k]?.enabled);
}

export { showKey as autoQueueShowKey };
