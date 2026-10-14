import { lookupPodcastByFeedUrl } from '@/src/api/itunes';
import { fetchFeedArtwork, fetchRssXml, parseRssXml } from '@/src/api/rss';
import { getSubscriptions, subscribe, updateSubscription } from '@/src/db/storage';
import type { Subscription } from '@/src/types';
import { normalizeFeedUrl, parseOpml } from '@/src/import/opml';
import { syncAndroidAutoCatalog } from '@/src/player/androidAutoCatalog';

export type OpmlImportResult = {
  imported: number;
  skipped: number;
  failed: number;
  total: number;
  /** Existing (or newly saved) subs that got artwork filled in this run. */
  artworkBackfilled: number;
};

export function syntheticCollectionId(feedUrl: string, taken: Set<number>): number {
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
  await syncAndroidAutoCatalog();

  return { imported, skipped, failed, total, artworkBackfilled };
}

export type FeedUrlSubscribeResult = {
  status: 'added' | 'already';
  collectionId: number;
  title: string;
};

/** Accepts "example.com/feed", "feed://…", "itpc://…", "podcast://…"; returns an http(s) URL or null. */
export function cleanFeedUrlInput(input: string): string | null {
  let raw = input.trim();
  if (!raw) return null;
  raw = raw.replace(/^(feed|itpc|pcast|podcast):\/\//i, 'https://');
  raw = raw.replace(/^feed:/i, '');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Subscribe to a single podcast by RSS feed URL. Fetches + parses the feed with the
 * app's RSS parser to validate it, dedupes against existing subscriptions, prefers the
 * Apple Podcasts entry (real collectionId + artwork) and otherwise stores a synthetic id
 * the same way OPML import does.
 */
export async function subscribeByFeedUrl(input: string): Promise<FeedUrlSubscribeResult> {
  const feedUrl = cleanFeedUrlInput(input);
  if (!feedUrl) throw new Error('Enter a valid http(s) feed URL.');
  const norm = normalizeFeedUrl(feedUrl);

  const existing = await getSubscriptions();
  const dupe = existing.find((s) => normalizeFeedUrl(s.feedUrl) === norm);
  if (dupe) return { status: 'already', collectionId: dupe.collectionId, title: dupe.collectionName };

  let xml: string;
  try {
    xml = await fetchRssXml(feedUrl, { force: true });
  } catch (e) {
    throw new Error(
      e instanceof Error && /RSS fetch failed/.test(e.message)
        ? `Couldn't load that feed (${e.message.replace('RSS fetch failed: ', 'HTTP ')}).`
        : "Couldn't reach that URL. Check the address and your connection.",
    );
  }
  if (!/<(rss|channel)\b/i.test(xml)) {
    throw new Error("That URL doesn't look like a podcast RSS feed.");
  }
  const parsed = parseRssXml(xml, feedUrl, undefined, { maxItems: 5 });
  if (!parsed.title && parsed.episodes.length === 0) {
    throw new Error('That feed has no title or episodes.');
  }
  const head = xml.slice(0, Math.max(0, xml.search(/<item\b/i)) || 80_000);
  const author = head.match(/<itunes:author>([\s\S]*?)<\/itunes:author>/i)?.[1]
    ?.replace(/<!\[CDATA\[|\]\]>/g, '')
    .trim();

  const ids = new Set(existing.map((s) => s.collectionId));
  let sub: Subscription | null = null;
  try {
    const found = await lookupPodcastByFeedUrl(feedUrl);
    if (found?.collectionId && found.feedUrl) {
      const prior = existing.find(
        (s) =>
          s.collectionId === found.collectionId ||
          normalizeFeedUrl(s.feedUrl) === normalizeFeedUrl(found.feedUrl!),
      );
      if (prior) {
        return { status: 'already', collectionId: prior.collectionId, title: prior.collectionName };
      }
      sub = {
        collectionId: found.collectionId,
        collectionName: found.collectionName || parsed.title || feedUrl,
        artistName: found.artistName || author || '',
        feedUrl: found.feedUrl,
        artworkUrl: found.artworkUrl600 || found.artworkUrl100 || parsed.imageUrl,
        subscribedAt: new Date().toISOString(),
      };
    }
  } catch {
    sub = null;
  }
  if (!sub) {
    sub = {
      collectionId: syntheticCollectionId(norm, ids),
      collectionName: parsed.title || feedUrl,
      artistName: author || '',
      feedUrl,
      artworkUrl: parsed.imageUrl,
      subscribedAt: new Date().toISOString(),
    };
  }
  await subscribe(sub);
  await syncAndroidAutoCatalog();
  return { status: 'added', collectionId: sub.collectionId, title: sub.collectionName };
}
