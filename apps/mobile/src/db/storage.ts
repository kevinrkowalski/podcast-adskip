/**
 * Lightweight AsyncStorage-backed persistence for subscriptions + settings.
 * Episode caches are deliberately small and omit descriptions because Android
 * AsyncStorage stores each value in a SQLite row/cursor window.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Episode, SkipMap, Subscription } from '@/src/types';

/** Per-show skip settings (master + 3 kind toggles). */
export type PodcastSkipSettings = {
  /** Master toggle: if false, no skipping at all for this show. */
  skipEnabled: boolean;
  /** Skip advertisement segments (default: true). */
  skipAdvertisement: boolean;
  /** Skip intro/outro segments (default: true). */
  skipIntroOutro: boolean;
  /** Skip self-promotion segments (default: true). */
  skipSelfPromotion: boolean;
};

const KEYS = {
  subscriptions: '@podcast-adskip/subscriptions',
  episodes: '@podcast-adskip/episodes/',
  skipMaps: '@podcast-adskip/skipmaps/',
  audioCache: '@podcast-adskip/audioCache/',
  /** Slim per-episode resume: value is just `${positionMs}` (optional `:${durationMs}`). */
  positions: '@podcast-adskip/pos/',
  autoSkip: '@podcast-adskip/autoSkip',
  adDetectionDisabled: '@podcast-adskip/adDetectionDisabled',
  /** Per-show skip settings (master + 3 kind toggles). */
  podcastSkipSettings: '@podcast-adskip/podcastSkipSettings',
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

/** Skip-map storage key by episode GUID (primary). */
function skipMapGuidKey(guid: string): string {
  return KEYS.skipMaps + encodeURIComponent(guid);
}

/**
 * Secondary skip-map key by enclosure URL.
 * Some feeds use unstable or missing <guid> values (fallback to URL/link), so
 * cold-start reload must still find maps when the GUID string drifts but the
 * audio URL stays the same.
 */
function skipMapUrlKey(enclosureUrl: string): string {
  return KEYS.skipMaps + 'url:' + encodeURIComponent(enclosureUrl.trim());
}

function parseSkipMapRaw(raw: string | null): SkipMap | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SkipMap;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist a ready skip map under the episode GUID and, when available, the
 * enclosure URL so reopen after cold start can resolve either key.
 */
export async function cacheSkipMap(
  guid: string,
  map: SkipMap,
  enclosureUrl?: string | null,
): Promise<void> {
  if (!guid) return;
  const payload = JSON.stringify(map);
  const pairs: [string, string][] = [[skipMapGuidKey(guid), payload]];
  const url = enclosureUrl?.trim();
  if (url) pairs.push([skipMapUrlKey(url), payload]);
  try {
    await AsyncStorage.multiSet(pairs);
  } catch (error) {
    // Fall back to single-key write so a URL-key failure does not lose the GUID entry.
    console.warn('[storage] skip-map multiSet failed, trying GUID only:', error);
    try {
      await AsyncStorage.setItem(skipMapGuidKey(guid), payload);
    } catch (inner) {
      console.warn('[storage] skip-map write skipped:', inner);
      throw inner;
    }
  }
  console.log(
    `[storage] saved skip-map: ${map.status}, ${map.segments?.length ?? 0} segments`,
  );
}

/**
 * Load a cached skip map by GUID, falling back to enclosure URL when the GUID
 * miss happens (unstable RSS guids). When found via URL under a new GUID,
 * re-index under the current GUID for faster subsequent loads.
 */
export async function getCachedSkipMap(
  guid: string,
  enclosureUrl?: string | null,
): Promise<SkipMap | null> {
  if (!guid && !enclosureUrl?.trim()) return null;

  const tryRead = async (key: string): Promise<SkipMap | null> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return parseSkipMapRaw(await AsyncStorage.getItem(key));
      } catch (error) {
        // A transient native-storage read failure must not delete the only saved map.
        // Retry once after startup settles, then leave the entry intact for a later load.
        if (attempt === 0) {
          console.warn('[storage] skip-map read failed; retrying:', error);
          await new Promise((resolve) => setTimeout(resolve, 100));
        } else {
          console.warn('[storage] skip-map read skipped after retry:', error);
        }
      }
    }
    return null;
  };

  if (guid) {
    const byGuid = await tryRead(skipMapGuidKey(guid));
    if (byGuid) {
      console.log(
        `[storage] restored skip-map: ${byGuid.status}, ${byGuid.segments?.length ?? 0} segments`,
      );
      return byGuid;
    }
  }

  const url = enclosureUrl?.trim();
  if (!url) return null;

  const byUrl = await tryRead(skipMapUrlKey(url));
  if (!byUrl) {
    console.log('[storage] no cached skip-map found for episode');
    return null;
  }
  console.log(
    `[storage] restored skip-map by audio URL: ${byUrl.status}, ${byUrl.segments?.length ?? 0} segments`,
  );

  // Migrate / re-index under the GUID we have now so next open hits the primary key.
  if (guid) {
    try {
      await AsyncStorage.setItem(skipMapGuidKey(guid), JSON.stringify(byUrl));
    } catch (error) {
      console.warn('[storage] skip-map GUID re-index skipped:', error);
    }
  }
  return byUrl;
}

export type AudioCacheMetadata = {
  fileName: string;
  episodeGuid: string;
  audioUrl: string;
  cachedAtMs: number;
  audioMd5?: string;
};

function audioCacheMetadataKey(fileName: string): string {
  return KEYS.audioCache + encodeURIComponent(fileName);
}

export async function saveAudioCacheMetadata(metadata: AudioCacheMetadata): Promise<void> {
  await AsyncStorage.setItem(audioCacheMetadataKey(metadata.fileName), JSON.stringify(metadata));
}

export async function getAudioCacheMetadata(
  fileName: string,
): Promise<AudioCacheMetadata | null> {
  try {
    const raw = await AsyncStorage.getItem(audioCacheMetadataKey(fileName));
    if (!raw) return null;
    const metadata = JSON.parse(raw) as AudioCacheMetadata;
    if (
      metadata.fileName !== fileName ||
      !metadata.episodeGuid ||
      !metadata.audioUrl ||
      !Number.isFinite(metadata.cachedAtMs)
    ) {
      return null;
    }
    return metadata;
  } catch (error) {
    console.warn('[storage] audio-cache metadata read skipped:', error);
    return null;
  }
}

export async function getAllAudioCacheMetadata(): Promise<AudioCacheMetadata[]> {
  const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(KEYS.audioCache));
  const entries: AudioCacheMetadata[] = [];
  for (const key of keys) {
    try {
      const raw = await AsyncStorage.getItem(key);
      if (!raw) continue;
      const metadata = JSON.parse(raw) as AudioCacheMetadata;
      if (
        typeof metadata.fileName === 'string' &&
        typeof metadata.episodeGuid === 'string' &&
        typeof metadata.audioUrl === 'string' &&
        Number.isFinite(metadata.cachedAtMs)
      ) {
        entries.push(metadata);
      }
    } catch (error) {
      console.warn('[storage] audio-cache metadata entry skipped:', error);
    }
  }
  return entries;
}

export async function removeAudioCacheMetadata(fileName: string): Promise<void> {
  await AsyncStorage.removeItem(audioCacheMetadataKey(fileName));
}

export async function removeAllAudioCacheMetadata(): Promise<void> {
  const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(KEYS.audioCache));
  if (keys.length) await AsyncStorage.multiRemove(keys);
}

export async function getCachedSkipMaps(): Promise<SkipMap[]> {
  const keys = (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(KEYS.skipMaps));
  const maps = new Map<string, SkipMap>();
  for (const key of keys) {
    try {
      const map = parseSkipMapRaw(await AsyncStorage.getItem(key));
      if (map?.episode_guid) maps.set(map.episode_guid, map);
    } catch (error) {
      console.warn('[storage] skip-map scan skipped:', error);
    }
  }
  return [...maps.values()];
}

export async function removeCachedSkipMap(
  guid: string,
  enclosureUrl?: string | null,
): Promise<void> {
  const keys = new Set<string>();
  if (guid) keys.add(skipMapGuidKey(guid));
  const url = enclosureUrl?.trim();
  if (url) keys.add(skipMapUrlKey(url));
  if (keys.size) await AsyncStorage.multiRemove([...keys]);
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

const DEFAULT_SKIP_SETTINGS: PodcastSkipSettings = {
  skipEnabled: true,
  skipAdvertisement: true,
  skipIntroOutro: true,
  skipSelfPromotion: true,
};

function skipSettingsKey(target: AdDetectionTarget): string | null {
  if (target.collectionId != null && Number.isFinite(target.collectionId)) {
    return `collection:${target.collectionId}`;
  }
  const feedUrl = target.feedUrl?.trim();
  if (feedUrl) return `feed:${feedUrl}`;
  return null;
}

/** Get per-show skip settings (defaults to all enabled). */
export async function getPodcastSkipSettings(target: AdDetectionTarget): Promise<PodcastSkipSettings> {
  const key = skipSettingsKey(target);
  if (!key) return { ...DEFAULT_SKIP_SETTINGS };
  
  try {
    const raw = await AsyncStorage.getItem(KEYS.podcastSkipSettings);
    if (!raw) return { ...DEFAULT_SKIP_SETTINGS };
    const all = JSON.parse(raw) as Record<string, Partial<PodcastSkipSettings>>;
    const stored = all[key];
    if (!stored) return { ...DEFAULT_SKIP_SETTINGS };
    
    // Merge with defaults to handle partial stored settings
    return {
      skipEnabled: stored.skipEnabled ?? DEFAULT_SKIP_SETTINGS.skipEnabled,
      skipAdvertisement: stored.skipAdvertisement ?? DEFAULT_SKIP_SETTINGS.skipAdvertisement,
      skipIntroOutro: stored.skipIntroOutro ?? DEFAULT_SKIP_SETTINGS.skipIntroOutro,
      skipSelfPromotion: stored.skipSelfPromotion ?? DEFAULT_SKIP_SETTINGS.skipSelfPromotion,
    };
  } catch {
    return { ...DEFAULT_SKIP_SETTINGS };
  }
}

/** Set per-show skip settings. */
export async function setPodcastSkipSettings(
  target: AdDetectionTarget,
  settings: Partial<PodcastSkipSettings>,
): Promise<void> {
  const key = skipSettingsKey(target);
  if (!key) return;
  
  try {
    const raw = await AsyncStorage.getItem(KEYS.podcastSkipSettings);
    const all: Record<string, PodcastSkipSettings> = raw ? JSON.parse(raw) : {};
    const current = all[key] || { ...DEFAULT_SKIP_SETTINGS };
    
    all[key] = {
      skipEnabled: settings.skipEnabled ?? current.skipEnabled,
      skipAdvertisement: settings.skipAdvertisement ?? current.skipAdvertisement,
      skipIntroOutro: settings.skipIntroOutro ?? current.skipIntroOutro,
      skipSelfPromotion: settings.skipSelfPromotion ?? current.skipSelfPromotion,
    };
    
    await AsyncStorage.setItem(KEYS.podcastSkipSettings, JSON.stringify(all));
  } catch (error) {
    console.warn('[storage] Failed to save podcast skip settings:', error);
  }
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
    (k) =>
      k.startsWith(KEYS.episodes) ||
      k.startsWith(KEYS.skipMaps) ||
      k.startsWith(KEYS.audioCache),
  );
  if (toRemove.length) await AsyncStorage.multiRemove(toRemove);
  return toRemove.length;
}
