import { getCachedEpisodes, getSubscriptions } from '@/src/db/storage';
import { getCachedAudioPaths } from '@/src/api/audioUpload';
import { setAndroidAutoCatalog } from './androidAuto';

let syncInFlight: Promise<void> | null = null;
let syncAgain = false;

/** Keep the native Android Auto browser tree available without needing JS at browse time. */
export function syncAndroidAutoCatalog(): Promise<void> {
  if (syncInFlight) {
    // Something changed mid-sync (e.g. a download finished): run once more afterwards.
    syncAgain = true;
    return syncInFlight;
  }
  syncInFlight = (async () => {
    try {
      do {
        syncAgain = false;
        const subscriptions = await getSubscriptions();
        const entries = await Promise.all(
          subscriptions.map(async (subscription) => [
            subscription.feedUrl,
            await getCachedEpisodes(subscription.feedUrl),
          ] as const),
        );
        // Downloaded episodes play from the local (analyzed) file, also from the car.
        const localPaths = await getCachedAudioPaths(entries.flatMap(([, episodes]) => episodes));
        const episodesByFeed = Object.fromEntries(
          entries.map(([feedUrl, episodes]) => [
            feedUrl,
            episodes.map((ep) => (localPaths[ep.guid] ? { ...ep, localFilePath: localPaths[ep.guid] } : ep)),
          ]),
        );
        setAndroidAutoCatalog(subscriptions, episodesByFeed);
      } while (syncAgain);
    } catch (error) {
      console.warn('[android-auto] Could not sync local podcast catalog:', error);
    } finally {
      syncInFlight = null;
    }
  })();
  return syncInFlight;
}
