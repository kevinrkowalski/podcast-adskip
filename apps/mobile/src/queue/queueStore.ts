/**
 * Up Next queue: module-level store persisted to AsyncStorage, shared by the
 * player context, feed refresh (auto-add) and UI via useQueue().
 */
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Episode } from '@/src/types';
import {
  addToQueue as addPure,
  detectNewEpisodes,
  enableAutoQueueState,
  moveInQueue,
  normalizeQueue,
  playNext as playNextPure,
  removeFromQueue as removePure,
  takeNext,
  type AutoQueueState,
} from './queueLogic';

const QUEUE_KEY = '@podcast-adskip/queue';
const AUTO_QUEUE_KEY = '@podcast-adskip/autoQueue';

let queue: Episode[] = [];
let hydrated = false;
let hydrating: Promise<void> | null = null;
const listeners = new Set<() => void>();
/** Episode currently loaded in the player; never queued alongside itself. */
let currentGuid: string | null = null;

function slim(ep: Episode): Episode {
  // Show notes can be huge; the player refetches descriptions when needed.
  const { description: _description, podcastDescription: _podcastDescription, ...rest } = ep;
  return rest;
}

function setQueue(next: Episode[]) {
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
  currentGuid = guid;
}

export async function addToQueue(ep: Episode) {
  await hydrateQueue();
  setQueue(addPure(queue, slim(ep), currentGuid));
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
  setQueue(moveInQueue(queue, index, delta));
}

export async function clearQueue() {
  await hydrateQueue();
  setQueue([]);
}

/** Pop the next playable episode after `finishedGuid` (removing both from the queue). */
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

let autoQueueChain: Promise<void> = Promise.resolve();

/** Called after a feed refresh: append newly published episodes when enabled. */
export function processFeedForAutoQueue(target: ShowTarget, feedEpisodes: Episode[]): Promise<void> {
  // Serialize so concurrent refreshes don't double-add or lose seen state.
  autoQueueChain = autoQueueChain.then(async () => {
    const key = showKey(target);
    if (!key || !feedEpisodes.length) return;
    const all = await readAutoQueue();
    const state = all[key];
    if (!state?.enabled) return;
    const { toAdd, state: nextState } = detectNewEpisodes(state, feedEpisodes);
    all[key] = nextState;
    await writeAutoQueue(all);
    if (!toAdd.length) return;
    await hydrateQueue();
    let next = queue;
    for (const ep of toAdd) next = addPure(next, slim(ep), currentGuid);
    setQueue(next);
    console.log('[queue] auto-added', toAdd.length, 'new episode(s) for', key);
  }).catch((e) => console.warn('[queue] auto-add failed:', e));
  return autoQueueChain;
}

/** Shows with auto-add on (for the periodic subscription refresh). */
export async function getAutoQueueShowKeys(): Promise<string[]> {
  const all = await readAutoQueue();
  return Object.keys(all).filter((k) => all[k]?.enabled);
}

export { showKey as autoQueueShowKey };
