import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchAndParseRss } from '@/src/api/rss';
import { getSubscriptions } from '@/src/db/storage';
import { autoQueueShowKey, getAutoQueueShowKeys, processFeedForAutoQueue } from './queueStore';

const MIN_INTERVAL_MS = 30 * 60_000;
const ITEMS = 20;
const LAST_REFRESH_KEY = '@podcast-adskip/autoQueueLastRefresh';
let lastRunAt = 0;
let running: Promise<RefreshResult> | null = null;

export type RefreshResult = {
  at: number;
  source: 'foreground' | 'background';
  shows: number;
  added: number;
  failed: number;
};

/** True while a refresh is in flight (a new call would join it). */
export function isAutoQueueRefreshRunning(): boolean {
  return running != null;
}

export async function getLastAutoQueueRefresh(): Promise<RefreshResult | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_REFRESH_KEY);
    return raw ? (JSON.parse(raw) as RefreshResult) : null;
  } catch {
    return null;
  }
}

/**
 * Refresh only subscriptions with "Auto-add new episodes" on, so new releases
 * land in Up Next without opening each show. Never plays or analyzes anything.
 * Throttled in the foreground; network failures are counted, not thrown.
 */
export function refreshAutoQueueFeeds(
  force = false,
  source: RefreshResult['source'] = 'foreground',
): Promise<RefreshResult | null> {
  if (running) return running;
  if (!force && Date.now() - lastRunAt < MIN_INTERVAL_MS) return Promise.resolve(null);
  lastRunAt = Date.now();
  running = (async (): Promise<RefreshResult> => {
    const result: RefreshResult = { at: Date.now(), source, shows: 0, added: 0, failed: 0 };
    try {
      let keys: Set<string>;
      try {
        keys = new Set(await getAutoQueueShowKeys());
      } catch (e) {
        console.warn('[queue] could not read auto-add settings:', e);
        result.failed += 1;
        return result;
      }
      if (keys.size) {
        const subs = (await getSubscriptions()).filter((s) => {
          const key = autoQueueShowKey({ collectionId: s.collectionId, feedUrl: s.feedUrl });
          return key != null && keys.has(key);
        });
        for (const sub of subs) {
          // Hand the JS thread back between feeds so queued taps run promptly.
          if (result.shows > 0) await new Promise((r) => setTimeout(r, 0));
          result.shows += 1;
          try {
            const parsed = await fetchAndParseRss(
              sub.feedUrl,
              { collectionId: sub.collectionId, podcastTitle: sub.collectionName, artworkUrl: sub.artworkUrl },
              // newestFirst: oldest-first feeds would otherwise only ever show old items.
              { maxItems: ITEMS, forceRefresh: true, newestFirst: true },
            );
            result.added += await processFeedForAutoQueue(
              { collectionId: sub.collectionId, feedUrl: sub.feedUrl },
              parsed.episodes,
            );
          } catch (e) {
            result.failed += 1;
            console.warn('[queue] auto-add refresh failed for', sub.feedUrl, e);
          }
        }
      }
      result.at = Date.now();
      await AsyncStorage.setItem(LAST_REFRESH_KEY, JSON.stringify(result)).catch(() => {});
      return result;
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Lets the first screens render and respond before the open-time refresh starts. */
export const STARTUP_REFRESH_DELAY_MS = 2_000;

/** Run shortly after launch and whenever the app returns to the foreground. */
export function startAutoQueueRefresh(startupDelayMs = STARTUP_REFRESH_DELAY_MS): () => void {
  const timer = setTimeout(() => {
    void refreshAutoQueueFeeds(true);
  }, startupDelayMs);
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active') void refreshAutoQueueFeeds();
  });
  return () => {
    clearTimeout(timer);
    sub.remove();
  };
}
