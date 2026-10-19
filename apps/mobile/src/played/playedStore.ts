/**
 * Played state, persisted in AsyncStorage as { [episodeGuid]: playedAtMs }.
 * Module-level store so the player, lists and menus stay in sync.
 */
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const PLAYED_KEY = '@podcast-adskip/played';
/** Keep the map bounded (oldest entries dropped). */
const MAX_PLAYED = 3000;
/** Auto-mark played when this close to the end. */
export const PLAYED_NEAR_END_MS = 45_000;
/**
 * ...or this far through. Matches storage's NEAR_END_RATIO, where the resume position is
 * cleared, so a long episode is never "unplayed with no resume point".
 */
export const PLAYED_RATIO = 0.95;

type PlayedMap = Record<string, number>;

let played: PlayedMap = {};
let hydrated = false;
let hydrating: Promise<void> | null = null;
const listeners = new Set<() => void>();
/** Bumped on every change so React sees a new snapshot. */
let version = 0;

function notify() {
  version += 1;
  listeners.forEach((l) => l());
}

export function hydratePlayed(): Promise<void> {
  if (hydrated) return Promise.resolve();
  if (!hydrating) {
    hydrating = (async () => {
      let raw: string | null;
      try {
        raw = await AsyncStorage.getItem(PLAYED_KEY);
      } catch (e) {
        // Read failed (not "no data"): stay unhydrated so persist() can't overwrite the
        // stored history with only this session's changes; retry on the next call.
        console.warn('[played] hydrate failed; will retry:', e);
        hydrating = null;
        return;
      }
      let stored: unknown = {};
      try {
        stored = raw ? JSON.parse(raw) : {};
      } catch {
        console.warn('[played] stored history is corrupt; starting empty');
      }
      const hadPending = Object.keys(played).length > 0;
      played = { ...(stored && typeof stored === 'object' ? (stored as PlayedMap) : {}), ...played };
      hydrated = true;
      notify();
      // Save changes made while the stored history couldn't be read.
      if (hadPending) persist();
    })();
  }
  return hydrating;
}

function persist() {
  if (!hydrated) return;
  const entries = Object.entries(played);
  if (entries.length > MAX_PLAYED) {
    entries.sort((a, b) => b[1] - a[1]);
    played = Object.fromEntries(entries.slice(0, MAX_PLAYED));
  }
  void AsyncStorage.setItem(PLAYED_KEY, JSON.stringify(played)).catch((e) =>
    console.warn('[played] persist failed:', e),
  );
}

export function isPlayed(guid: string | null | undefined): boolean {
  return !!guid && played[guid] != null;
}

export async function setPlayed(guid: string, value: boolean): Promise<void> {
  await hydratePlayed();
  if (value === isPlayed(guid)) return;
  if (value) played = { ...played, [guid]: Date.now() };
  else {
    const { [guid]: _removed, ...rest } = played;
    played = rest;
  }
  notify();
  persist();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Listen for any played-state change (non-React). */
export function subscribePlayed(l: () => void): () => void {
  return subscribe(l);
}

/** Re-renders on any played-state change; use isPlayed(guid) in render. */
export function usePlayedVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

/** Should an episode at this position count as played? */
export function isNearEnd(positionMs: number, durationMs: number): boolean {
  if (!(durationMs > 60_000) || !(positionMs > 0)) return false;
  return durationMs - positionMs <= PLAYED_NEAR_END_MS || positionMs / durationMs >= PLAYED_RATIO;
}
