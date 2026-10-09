import type { Episode } from '@/src/types';
import { cacheEpisodes, getCachedEpisodes } from '@/src/db/storage';
import { syncAndroidAutoCatalog } from '@/src/player/androidAutoCatalog';

/** Minimal RSS 2.0 / iTunes enclosure parser (no native XML dep). */


/** Decode XML/HTML entities commonly present in RSS attribute values and text. */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });
}

function textBetween(xml: string, tag: string): string | undefined {
  const cdata = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i');
  const mC = xml.match(cdata);
  if (mC) return decodeXmlEntities(mC[1].trim());
  const plain = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(plain);
  return m ? decodeXmlEntities(m[1].replace(/<[^>]+>/g, '').trim()) : undefined;
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`${name}=["']([^"']+)["']`, 'i'));
  return m?.[1] != null ? decodeXmlEntities(m[1]) : undefined;
}

function parseDurationMs(raw?: string): number | undefined {
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return parseInt(raw, 10) * 1000;
  const parts = raw.split(':').map((p) => parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return undefined;
  if (parts.length === 3) return ((parts[0] * 3600) + (parts[1] * 60) + parts[2]) * 1000;
  if (parts.length === 2) return ((parts[0] * 60) + parts[1]) * 1000;
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
}

/** In-memory XML so scroll-to-load-more can re-parse without re-fetching. */
const xmlByFeed = new Map<string, string>();

export function getCachedRssXml(feedUrl: string): string | undefined {
  return xmlByFeed.get(feedUrl);
}

export function clearCachedRssXml(feedUrl?: string): void {
  if (feedUrl) xmlByFeed.delete(feedUrl);
  else xmlByFeed.clear();
}

/** Walk <item> blocks without building a giant match-all array when limited. */
function* iterateItems(xml: string): Generator<string> {
  const re = /<item\b[\s\S]*?<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    yield m[0];
  }
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

  for (const item of iterateItems(xml)) {
    if (limit != null && episodes.length >= limit) {
      sawMore = true;
      break;
    }
    const enclosureTag = item.match(/<enclosure\b[^>]*\/?>/i)?.[0];
    const enclosureUrl = enclosureTag ? attr(enclosureTag, 'url') : undefined;
    const enclosureType = enclosureTag ? attr(enclosureTag, 'type') : undefined;
    const guid = textBetween(item, 'guid') || enclosureUrl || textBetween(item, 'link');
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
      description: textBetween(item, 'description'),
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
    const existing = xmlByFeed.get(feedUrl);
    if (existing) return existing;
  }
  const res = await fetch(feedUrl);
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
  const xml = await res.text();
  xmlByFeed.set(feedUrl, xml);
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
  const xml = xmlByFeed.get(feedUrl);
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
    opts?.onUpdate?.(parsed);
    return parsed;
  })();
  return { cached, refreshed };
}
