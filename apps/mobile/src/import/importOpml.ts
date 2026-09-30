import { lookupPodcastByFeedUrl } from '@/src/api/itunes';
import { fetchFeedArtwork } from '@/src/api/rss';
import { getSubscriptions, subscribe, updateSubscription } from '@/src/db/storage';
import type { Subscription } from '@/src/types';
import { normalizeFeedUrl, parseOpml } from '@/src/import/opml';

export type OpmlImportResult = {
  imported: number;
  skipped: number;
  failed: number;
  total: number;
  /** Existing (or newly saved) subs that got artwork filled in this run. */
  artworkBackfilled: number;
};

function syntheticCollectionId(feedUrl: string, taken: Set<number>): number {
  let hash = 2166136261;
  for (let i = 0; i < feedUrl.length; i++) {
    hash ^= feedUrl.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  let id = hash | 0;
  if (id > 0) id = -id;
  if (id === 0) id = -1;
  while (taken.has(id)) {
    id = id === -2147483648 ? -1 : id - 1;
  }
  return id;
}

/** Prefer Apple artwork; otherwise parse the RSS channel image. */
async function resolveArtworkUrl(
  feedUrl: string,
  appleArtwork?: string,
): Promise<string | undefined> {
  const fromApple = appleArtwork?.trim();
  if (fromApple) return fromApple;
  return fetchFeedArtwork(feedUrl);
}

/**
 * Fill artworkUrl on subscriptions that are missing covers.
 * Does not remove or re-create subscriptions.
 */
export async function backfillMissingArtwork(
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const subs = await getSubscriptions();
  const missing = subs.filter((s) => !s.artworkUrl?.trim() && !!s.feedUrl?.trim());
  const total = missing.length;
  let done = 0;
  let filled = 0;
  onProgress?.(done, total);

  for (const sub of missing) {
    try {
      const art = await fetchFeedArtwork(sub.feedUrl);
      if (art) {
        await updateSubscription(sub.collectionId, { artworkUrl: art });
        filled += 1;
      }
    } catch {
      /* best-effort per feed */
    } finally {
      done += 1;
      onProgress?.(done, total);
    }
  }

  return filled;
}

/**
 * Subscribe each OPML feed through the existing subscribe() helper.
 * Does not remove current subscriptions. Skips duplicates by feed URL or collectionId.
 * Prefer Apple lookup artwork; fall back to RSS channel image. After import, backfill
 * any existing subscriptions that still lack artwork.
 */
export async function importOpmlSubscriptions(
  xml: string,
  onProgress?: (done: number, total: number) => void,
): Promise<OpmlImportResult> {
  const { feeds, missingFeedUrl, duplicates } = parseOpml(xml);
  const existing = await getSubscriptions();
  const ids = new Set(existing.map((sub) => sub.collectionId));
  const urls = new Set(
    existing.map((sub) => normalizeFeedUrl(sub.feedUrl)).filter((url) => url.length > 0),
  );
  let existingCount = existing.length;
  let imported = 0;
  let skipped = missingFeedUrl + duplicates;
  let failed = 0;
  const total = feeds.length + missingFeedUrl + duplicates;
  let done = missingFeedUrl + duplicates;
  onProgress?.(done, total);

  for (const feed of feeds) {
    try {
      const norm = normalizeFeedUrl(feed.xmlUrl);
      if (urls.has(norm)) {
        skipped += 1;
        continue;
      }

      let sub: Subscription | null = null;
      let appleArtwork: string | undefined;
      try {
        const found = await lookupPodcastByFeedUrl(feed.xmlUrl);
        if (found?.collectionId && found.feedUrl) {
          const foundNorm = normalizeFeedUrl(found.feedUrl);
          if (ids.has(found.collectionId) || urls.has(foundNorm)) {
            skipped += 1;
            urls.add(norm);
            urls.add(foundNorm);
            ids.add(found.collectionId);
            continue;
          }
          appleArtwork = found.artworkUrl600 || found.artworkUrl100;
          sub = {
            collectionId: found.collectionId,
            collectionName: found.collectionName || feed.title,
            artistName: found.artistName || '',
            feedUrl: found.feedUrl,
            artworkUrl: appleArtwork,
            subscribedAt: new Date().toISOString(),
          };
        }
      } catch {
        sub = null;
      }

      if (!sub) {
        const collectionId = syntheticCollectionId(norm, ids);
        sub = {
          collectionId,
          collectionName: feed.title || feed.xmlUrl,
          artistName: '',
          feedUrl: feed.xmlUrl,
          subscribedAt: new Date().toISOString(),
        };
      }

      if (!sub.artworkUrl?.trim()) {
        const art = await resolveArtworkUrl(sub.feedUrl, appleArtwork);
        if (art) sub = { ...sub, artworkUrl: art };
      }

      const next = await subscribe(sub);
      if (next.length > existingCount) {
        imported += 1;
        existingCount = next.length;
      } else {
        skipped += 1;
      }
      ids.add(sub.collectionId);
      urls.add(norm);
      urls.add(normalizeFeedUrl(sub.feedUrl));
    } catch {
      failed += 1;
    } finally {
      done += 1;
      onProgress?.(done, total);
    }
  }

  // One-shot: cover already-imported shows that still lack artwork (no wipe / re-import).
  const artworkBackfilled = await backfillMissingArtwork();

  return { imported, skipped, failed, total, artworkBackfilled };
}
