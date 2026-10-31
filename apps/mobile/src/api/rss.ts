import type { Episode } from '@/src/types';
import { cacheEpisodes, getCachedEpisodes } from '@/src/db/storage';
import { syncAndroidAutoCatalog } from '@/src/player/androidAutoCatalog';
import { processFeedForAutoQueue } from '@/src/queue/queueStore';
import { fetchWithTimeout } from './http';

/** Minimal RSS 2.0 / iTunes enclosure parser (no native XML dep). */

/** Large feeds on slow networks can take a while; still never hang forever. */
const RSS_FETCH_TIMEOUT_MS = 60_000;
/** In-memory XML kept for paging/show notes; feeds can be several MB each. */
const MAX_CACHED_XML_FEEDS = 8;

function codePointOr(code: number, fallback: string): string {
  // String.fromCodePoint throws RangeError outside 0..0x10FFFF (one bad entity would
  // otherwise fail the whole feed).
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}

/** Decode XML/HTML entities commonly present in RSS attribute values and text. */
export function decodeXmlEntities(value: string): string {
  // &amp; last, so "&amp;lt;" decodes once to the literal text "&lt;".
  return value
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (m, n) => codePointOr(Number(n), m))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => codePointOr(parseInt(h, 16), m))
    .replace(/&amp;/gi, '&');
}

export function textBetween(xml: string, tag: string): string | undefined {
  // Use the first <tag> element, then unwrap CDATA inside it (searching for a CDATA
  // variant across the whole string could pick a later, nested element instead).
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!m) return undefined;
  const inner = m[1].trim();
  if (inner.includes('<![CDATA[')) {
    return decodeXmlEntities(inner.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim());
  }
  return decodeXmlEntities(inner.replace(/<[^>]+>/g, '').trim());
}

/** Raw inner text (CDATA unwrapped, entities decoded) with HTML kept for show notes. */
function rawBetween(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!m) return undefined;
  let inner = m[1].trim();
  const c = inner.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (c) return c[1].trim();
  inner = decodeXmlEntities(inner);
  // Double-escaped HTML (&amp;lt;p&amp;gt;) decodes to entities again.
  if (/&lt;\w/.test(inner)) inner = decodeXmlEntities(inner);
  return inner.trim();
}

function visibleLength(html: string): number {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;|\s+/g, ' ').trim().length;
}

/** Richest episode notes: content:encoded > description > itunes:summary > itunes:subtitle. */
export function pickEpisodeNotes(item: string): string | undefined {
  let best: string | undefined;
  let bestLen = 0;
  for (const tag of ['content:encoded', 'description', 'itunes:summary', 'itunes:subtitle']) {
    const v = rawBetween(item, tag);
    const len = v ? visibleLength(v) : 0;
    // Earlier tags win unless a later one has clearly more text (truncated descriptions).
    if (len > 0 && (bestLen === 0 || len > bestLen * 1.5)) {
      best = v;
      bestLen = len;
    }
  }
  return best;
}

export function attr(tag: string, name: string): string | undefined {
  // Match the closing quote of the same kind, so url="…/Don't.mp3" isn't cut short.
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  const value = m ? (m[1] ?? m[2]) : undefined;
  return value ? decodeXmlEntities(value) : undefined;
}

export function parseDurationMs(raw?: string): number | undefined {
  if (!raw) return undefined;
  const text = raw.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(parseFloat(text) * 1000);
  const parts = text.split(':').map((p) => parseFloat(p));
  if (parts.some((n) => !Number.isFinite(n))) return undefined;
  if (parts.length === 3) return Math.round(((parts[0] * 3600) + (parts[1] * 60) + parts[2]) * 1000);
  if (parts.length === 2) return Math.round(((parts[0] * 60) + parts[1]) * 1000);
  return undefined;
}

export interface ParsedFeed {
  title?: string;
  description?: string;
  imageUrl?: string;
  episodes: Episode[];
  /** True when parse stopped early due to maxItems (more items may exist in XML). */
  truncated?: boolean;
}

export interface ParseRssOptions {
  /** Stop after this many items (lazy / first page). Omit for full archive. */
  maxItems?: number;
  /**
   * Take the newest items even when the feed lists oldest first (serial/self-hosted
   * feeds). Otherwise items are taken in file order.
   */
  newestFirst?: boolean;
}

/** In-memory XML so scroll-to-load-more can re-parse without re-fetching. */
const xmlByFeed = new Map<string, string>();

function rememberXml(feedUrl: string, xml: string) {
  xmlByFeed.delete(feedUrl);
  xmlByFeed.set(feedUrl, xml);
  while (xmlByFeed.size > MAX_CACHED_XML_FEEDS) {
    const oldest = xmlByFeed.keys().next().value;
    if (oldest === undefined) break;
    xmlByFeed.delete(oldest);
  }
}

function recallXml(feedUrl: string): string | undefined {
  const xml = xmlByFeed.get(feedUrl);
  if (xml !== undefined) rememberXml(feedUrl, xml); // mark most recently used
  return xml;
}

export function getCachedRssXml(feedUrl: string): string | undefined {
  return recallXml(feedUrl);
}

export function clearCachedRssXml(feedUrl?: string): void {
  if (feedUrl) xmlByFeed.delete(feedUrl);
  else xmlByFeed.clear();
}

/**
 * Walk <item> blocks. Finds each opening tag, then the next closing tag, with two
 * simple searches: a single lazy /<item\b[\s\S]*?<\/item>/ over a multi-MB feed is
 * pathologically slow on Hermes (~50 ms per item on a 10 MB feed, so a full scan of a
 * 1,000-episode archive froze the JS thread for 20+ seconds).
 */
function* itemRanges(xml: string): Generator<[number, number]> {
  const open = /<item\b/gi;
  const close = /<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = open.exec(xml)) !== null) {
    close.lastIndex = open.lastIndex;
    if (close.exec(xml) === null) return;
    yield [m.index, close.lastIndex];
    open.lastIndex = close.lastIndex;
  }
}

function* iterateItems(xml: string): Generator<string> {
  for (const [start, end] of itemRanges(xml)) yield xml.slice(start, end);
}

/** An item's identity, as parseRssXml assigns it to Episode.guid. */
function itemGuid(item: string): string | undefined {
  const enclosureTag = item.match(/<enclosure\b[^>]*\/?>/i)?.[0];
  const enclosureUrl = enclosureTag ? attr(enclosureTag, 'url') : undefined;
  return textBetween(item, 'guid') || enclosureUrl || textBetween(item, 'link');
}

/** Hints for finding an episode whose feed guid changed since it was queued. */
export interface EpisodeMatchHints {
  enclosureUrl?: string;
  title?: string;
}

/** Audio URL without query/fragment (tracking params and signatures change per fetch). */
function enclosureKey(url?: string): string | undefined {
  const base = url?.trim().split(/[?#]/)[0];
  return base ? base.toLowerCase() : undefined;
}

function notesForEpisode(xml: string, guid: string, hints?: EpisodeMatchHints): string | undefined {
  const wantEnclosure = enclosureKey(hints?.enclosureUrl);
  const wantTitle = hints?.title?.trim();
  let byEnclosure: string | undefined;
  let byTitle: string | undefined;
  for (const item of iterateItems(xml)) {
    if (itemGuid(item) === guid) return pickEpisodeNotes(item);
    // Publishers sometimes re-key items (or add a <guid> to an enclosure-keyed feed):
    // fall back to the same audio file, then the same title.
    if (wantEnclosure && byEnclosure === undefined) {
      const tag = item.match(/<enclosure\b[^>]*\/?>/i)?.[0];
      if (tag && enclosureKey(attr(tag, 'url')) === wantEnclosure) byEnclosure = item;
    }
    if (wantTitle && byTitle === undefined && textBetween(item, 'title') === wantTitle) {
      byTitle = item;
    }
  }
  const fallback = byEnclosure ?? byTitle;
  return fallback ? pickEpisodeNotes(fallback) : undefined;
}

/**
 * Show notes for one episode, searched across the whole feed (only the matching item's
 * notes are parsed). Uses the in-memory feed when it has the episode; otherwise fetches
 * the feed, e.g. for an episode newer than the cached copy. Matches by guid, falling back
 * to the audio URL / title in `hints` when the guid is no longer in the feed.
 */
export async function findEpisodeNotes(
  feedUrl: string,
  guid: string,
  hints?: EpisodeMatchHints,
): Promise<string | undefined> {
  const cached = recallXml(feedUrl);
  const fromCache = cached ? notesForEpisode(cached, guid, hints) : undefined;
  if (fromCache?.trim()) return fromCache;
  return notesForEpisode(await fetchRssXml(feedUrl, { force: cached !== undefined }), guid, hints);
}

function extractChannelImage(channelHead: string): string | undefined {
  const itunesTag = channelHead.match(/<itunes:image\b[^>]*\/?>/i)?.[0] ?? '';
  const itunes = attr(itunesTag, 'href');
  if (itunes) return itunes;

  const imageBlock = channelHead.match(/<image\b[^>]*>[\s\S]*?<\/image>/i)?.[0];
  if (imageBlock) {
    const url = textBetween(imageBlock, 'url');
    if (url) return url;
  }

  const mediaTag = channelHead.match(/<media:thumbnail\b[^>]*\/?>/i)?.[0] ?? '';
  const media = attr(mediaTag, 'url');
  if (media) return media;

  return undefined;
}

export function parseRssXml(
  xml: string,
  feedUrl: string,
  meta?: { collectionId?: number; podcastTitle?: string; artworkUrl?: string },
  options?: ParseRssOptions,
): ParsedFeed {
  // Prefer channel header only — avoid /<channel>…<\/channel>/ over multi‑MB archives.
  const channelEnd = xml.search(/<item\b/i);
  const channelHead = channelEnd >= 0 ? xml.slice(0, channelEnd) : xml.slice(0, 80_000);
  const title = textBetween(channelHead, 'title');
  const description =
    textBetween(channelHead, 'description') || textBetween(channelHead, 'itunes:summary');
  const imageUrl = extractChannelImage(channelHead) || meta?.artworkUrl;

  const episodes: Episode[] = [];
  const limit = options?.maxItems;
  let sawMore = false;

  let items: Iterable<string> = iterateItems(xml);
  if (options?.newestFirst) {
    // Positions only: copying every item of a large archive just to compare two dates
    // is wasted work.
    const ranges = [...itemRanges(xml)];
    const dateOf = (range: [number, number] | undefined) => {
      const raw = range ? textBetween(xml.slice(range[0], range[1]), 'pubDate') : undefined;
      const t = raw ? Date.parse(raw) : NaN;
      return Number.isFinite(t) ? t : NaN;
    };
    const first = dateOf(ranges[0]);
    const last = dateOf(ranges[ranges.length - 1]);
    if (Number.isFinite(first) && Number.isFinite(last) && last > first) ranges.reverse();
    items = (function* () {
      for (const [start, end] of ranges) yield xml.slice(start, end);
    })();
  }

  for (const item of items) {
    if (limit != null && episodes.length >= limit) {
      sawMore = true;
      break;
    }
    const enclosureTag = item.match(/<enclosure\b[^>]*\/?>/i)?.[0];
    const enclosureUrl = enclosureTag ? attr(enclosureTag, 'url') : undefined;
    const enclosureType = enclosureTag ? attr(enclosureTag, 'type') : undefined;
    const guid = itemGuid(item);
    if (!guid) continue;
    const duration = textBetween(item, 'itunes:duration');
    episodes.push({
      guid,
      title: textBetween(item, 'title') || 'Untitled',
      pubDate: textBetween(item, 'pubDate'),
      duration,
      durationMs: parseDurationMs(duration),
      enclosureUrl,
      enclosureType,
      description: pickEpisodeNotes(item),
      podcastDescription: description,
      artworkUrl:
        attr(item.match(/<itunes:image[^>]*>/i)?.[0] ?? '', 'href') || imageUrl || meta?.artworkUrl,
      feedUrl,
      podcastTitle: meta?.podcastTitle || title,
      collectionId: meta?.collectionId,
    });
  }

  return { title, description, imageUrl, episodes, truncated: sawMore };
}

export async function fetchRssXml(
  feedUrl: string,
  opts?: { force?: boolean },
): Promise<string> {
  if (!opts?.force) {
    const existing = recallXml(feedUrl);
    if (existing) return existing;
  }
  const xml = await fetchWithTimeout(feedUrl, undefined, RSS_FETCH_TIMEOUT_MS, async (res) => {
    if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
    return res.text();
  });
  rememberXml(feedUrl, xml);
  return xml;
}

/** Fetch RSS and return channel artwork only (no episode parse). */
export async function fetchFeedArtwork(feedUrl: string): Promise<string | undefined> {
  try {
    const xml = await fetchRssXml(feedUrl);
    const channelEnd = xml.search(/<item\b/i);
    const channelHead = channelEnd >= 0 ? xml.slice(0, channelEnd) : xml.slice(0, 80_000);
    const imageUrl = extractChannelImage(channelHead);
    return imageUrl || undefined;
  } catch {
    return undefined;
  }
}


export async function fetchAndParseRss(
  feedUrl: string,
  meta?: { collectionId?: number; podcastTitle?: string; artworkUrl?: string },
  options?: ParseRssOptions & { forceRefresh?: boolean },
): Promise<ParsedFeed> {
  const xml = await fetchRssXml(feedUrl, { force: !!options?.forceRefresh });
  return parseRssXml(xml, feedUrl, meta, options);
}

/** Re-parse a previously fetched feed XML with a higher item limit (no network). */
export function parseMoreFromCachedXml(
  feedUrl: string,
  meta?: { collectionId?: number; podcastTitle?: string; artworkUrl?: string },
  maxItems?: number,
): ParsedFeed | null {
  const xml = recallXml(feedUrl);
  if (!xml) return null;
  return parseRssXml(xml, feedUrl, meta, maxItems != null ? { maxItems } : undefined);
}

/**
 * Return disk cache immediately when present; refresh RSS in the background.
 * Prefer a bounded `maxItems` so open never waits on a full archive parse.
 * `onUpdate` receives the freshly parsed feed; callers should not await `refreshed`
 * on screen open — fire-and-forget and page more from memory/XML on scroll.
 */
export async function loadRssEpisodesCached(
  feedUrl: string,
  meta?: { collectionId?: number; podcastTitle?: string; artworkUrl?: string },
  opts?: {
    maxItems?: number;
    onUpdate?: (parsed: ParsedFeed) => void;
  },
): Promise<{ cached: Episode[]; refreshed: Promise<ParsedFeed> }> {
  const cached = await getCachedEpisodes(feedUrl);
  const refreshed = (async () => {
    const parsed = await fetchAndParseRss(feedUrl, meta, {
      maxItems: opts?.maxItems,
      forceRefresh: true,
    });
    await cacheEpisodes(feedUrl, parsed.episodes);
    void syncAndroidAutoCatalog();
    void processFeedForAutoQueue({ collectionId: meta?.collectionId, feedUrl }, parsed.episodes);
    opts?.onUpdate?.(parsed);
    return parsed;
  })();
  return { cached, refreshed };
}
