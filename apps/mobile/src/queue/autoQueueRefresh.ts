import { AppState } from 'react-native';
import { fetchAndParseRss } from '@/src/api/rss';
import { getSubscriptions } from '@/src/db/storage';
import { autoQueueShowKey, getAutoQueueShowKeys, processFeedForAutoQueue } from './queueStore';

const MIN_INTERVAL_MS = 30 * 60_000;
const ITEMS = 20;
let lastRunAt = 0;
let running: Promise<void> | null = null;

/**
 * Refresh only subscriptions with "Auto-add new episodes" on, so new releases
 * land in Up Next without opening each show. Throttled; network failures are ignored.
 */
export function refreshAutoQueueFeeds(force = false): Promise<void> {
  if (running) return running;
  if (!force && Date.now() - lastRunAt < MIN_INTERVAL_MS) return Promise.resolve();
  lastRunAt = Date.now();
  running = (async () => {
    try {
      const keys = new Set(await getAutoQueueShowKeys());
      if (!keys.size) return;
      const subs = (await getSubscriptions()).filter((s) => {
        const key = autoQueueShowKey({ collectionId: s.collectionId, feedUrl: s.feedUrl });
        return key != null && keys.has(key);
      });
      for (const sub of subs) {
        try {
          const parsed = await fetchAndParseRss(
            sub.feedUrl,
            { collectionId: sub.collectionId, podcastTitle: sub.collectionName, artworkUrl: sub.artworkUrl },
            { maxItems: ITEMS, forceRefresh: true },
          );
          await processFeedForAutoQueue(
            { collectionId: sub.collectionId, feedUrl: sub.feedUrl },
            parsed.episodes,
          );
        } catch (e) {
          console.warn('[queue] auto-add refresh failed for', sub.feedUrl, e);
        }
      }
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Run once now and whenever the app returns to the foreground. */
export function startAutoQueueRefresh(): () => void {
  void refreshAutoQueueFeeds(true);
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active') void refreshAutoQueueFeeds();
  });
  return () => sub.remove();
}
