/** Shared domain types for podcast finder + skip-map. */

export type AdSegmentType =
  | 'advertisement'
  | 'intro_outro'
  | 'self_promotion';

/** Legacy segment types that may appear in cached skip maps. */
export type LegacyAdSegmentType =
  | 'sponsor'
  | 'midroll'
  | 'preroll'
  | 'postroll'
  | 'crosspromo'
  | 'network'
  | 'intro_outro'
  | 'unknown';

export interface AdSegment {
  start_ms: number;
  end_ms: number;
  type: AdSegmentType | LegacyAdSegmentType | (string & {});
  confidence: number;
  /** Short transcript excerpt overlapping this detected segment. */
  sample_text?: string | null;
  /** Server: which pass found it ('omni_gap' / 'main+omni_gap' = added by the second pass). */
  source?: string | null;
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
  /** Audio URL that was analyzed (for mismatch detection). */
  audio_url?: string | null;
  /** Size of analyzed audio file in bytes. */
  analyzed_audio_size_bytes?: number | null;
  /** Duration of analyzed audio in milliseconds. */
  analyzed_audio_duration_ms?: number | null;
  /** MD5 content fingerprint used to validate a skip map against cached audio. */
  audio_md5?: string | null;
  /**
   * Server: status is "missing" for the fingerprint we sent (or we sent none), but a
   * ready map exists for different audio bytes (another download of this episode).
   */
  analysis_for_other_audio?: boolean;
  /**
   * Server: this ready map may still gain ad skips from a background second pass; refetch
   * it (same audio_md5) a little later.
   */
  gap_pass_pending?: boolean;
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

/** A chapter marker from the episode's feed. */
export interface Chapter {
  startMs: number;
  title: string;
  /** Link the publisher attached to the chapter. */
  url?: string;
  imageUrl?: string;
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
  podcastDescription?: string;
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
