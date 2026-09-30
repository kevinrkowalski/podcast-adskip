/** Shared domain types for podcast finder + skip-map. */

export type AdSegmentType =
  | 'sponsor'
  | 'midroll'
  | 'preroll'
  | 'postroll'
  | 'crosspromo'
  | 'network'
  | 'unknown';

export interface AdSegment {
  start_ms: number;
  end_ms: number;
  type: AdSegmentType;
  confidence: number;
}

export type SkipMapStatus = 'ready' | 'pending' | 'missing' | 'error' | 'queued';

/** Pipeline stage from analyze job progress (server). */
export type AnalyzeStage =
  | 'queued'
  | 'downloading'
  | 'transcribing'
  | 'labeling'
  | 'saving'
  | 'ready'
  | 'error';

export interface SkipMap {
  status: SkipMapStatus;
  episode_guid: string;
  segments: AdSegment[];
  model?: string | null;
  analyzed_at?: string | null;
  message?: string | null;
  /** Current pipeline stage when status is pending/queued. */
  stage?: AnalyzeStage | string | null;
  stage_label?: string | null;
  /** Stage-based percent estimate (not a fake smooth 0–100). */
  progress_pct?: number | null;
  /** Estimated seconds remaining (honest, from typical stage durations). */
  eta_seconds?: number | null;
  started_at?: string | null;
}

export interface PodcastSearchResult {
  collectionId: number;
  collectionName: string;
  artistName: string;
  feedUrl?: string;
  artworkUrl100?: string;
  artworkUrl600?: string;
  genres?: string[];
}

export interface Subscription {
  collectionId: number;
  collectionName: string;
  artistName: string;
  feedUrl: string;
  artworkUrl?: string;
  subscribedAt: string;
}

export interface Episode {
  guid: string;
  title: string;
  pubDate?: string;
  duration?: string;
  durationMs?: number;
  enclosureUrl?: string;
  enclosureType?: string;
  description?: string;
  artworkUrl?: string;
  feedUrl: string;
  podcastTitle?: string;
  collectionId?: number;
}

export interface NowPlaying {
  episode: Episode;
  positionMs: number;
  durationMs: number;
  isPlaying: boolean;
  autoSkip: boolean;
  skipMap?: SkipMap | null;
}
