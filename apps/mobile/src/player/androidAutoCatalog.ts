import { getCachedEpisodes, getSubscriptions } from '@/src/db/storage';
import { setAndroidAutoCatalog } from './androidAuto';

let syncInFlight: Promise<void> | null = null;

/** Keep the native Android Auto browser tree available without needing JS at browse time. */
export function syncAndroidAutoCatalog(): Promise<void> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    try {
      const subscriptions = await getSubscriptions();
      const entries = await Promise.all(
        subscriptions.map(async (subscription) => [
          subscription.feedUrl,
          await getCachedEpisodes(subscription.feedUrl),
        ] as const),
      );
      setAndroidAutoCatalog(subscriptions, Object.fromEntries(entries));
    } catch (error) {
      console.warn('[android-auto] Could not sync local podcast catalog:', error);
    } finally {
      syncInFlight = null;
    }
  })();
  return syncInFlight;
}
