/**
 * Lightweight AsyncStorage-backed persistence for subscriptions + settings.
 * Episode caches are deliberately small and omit descriptions because Android
 * AsyncStorage stores each value in a SQLite row/cursor window.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Episode, SkipMap, Subscription } from '@/src/types';

const KEYS = {
  subscriptions: '@podcast-adskip/subscriptions',
  episodes: '@podcast-adskip/episodes/',
  skipMaps: '@podcast-adskip/skipmaps/',
  /** Slim per-episode resume: value is just `${positionMs}` (optional `:${durationMs}`). */
  positions: '@podcast-adskip/pos/',
  autoSkip: '@podcast-adskip/autoSkip',
  adDetectionDisabled: '@podcast-adskip/adDetectionDisabled',
  apiUrl: '@podcast-adskip/apiUrl',
  appKey: '@podcast-adskip/appKey',
} as const;

/** Ignore tiny scrub noise; treat near-end as finished (clear resume). */
const MIN_SAVE_POSITION_MS = 5_000;
const NEAR_END_MS = 15_000;
const NEAR_END_RATIO = 0.95;

/** Keep the on-device RSS cache bounded; the feed remains the source of truth. */
const MAX_CACHED_EPISODES = 100;
/** Leave plenty of room below Android's per-row CursorWindow limit. */
const MAX_CACHED_JSON_CHARS = 200_000;

/** Default backend URL: EXPO_PUBLIC_API_URL, else LAN IP used in .env.example. */
export const DEFAULT_API_URL =
  (typeof process !== 'undefined' && process.env.EXPO_PUBLIC_API_URL
    ? process.env.EXPO_PUBLIC_API_URL.replace(/\/$/, '')
    : '') || 'http://192.168.0.124:8000';

export async function getSubscriptions(): Promise<Subscription[]> {
  const raw = await AsyncStorage.getItem(KEYS.subscriptions);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as Subscription[];
  } catch {
    return [];
  }
}

export async function saveSubscriptions(subs: Subscription[]): Promise<void> {
  await AsyncStorage.setItem(KEYS.subscriptions, JSON.stringify(subs));
}

export async function subscribe(sub: Subscription): Promise<Subscription[]> {
  const current = await getSubscriptions();
  if (current.some((s) => s.collectionId === sub.collectionId)) return current;
  const next = [...current, sub];
  await saveSubscriptions(next);
  return next;
}

export async function unsubscribe(collectionId: number): Promise<Subscription[]> {
  const next = (await getSubscriptions()).filter((s) => s.collectionId !== collectionId);
  await saveSubscriptions(next);
  return next;
}

/** Patch fields on an existing subscription (matched by collectionId). */
export async function updateSubscription(
  collectionId: number,
  patch: Partial<Omit<Subscription, 'collectionId'>>,
): Promise<Subscription[]> {
  const current = await getSubscriptions();
  let changed = false;
  const next = current.map((s) => {
    if (s.collectionId !== collectionId) return s;
    changed = true;
    return { ...s, ...patch, collectionId };
  });
  if (!changed) return current;
  await saveSubscriptions(next);
  return next;
}

/**
 * Keep only fields needed to render/play an episode. In particular, RSS
 * descriptions can be very large and are not needed by the mobile player.
 */
function slimEpisode(ep: Episode): Episode {
  return {
    guid: ep.guid,
    title: ep.title,
    pubDate: ep.pubDate,
    duration: ep.duration,
    durationMs: ep.durationMs,
    enclosureUrl: ep.enclosureUrl,
    enclosureType: ep.enclosureType,
    artworkUrl: ep.artworkUrl,
    feedUrl: ep.feedUrl,
    podcastTitle: ep.podcastTitle,
    collectionId: ep.collectionId,
  };
}

function boundedEpisodes(episodes: Episode[]): Episode[] {
  const slim = episodes.slice(0, MAX_CACHED_EPISODES).map(slimEpisode);
  let count = slim.length;
  let payload = JSON.stringify(slim.slice(0, count));
  while (payload.length > MAX_CACHED_JSON_CHARS && count > 1) {
    count -= 1;
    payload = JSON.stringify(slim.slice(0, count));
  }
  return slim.slice(0, count);
}

export async function cacheEpisodes(feedUrl: string, episodes: Episode[]): Promise<void> {
  const bounded = boundedEpisodes(episodes);
  // Caching is best-effort; playback and browsing should not fail if storage is unavailable.
  try {
    await AsyncStorage.setItem(
      KEYS.episodes + encodeURIComponent(feedUrl),
      JSON.stringify(bounded),
    );
  } catch (error) {
    console.warn('[storage] episode cache write skipped:', error);
  }
}

export async function getCachedEpisodes(feedUrl: string): Promise<Episode[]> {
  const key = KEYS.episodes + encodeURIComponent(feedUrl);
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(key);
  } catch (error) {
    // Also evict legacy oversized values that trigger CursorWindow on Android.
    try {
      await AsyncStorage.removeItem(key);
    } catch {
      /* ignore cleanup failure */
    }
    console.warn('[storage] episode cache read skipped:', error);
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const bounded = boundedEpisodes(parsed as Episode[]);
    // Migrate older full-description caches the first time they are read.
    if (JSON.stringify(bounded) !== raw) {
      await cacheEpisodes(feedUrl, bounded);
    }
    return bounded;
  } catch {
    return [];
  }
}

export async function cacheSkipMap(guid: string, map: SkipMap): Promise<void> {
  await AsyncStorage.setItem(KEYS.skipMaps + encodeURIComponent(guid), JSON.stringify(map));
}

export async function getCachedSkipMap(guid: string): Promise<SkipMap | null> {
  const raw = await AsyncStorage.getItem(KEYS.skipMaps + encodeURIComponent(guid));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SkipMap;
  } catch {
    return null;
  }
}

export async function getAutoSkipEnabled(): Promise<boolean> {
  const raw = await AsyncStorage.getItem(KEYS.autoSkip);
  return raw !== 'false';
}

export async function setAutoSkipEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(KEYS.autoSkip, enabled ? 'true' : 'false');
}

export type AdDetectionTarget = {
  collectionId?: number;
  feedUrl?: string;
};

function adDetectionTargetKeys(target: AdDetectionTarget): string[] {
  const keys: string[] = [];
  if (target.collectionId != null && Number.isFinite(target.collectionId)) {
    keys.push(`collection:${target.collectionId}`);
  }
  const feedUrl = target.feedUrl?.trim();
  if (feedUrl) keys.push(`feed:${feedUrl}`);
  return keys;
}

/** Collection/feed keys for shows that have ad detection explicitly disabled. */
export async function getAdDetectionDisabled(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(KEYS.adDetectionDisabled);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : []);
  } catch {
    return new Set();
  }
}

export async function isPodcastAdDetectionEnabled(target: AdDetectionTarget): Promise<boolean> {
  const keys = adDetectionTargetKeys(target);
  if (!keys.length) return true;
  const disabled = await getAdDetectionDisabled();
  return !keys.some((key) => disabled.has(key));
}

export async function setPodcastAdDetectionEnabled(
  target: AdDetectionTarget,
  enabled: boolean,
): Promise<void> {
  const keys = adDetectionTargetKeys(target);
  if (!keys.length) return;
  const disabled = await getAdDetectionDisabled();
  for (const key of keys) {
    if (enabled) disabled.delete(key);
    else disabled.add(key);
  }
  await AsyncStorage.setItem(KEYS.adDetectionDisabled, JSON.stringify([...disabled]));
}

export async function getApiUrl(): Promise<string> {
  const raw = await AsyncStorage.getItem(KEYS.apiUrl);
  if (raw && raw.trim()) return raw.replace(/\/$/, '');
  return DEFAULT_API_URL;
}

export async function setApiUrl(url: string): Promise<void> {
  const cleaned = url.trim().replace(/\/$/, '');
  if (!cleaned) {
    await AsyncStorage.removeItem(KEYS.apiUrl);
    return;
  }
  await AsyncStorage.setItem(KEYS.apiUrl, cleaned);
}


export async function getAppKey(): Promise<string> {
  const raw = await AsyncStorage.getItem(KEYS.appKey);
  if (raw != null && raw.trim()) return raw.trim();
  return '';
}

export async function setAppKey(key: string): Promise<void> {
  const cleaned = key.trim();
  if (!cleaned) {
    await AsyncStorage.removeItem(KEYS.appKey);
    return;
  }
  await AsyncStorage.setItem(KEYS.appKey, cleaned);
}


export type PlaybackPosition = {
  positionMs: number;
  durationMs?: number;
  updatedAt: number;
};

function positionKey(guid: string): string {
  return KEYS.positions + encodeURIComponent(guid);
}

/** Whether a position is worth keeping / showing as resume progress. */
export function isMeaningfulPosition(positionMs: number, durationMs?: number): boolean {
  if (!Number.isFinite(positionMs) || positionMs < MIN_SAVE_POSITION_MS) return false;
  if (durationMs != null && durationMs > 0) {
    if (positionMs >= durationMs - NEAR_END_MS) return false;
    if (positionMs / durationMs >= NEAR_END_RATIO) return false;
  }
  return true;
}

/** Persist slim resume point for an episode (best-effort). */
export async function savePlaybackPosition(
  guid: string,
  positionMs: number,
  durationMs?: number,
): Promise<void> {
  if (!guid) return;
  const key = positionKey(guid);
  try {
    if (!isMeaningfulPosition(positionMs, durationMs)) {
      await AsyncStorage.removeItem(key);
      return;
    }
    // Slim payload: pos[:dur]:updatedAt — avoid large JSON objects.
    const dur = durationMs != null && durationMs > 0 ? Math.floor(durationMs) : 0;
    const payload = `${Math.floor(positionMs)}:${dur}:${Date.now()}`;
    await AsyncStorage.setItem(key, payload);
  } catch (error) {
    console.warn('[storage] position write skipped:', error);
  }
}

function parsePositionRaw(raw: string): PlaybackPosition | null {
  if (!raw) return null;
  if (/^\d/.test(raw) && !raw.trimStart().startsWith('{')) {
    const parts = raw.split(':');
    const positionMs = parseInt(parts[0]!, 10);
    const durationMs = parts[1] ? parseInt(parts[1], 10) : undefined;
    const updatedAt = parts[2] ? parseInt(parts[2], 10) : Date.now();
    if (!Number.isFinite(positionMs)) return null;
    if (!isMeaningfulPosition(positionMs, durationMs || undefined)) return null;
    return {
      positionMs,
      durationMs: durationMs && durationMs > 0 ? durationMs : undefined,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
    };
  }
  try {
    const parsed = JSON.parse(raw) as PlaybackPosition;
    if (!parsed || !Number.isFinite(parsed.positionMs)) return null;
    if (!isMeaningfulPosition(parsed.positionMs, parsed.durationMs)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function getPlaybackPosition(guid: string): Promise<PlaybackPosition | null> {
  if (!guid) return null;
  try {
    const raw = await AsyncStorage.getItem(positionKey(guid));
    if (!raw) return null;
    const pos = parsePositionRaw(raw);
    if (!pos) {
      await AsyncStorage.removeItem(positionKey(guid));
      return null;
    }
    return pos;
  } catch (error) {
    console.warn('[storage] position read skipped:', error);
    return null;
  }
}

export async function clearPlaybackPosition(guid: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(positionKey(guid));
  } catch {
    /* ignore */
  }
}

/** Batch-read resume positions for episode list UI (slim keys only). */
export async function getPlaybackPositions(
  guids: string[],
): Promise<Record<string, PlaybackPosition>> {
  const out: Record<string, PlaybackPosition> = {};
  const unique = [...new Set(guids.filter(Boolean))];
  if (!unique.length) return out;
  try {
    const keys = unique.map(positionKey);
    const pairs = await AsyncStorage.multiGet(keys);
    const stale: string[] = [];
    for (let i = 0; i < unique.length; i++) {
      const guid = unique[i]!;
      const raw = pairs[i]?.[1];
      if (!raw) continue;
      const pos = parsePositionRaw(raw);
      if (pos) out[guid] = pos;
      else stale.push(positionKey(guid));
    }
    if (stale.length) {
      try {
        await AsyncStorage.multiRemove(stale);
      } catch {
        /* ignore */
      }
    }
  } catch (error) {
    console.warn('[storage] positions batch read skipped:', error);
  }
  return out;
}

/** Clear episode + skip-map caches (keeps subscriptions and settings). */
export async function clearCaches(): Promise<number> {
  const keys = await AsyncStorage.getAllKeys();
  const toRemove = keys.filter(
    (k) => k.startsWith(KEYS.episodes) || k.startsWith(KEYS.skipMaps),
  );
  if (toRemove.length) await AsyncStorage.multiRemove(toRemove);
  return toRemove.length;
}
