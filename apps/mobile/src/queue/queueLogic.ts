/**
 * Pure Up Next queue helpers (no React / storage) so they can be unit tested.
 * Queues are ordered arrays of episodes, unique by guid.
 */
import type { Episode } from '../types';

export type AutoQueueState = {
  /** Per-show "Auto-add new episodes to Up Next" (missing/false = off). */
  enabled: boolean;
  /** Newest pubDate (ms) already considered; only later episodes are auto-added. */
  lastSeenPubMs: number;
  /** Recently seen guids (bounded) so re-dated/undated items are not re-added. */
  seenGuids: string[];
};

export const MAX_SEEN_GUIDS = 300;

export function isQueued(queue: Episode[], guid: string): boolean {
  return queue.some((e) => e.guid === guid);
}

/** Append to the end; no-op if already queued (or it's the excluded/current guid). */
export function addToQueue(queue: Episode[], ep: Episode, excludeGuid?: string | null): Episode[] {
  if (!ep.guid || ep.guid === excludeGuid || isQueued(queue, ep.guid)) return queue;
  return [...queue, ep];
}

/** Put at the front; moves it there if it's already queued. */
export function playNext(queue: Episode[], ep: Episode, excludeGuid?: string | null): Episode[] {
  if (!ep.guid || ep.guid === excludeGuid) return queue;
  return [ep, ...queue.filter((e) => e.guid !== ep.guid)];
}

export function removeFromQueue(queue: Episode[], guid: string): Episode[] {
  return isQueued(queue, guid) ? queue.filter((e) => e.guid !== guid) : queue;
}

/** Move the item at `index` by `delta` (-1 up, +1 down), clamped. */
export function moveInQueue(queue: Episode[], index: number, delta: number): Episode[] {
  const to = index + delta;
  if (index < 0 || index >= queue.length || to < 0 || to >= queue.length || delta === 0) return queue;
  const next = [...queue];
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item);
  return next;
}

/** Next episode to auto-play after `finishedGuid`, plus the queue without it. */
export function takeNext(
  queue: Episode[],
  finishedGuid?: string | null,
): { next: Episode | null; rest: Episode[] } {
  const rest = queue.filter((e) => e.guid !== finishedGuid);
  const idx = rest.findIndex((e) => !!e.enclosureUrl);
  if (idx < 0) return { next: null, rest };
  return { next: rest[idx], rest: rest.filter((_, i) => i !== idx) };
}

/** Drop duplicate guids (keeps first) and malformed entries from persisted data. */
export function normalizeQueue(raw: unknown): Episode[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Episode[] = [];
  for (const item of raw) {
    const ep = item as Episode;
    if (!ep || typeof ep.guid !== 'string' || !ep.guid || seen.has(ep.guid)) continue;
    seen.add(ep.guid);
    out.push(ep);
  }
  return out;
}

function pubMs(ep: Episode): number {
  const t = ep.pubDate ? Date.parse(ep.pubDate) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/** Baseline when the user turns auto-add on: everything currently known counts as seen. */
export function enableAutoQueueState(knownEpisodes: Episode[], nowMs: number): AutoQueueState {
  const newest = knownEpisodes.reduce((m, e) => Math.max(m, pubMs(e)), 0);
  return {
    enabled: true,
    lastSeenPubMs: Math.max(newest, nowMs),
    seenGuids: knownEpisodes.map((e) => e.guid).slice(0, MAX_SEEN_GUIDS),
  };
}

/**
 * Given a refreshed feed, return episodes to auto-append (oldest first) and the
 * updated state. Only episodes not seen before AND published after the last
 * check qualify, so the back catalog is never backfilled.
 */
export function detectNewEpisodes(
  state: AutoQueueState,
  feedEpisodes: Episode[],
): { toAdd: Episode[]; state: AutoQueueState } {
  const seen = new Set(state.seenGuids);
  const toAdd = feedEpisodes
    .filter((e) => !!e.guid && !seen.has(e.guid) && !!e.enclosureUrl && pubMs(e) > state.lastSeenPubMs)
    .sort((a, b) => pubMs(a) - pubMs(b));
  const newest = feedEpisodes.reduce((m, e) => Math.max(m, pubMs(e)), state.lastSeenPubMs);
  const merged = [...feedEpisodes.map((e) => e.guid), ...state.seenGuids];
  const seenGuids = [...new Set(merged)].slice(0, MAX_SEEN_GUIDS);
  return { toAdd, state: { ...state, lastSeenPubMs: newest, seenGuids } };
}
