import type { Episode, PodcastSearchResult } from '@/src/types';

const ITUNES_SEARCH = 'https://itunes.apple.com/search';
const ITUNES_LOOKUP = 'https://itunes.apple.com/lookup';

interface ItunesPodcastResult {
  collectionId: number;
  collectionName: string;
  artistName: string;
  feedUrl?: string;
  artworkUrl100?: string;
  artworkUrl600?: string;
  genres?: string[];
  wrapperType?: string;
  kind?: string;
}

interface ItunesEpisodeResult {
  wrapperType?: string;
  kind?: string;
  trackId?: number;
  trackName?: string;
  episodeUrl?: string;
  episodeGuid?: string;
  releaseDate?: string;
  trackTimeMillis?: number;
  description?: string;
  artworkUrl600?: string;
  artworkUrl160?: string;
  artworkUrl60?: string;
  collectionId?: number;
  collectionName?: string;
  feedUrl?: string;
}

function mapPodcast(r: ItunesPodcastResult): PodcastSearchResult {
  return {
    collectionId: r.collectionId,
    collectionName: r.collectionName,
    artistName: r.artistName,
    feedUrl: r.feedUrl,
    artworkUrl100: r.artworkUrl100,
    artworkUrl600: r.artworkUrl600,
    genres: r.genres,
  };
}

function formatDuration(ms?: number): string | undefined {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return undefined;
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function mapEpisode(
  r: ItunesEpisodeResult,
  meta: { collectionId: number; podcastTitle?: string; feedUrl: string; artworkUrl?: string },
): Episode | null {
  const enclosureUrl = r.episodeUrl;
  const guid = r.episodeGuid || (r.trackId != null ? `itunes:${r.trackId}` : enclosureUrl);
  if (!guid || !r.trackName) return null;
  return {
    guid,
    title: r.trackName,
    pubDate: r.releaseDate,
    duration: formatDuration(r.trackTimeMillis),
    durationMs: r.trackTimeMillis,
    enclosureUrl,
    enclosureType: enclosureUrl ? 'audio/mpeg' : undefined,
    description: r.description,
    artworkUrl: r.artworkUrl600 || r.artworkUrl160 || r.artworkUrl60 || meta.artworkUrl,
    feedUrl: meta.feedUrl,
    podcastTitle: meta.podcastTitle || r.collectionName,
    collectionId: meta.collectionId,
  };
}

export async function searchPodcasts(term: string, limit = 25): Promise<PodcastSearchResult[]> {
  const q = term.trim();
  if (!q) return [];
  const url = `${ITUNES_SEARCH}?term=${encodeURIComponent(q)}&media=podcast&entity=podcast&country=us&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`iTunes search failed: ${res.status}`);
  const data = (await res.json()) as { results?: ItunesPodcastResult[] };
  return (data.results ?? [])
    .filter((r) => r.collectionId && r.feedUrl)
    .map(mapPodcast);
}

export async function lookupPodcast(collectionId: number): Promise<PodcastSearchResult | null> {
  const url = `${ITUNES_LOOKUP}?id=${collectionId}&entity=podcast`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`iTunes lookup failed: ${res.status}`);
  const data = (await res.json()) as { results?: ItunesPodcastResult[] };
  const show = (data.results ?? []).find((r) => r.feedUrl);
  if (!show) return null;
  return mapPodcast(show);
}

/** Resolve a podcast from its RSS feed URL (Apple lookup ?url=). */
export async function lookupPodcastByFeedUrl(feedUrl: string): Promise<PodcastSearchResult | null> {
  const q = feedUrl.trim();
  if (!q) return null;
  const url = `${ITUNES_LOOKUP}?url=${encodeURIComponent(q)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`iTunes lookup failed: ${res.status}`);
  const data = (await res.json()) as { results?: ItunesPodcastResult[] };
  const show = (data.results ?? []).find((r) => r.collectionId && r.feedUrl);
  if (!show) return null;
  return mapPodcast(show);
}

/** Podcast metadata + recent episodes from iTunes (fast path; not full archive). */
export async function lookupPodcastWithEpisodes(
  collectionId: number,
  episodeLimit = 50,
): Promise<{ podcast: PodcastSearchResult | null; episodes: Episode[] }> {
  const url = `${ITUNES_LOOKUP}?id=${collectionId}&entity=podcastEpisode&limit=${episodeLimit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`iTunes lookup failed: ${res.status}`);
  const data = (await res.json()) as { results?: Array<ItunesPodcastResult & ItunesEpisodeResult> };
  const results = data.results ?? [];

  const showRow = results.find(
    (r) =>
      r.feedUrl &&
      (r.wrapperType === 'track' || r.kind === 'podcast' || (!r.episodeUrl && r.collectionName)),
  );
  const podcast = showRow
    ? mapPodcast(showRow as ItunesPodcastResult)
    : null;

  if (!podcast?.feedUrl) {
    // Fallback: podcast-only lookup if episode entity omitted the show row
    const alone = await lookupPodcast(collectionId);
    return { podcast: alone, episodes: [] };
  }

  const artwork = podcast.artworkUrl600 || podcast.artworkUrl100;
  const episodes: Episode[] = [];
  for (const r of results) {
    if (r.kind !== 'podcast-episode' && r.wrapperType !== 'podcastEpisode') continue;
    const ep = mapEpisode(r, {
      collectionId: podcast.collectionId,
      podcastTitle: podcast.collectionName,
      feedUrl: podcast.feedUrl!,
      artworkUrl: artwork,
    });
    if (ep) episodes.push(ep);
  }

  return { podcast, episodes };
}


/** Apple Podcasts genre IDs for US charts (RSS toppodcasts). */
export const PODCAST_CHART_GENRES: ReadonlyArray<{ id: number | null; label: string }> = [
  { id: null, label: 'Top Overall' },
  { id: 1489, label: 'News' },
  { id: 1303, label: 'Comedy' },
  { id: 1318, label: 'Technology' },
  { id: 1488, label: 'True Crime' },
  { id: 1545, label: 'Sports' },
  { id: 1321, label: 'Business' },
  { id: 1324, label: 'Society & Culture' },
  { id: 1512, label: 'Health & Fitness' },
  { id: 1301, label: 'Arts' },
  { id: 1304, label: 'Education' },
  { id: 1487, label: 'History' },
  { id: 1533, label: 'Science' },
  { id: 1309, label: 'TV & Film' },
  { id: 1310, label: 'Music' },
];

interface ItunesRssLabel {
  label: string;
}

interface ItunesRssImage {
  label: string;
  attributes?: { height?: string };
}

interface ItunesRssEntry {
  'im:name'?: ItunesRssLabel;
  'im:artist'?: ItunesRssLabel;
  'im:image'?: ItunesRssImage[];
  id?: { label?: string; attributes?: { 'im:id'?: string } };
  category?: { attributes?: { label?: string; term?: string } };
  summary?: ItunesRssLabel;
}

interface ItunesRssFeed {
  feed?: { entry?: ItunesRssEntry | ItunesRssEntry[] };
}

function upgradeArtworkUrl(url: string, size = 600): string {
  return url.replace(/\/\d+x\d+bb(\.[a-z]+)?$/i, `/${size}x${size}bb$1`);
}

function mapRssEntry(entry: ItunesRssEntry): PodcastSearchResult | null {
  const idStr = entry.id?.attributes?.['im:id'];
  const collectionId = idStr ? Number(idStr) : NaN;
  const collectionName = entry['im:name']?.label;
  if (!Number.isFinite(collectionId) || !collectionName) return null;

  const images = entry['im:image'] ?? [];
  const sorted = [...images].sort(
    (a, b) => Number(a.attributes?.height ?? 0) - Number(b.attributes?.height ?? 0),
  );
  const best = sorted[sorted.length - 1]?.label;
  const small = sorted[0]?.label ?? best;

  const genreLabel = entry.category?.attributes?.label || entry.category?.attributes?.term;

  return {
    collectionId,
    collectionName,
    artistName: entry['im:artist']?.label ?? '',
    // Charts RSS has no feedUrl — podcast detail looks it up by collectionId.
    artworkUrl100: small,
    artworkUrl600: best ? upgradeArtworkUrl(best, 600) : undefined,
    genres: genreLabel ? [genreLabel] : undefined,
  };
}

/**
 * Apple public top-podcasts chart (US). Pass genreId for a genre chart;
 * omit / null for overall Top Podcasts.
 */
export async function fetchTopPodcasts(
  genreId: number | null = null,
  limit = 25,
): Promise<PodcastSearchResult[]> {
  const capped = Math.min(Math.max(1, limit), 200);
  const genreSeg = genreId != null ? `/genre=${genreId}` : '';
  const url = `https://itunes.apple.com/us/rss/toppodcasts/limit=${capped}${genreSeg}/json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Apple charts failed: ${res.status}`);
  const data = (await res.json()) as ItunesRssFeed;
  const raw = data.feed?.entry;
  const entries = !raw ? [] : Array.isArray(raw) ? raw : [raw];
  return entries.map(mapRssEntry).filter((r): r is PodcastSearchResult => r != null);
}
