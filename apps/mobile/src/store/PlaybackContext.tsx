import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { AdSegment, Episode, SkipMap } from '@/src/types';
import * as player from '@/src/player/trackPlayer';
import { resolveAdDetectionEnabled } from '../player/autoSkipGate';
import { syncAndroidAutoCatalog } from '@/src/player/androidAutoCatalog';
import { getSkipMap, hydrateApiBaseUrl, hydrateAppKey, resolveAudioUrl } from '@/src/api/backend';
import { findEpisodeNotes } from '@/src/api/rss';
import {
  cacheSkipMap,
  getAutoSkipEnabled,
  getCachedSkipMap,
  getPlaybackPosition,
  clearPlaybackPosition,
  savePlaybackPosition,
  setAutoSkipEnabled,
  isPodcastAdDetectionEnabled,
  setPodcastAdDetectionEnabled,
  getPodcastSkipSettings,
  setPodcastSkipSettings,
  type AdDetectionTarget,
  type PodcastSkipSettings,
} from '@/src/db/storage';
import { detectAudioMismatch, formatMismatchSummary } from '@/src/player/audioValidation';
import {
  abandonStreamCacheDownloads,
  beginStreamCacheDownload,
  completeStreamCacheDownload,
  failStreamCacheDownload,
  isAudioDownloadInFlight,
  isRedirectError,
  prepareStreamCachePath,
  downloadAudioForAnalysis,
  uploadAudioForAnalysis,
  getCachedAudioMd5,
  getCachedAudioPath,
  type DownloadProgress,
  type UploadProgress,
} from '@/src/api/audioUpload';
import { getApiBaseUrl, getResolvedAppKey } from '@/src/api/backend';
import {
  hydrateQueue,
  markPlaying,
  popNext,
} from '@/src/queue/queueStore';
import { startAutoQueueRefresh } from '@/src/queue/autoQueueRefresh';
import { syncBackgroundRefreshRegistration } from '@/src/queue/backgroundRefresh';
import { hydratePlayed, isNearEnd, isPlayed, setPlayed } from '@/src/played/playedStore';
import { startFeedbackOutbox } from '@/src/api/feedback';
import { filterSkippableSegments, normalizeSegment } from '@/src/player/skipLogic';
import {
  decidePlaybackSource,
  downloadFailureMessage,
  needsReanalysisForLocalFile,
  serverHasAnalysis,
} from '@/src/player/playbackSource';
import { getQueue } from '@/src/queue/queueStore';
import {
  shouldPlayWhileDownloading,
  streamCacheFailureMessage,
  streamCacheOutcome,
  streamCacheProgressPct,
} from '@/src/player/streamCache';

/**
 * Download state for the current episode when ad skipping applies but it had no
 * downloaded copy. Skips only ever apply to the exact bytes that were analyzed
 * (dynamically inserted ads differ per fetch, so a stream's times wouldn't line up).
 *
 * - 'caching': playing while the player saves those same bytes (Android); skips turn on
 *   once the file is complete and its fingerprint has a matching analysis.
 * - 'cache-error': that save failed; playback continues without skips.
 * - 'downloading' / 'error': download-first fallback (no native player, or a regular
 *   download of the episode was already running); nothing plays until it's ready.
 */
export type PlaybackDownload = {
  guid: string;
  state: 'downloading' | 'error' | 'caching' | 'cache-error';
  /** 0-100 while downloading, null when the size is unknown. */
  progressPct: number | null;
  message?: string;
};

export type PlayEpisodeOptions = {
  /** User chose "Play without ad skipping" after a failed download: stream, no skips. */
  allowStream?: boolean;
  /** Start here instead of the saved position (e.g. where the native player already is). */
  resumePositionMs?: number;
  /** Stream/save this URL instead of the enclosure (resolved past a redirect loop). */
  streamUrl?: string;
};

/** Don't hold up streaming an episode with detection off for longer than this. */
const PREPARED_CHECK_TIMEOUT_MS = 5_000;

type Ctx = {
  episode: Episode | null;
  isPlaying: boolean;
  positionMs: number;
  durationMs: number;
  playbackRate: number;
  autoSkip: boolean;
  adDetectionEnabled: boolean;
  skipMap: SkipMap | null;
  skipSettings: PodcastSkipSettings | null;
  analyzeStatus: string | null;
  analyzeError: string | null;
  audioMismatchWarning: string | null;
  uploadProgress: { downloaded: number; uploaded: number; total: number } | null;
  playEpisode: (ep: Episode, opts?: PlayEpisodeOptions) => Promise<void>;
  /** Non-null while the current episode is downloading before play, or that failed. */
  playbackDownload: PlaybackDownload | null;
  /** Try the download-before-play again for the current episode. */
  retryPlaybackDownload: () => Promise<void>;
  /** After a failed download: stream the current episode with ad skipping off. */
  streamWithoutSkipping: () => Promise<void>;
  /**
   * Episode opened on the player screen but not started yet (different from the
   * loaded `episode`). Nothing is loaded/played/analyzed until startOpenedEpisode.
   */
  openedEpisode: OpenedEpisode | null;
  /** Show `ep` on the player screen without loading audio or starting analysis. */
  openEpisode: (ep: Episode) => void;
  /** First Play on the opened episode: switch playback to it (runs auto-analyze rules). */
  startOpenedEpisode: () => Promise<void>;
  /** Move the opened (not started) episode's resume position. */
  seekOpenedEpisode: (ms: number) => Promise<void>;
  /** Drop the opened-but-not-started episode (player screen closed). */
  closeOpenedEpisode: () => void;
  restoreCurrentSkipMap: () => Promise<SkipMap | null>;
  togglePlay: () => Promise<void>;
  seek: (ms: number) => Promise<void>;
  cyclePlaybackRate: () => void;
  setAutoSkip: (v: boolean) => Promise<void>;
  setPodcastAdDetection: (target: AdDetectionTarget, enabled: boolean) => Promise<void>;
  setPodcastSkipSetting: (target: AdDetectionTarget, settings: Partial<PodcastSkipSettings>) => Promise<void>;
  /** Resolves with the analysis result (null if it didn't run or failed). */
  requestAnalyze: (force?: boolean) => Promise<SkipMap | null>;
  /**
   * Prepare the opened (unstarted) episode: download and analyze it without loading or
   * playing it. Progress and the finished map show on that episode.
   */
  prepareOpenedEpisode: (force?: boolean) => Promise<void>;
  clearCachedPlaybackData: () => boolean;
  /** Mark played (resets resume position) or unplayed (clears played + position). */
  setEpisodePlayed: (ep: Episode, played: boolean) => Promise<void>;
};

export type OpenedEpisode = {
  episode: Episode;
  positionMs: number;
  durationMs: number;
  /**
   * A ready map already prepared for this episode's downloaded copy, looked up read-only
   * so the player shows its segments before Play (null until found, or if there's none).
   */
  skipMap?: SkipMap | null;
  /** Prepare progress for this unstarted episode (prepareOpenedEpisode). */
  analyzeStatus?: string | null;
  analyzeError?: string | null;
  uploadProgress?: AnalyzeUploadProgress | null;
};

type AnalyzeUploadProgress = { downloaded: number; uploaded: number; total: number };

/** Progress of one analysis, reported to whoever started it (e.g. an unstarted episode). */
type AnalyzeObserver = (patch: {
  analyzeStatus?: string | null;
  analyzeError?: string | null;
  uploadProgress?: AnalyzeUploadProgress | null;
}) => void;

const PlaybackContext = createContext<Ctx | null>(null);

/** Persist at most this often while playing. */
const POSITION_SAVE_INTERVAL_MS = 5_000;

/** Poll skip-map while analyze is queued/pending (ETA UI). */
const ANALYZE_POLL_INTERVAL_MS = 2_000;
const ANALYZE_POLL_MAX_MS = 10 * 60_000;

export function PlaybackProvider({ children }: { children: React.ReactNode }) {
  const [episode, setEpisode] = useState<Episode | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [playbackRate, setPlaybackRateState] = useState(1);
  const [autoSkip, setAutoSkipState] = useState(true);
  const [adDetectionEnabled, setAdDetectionEnabledState] = useState(true);
  const [skipMap, setSkipMap] = useState<SkipMap | null>(null);
  const [skipSettings, setSkipSettingsState] = useState<PodcastSkipSettings | null>(null);
  const [analyzeStatus, setAnalyzeStatus] = useState<string | null>(null);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [audioMismatchWarning, setAudioMismatchWarning] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{
    downloaded: number;
    uploaded: number;
    total: number;
  } | null>(null);

  const [playbackDownload, setPlaybackDownloadState] = useState<PlaybackDownload | null>(null);
  const playbackDownloadRef = useRef<PlaybackDownload | null>(null);
  const setPlaybackDownload = useCallback((next: PlaybackDownload | null) => {
    playbackDownloadRef.current = next;
    setPlaybackDownloadState(next);
  }, []);
  /** Bumped by every playEpisode; a finished download for an older call is not played. */
  const playGenRef = useRef(0);
  /** The current episode is waiting on (or failed) its download-before-play. */
  const isAwaitingDownload = useCallback(
    () =>
      playbackDownloadRef.current != null &&
      (playbackDownloadRef.current.state === 'downloading' ||
        playbackDownloadRef.current.state === 'error') &&
      playbackDownloadRef.current.guid === episodeRef.current?.guid,
    [],
  );
  /** Plays retried with the API-resolved URL after a redirect loop (once per episode). */
  const resolvedStreamRetryRef = useRef<string | null>(null);
  const [openedEpisode, setOpenedEpisode] = useState<OpenedEpisode | null>(null);
  const openedEpisodeRef = useRef<OpenedEpisode | null>(null);
  const episodeRef = useRef<Episode | null>(null);
  const positionRef = useRef(0);
  const durationRef = useRef(0);
  const isPlayingRef = useRef(false);
  const lastSavedAt = useRef(0);
  const lastSavedPos = useRef(-1);
  const clearedPositionGuid = useRef<string | null>(null);
  /** Mirrors skipMap so setAutoSkip can restore without a stale closure. */
  const skipMapRef = useRef<SkipMap | null>(null);
  /** Bumped on auto-skip toggle to invalidate in-flight loadSkipMap work. */
  const skipLoadGen = useRef(0);
  /**
   * Guid whose requestAnalyze (Prepare) is in flight; prevents loadSkipMap/clearAdDetection
   * from clobbering that episode's progress. Other episodes are unaffected.
   */
  const manualPrepareGuidRef = useRef<string | null>(null);
  const isPrepareInFlightForCurrent = useCallback(
    () =>
      manualPrepareGuidRef.current != null &&
      manualPrepareGuidRef.current === episodeRef.current?.guid,
    [],
  );
  /**
   * Set while playEpisode switches to a new episode, until the player reports it. Player
   * updates for the previous episode in that window must not be treated as an episode
   * change (they would save its position under the new guid and flip the UI back).
   */
  const switchingToGuidRef = useRef<string | null>(null);
  const manualReanalysisGuidRef = useRef<string | null>(null);
  const analyzeFingerprintRef = useRef<{ episodeGuid: string; audioMd5: string } | null>(null);
  const requestAnalyzeForEpisodeRef = useRef<((target: Episode) => Promise<SkipMap | null>) | null>(null);
  const playEpisodeRef = useRef<((target: Episode, opts?: PlayEpisodeOptions) => Promise<void>) | null>(null);
  const resolvePlaybackSourceRef = useRef<
    (ep: Episode, autoSkipOn: boolean, detectionEnabled: boolean) => Promise<{
      source: 'local' | 'download' | 'stream';
      localFilePath: string | null;
    }>
  >(async () => ({ source: 'stream', localFilePath: null }));
  const externalEpisodeChangeRef = useRef<((target: Episode) => void) | null>(null);

  const persistPosition = useCallback(async (force = false) => {
    const ep = episodeRef.current;
    if (!ep?.guid || clearedPositionGuid.current === ep.guid) return;
    // Mid-switch, positionRef still holds the previous episode's position.
    if (switchingToGuidRef.current) return;
    const pos = positionRef.current;
    const dur = durationRef.current;
    const now = Date.now();
    if (
      !force &&
      now - lastSavedAt.current < POSITION_SAVE_INTERVAL_MS &&
      Math.abs(pos - lastSavedPos.current) < 2_000
    ) {
      return;
    }
    lastSavedAt.current = now;
    lastSavedPos.current = pos;
    await savePlaybackPosition(ep.guid, pos, dur || undefined);
  }, []);

  // Hydrate Ad-skip on/off preference into React + player module.
  // Segment sheet state is intentionally not persisted — only the boolean.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const v = await getAutoSkipEnabled();
      if (cancelled) return;
      setAutoSkipState(v);
      player.setAutoSkip(v);
      if (!v) {
        setAdDetectionEnabledState(false);
        player.setAdDetectionEnabled(false);
        // Keep any in-memory skip map / segments (toggle-off must not destroy them).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    player.initializePlayerBackend();
    void syncAndroidAutoCatalog();
    return player.subscribePlayer((st) => {
      const switchingTo = switchingToGuidRef.current;
      if (switchingTo) {
        // Still reporting the previous episode: ignore until loadAndPlay takes over.
        if (st.episode?.guid !== switchingTo) return;
        switchingToGuidRef.current = null;
      }
      const previousGuid = episodeRef.current?.guid;
      const previousPositionMs = positionRef.current;
      const previousDurationMs = durationRef.current;
      const nextGuid = st.episode?.guid;
      // Started outside JS (e.g. Android Auto): keep it at the top of Up Next too.
      if (st.episode && nextGuid && nextGuid !== previousGuid) void markPlaying(st.episode);
      if (
        previousGuid &&
        nextGuid &&
        previousGuid !== nextGuid &&
        clearedPositionGuid.current !== previousGuid
      ) {
        void savePlaybackPosition(
          previousGuid,
          previousPositionMs,
          previousDurationMs || undefined,
        ).catch((error) => {
          console.warn('[playback] Failed to persist previous episode position:', error);
        });
      }
      if (previousGuid !== nextGuid) clearedPositionGuid.current = null;
      episodeRef.current = st.episode;
      positionRef.current = st.positionMs;
      durationRef.current = st.durationMs;
      isPlayingRef.current = st.isPlaying;
      setEpisode(st.episode);
      setIsPlaying(st.isPlaying);
      setPositionMs(st.positionMs);
      setDurationMs(st.durationMs);
      setPlaybackRateState(st.playbackRate);
      if (previousGuid && nextGuid && previousGuid !== nextGuid) {
        externalEpisodeChangeRef.current?.(st.episode!);
      }

      // Auto-mark played near the end (finish is handled by subscribeEnded too).
      if (st.episode?.guid && isNearEnd(st.positionMs, st.durationMs) && !isPlayed(st.episode.guid)) {
        void setPlayed(st.episode.guid, true);
      }

      // Interval persist while playing.
      if (st.isPlaying && st.episode?.guid) {
        void persistPosition(false);
      }
    });
  }, [persistPosition]);

  // Flush on background-ish unmount.
  useEffect(() => {
    return () => {
      void persistPosition(true);
    };
  }, [persistPosition]);

  const clearCachedPlaybackData = useCallback((): boolean => {
    if (isPrepareInFlightForCurrent()) return false;

    skipLoadGen.current += 1;
    const guid = episodeRef.current?.guid;
    clearedPositionGuid.current = guid ?? null;
    if (guid) void clearPlaybackPosition(guid);
    setSkipMap(null);
    skipMapRef.current = null;
    analyzeFingerprintRef.current = null;
    setAnalyzeStatus(null);
    setAnalyzeError(null);
    setAudioMismatchWarning(null);
    setUploadProgress(null);
    player.setSkipSegments([]);
    return true;
  }, [isPrepareInFlightForCurrent]);

  const clearAdDetection = useCallback((status = 'disabled') => {
    // Never clear while manual Prepare is running — Prepare must show progress and complete.
    if (isPrepareInFlightForCurrent()) {
      console.log('[playback] clearAdDetection blocked: manual prepare in flight');
      return;
    }
    setAdDetectionEnabledState(false);
    setSkipMap(null);
    skipMapRef.current = null;
    setAnalyzeStatus(status);
    setAnalyzeError(null);
    setAudioMismatchWarning(null);
    setUploadProgress(null);
    player.setAdDetectionEnabled(false);
    player.setSkipSegments([]);
  }, [isPrepareInFlightForCurrent]);

  /** Global Settings kill-switch: Off means no ad-detection API calls at all. */
  const canCallAdDetectionApi = useCallback(async (): Promise<boolean> => {
    return getAutoSkipEnabled();
  }, []);

  /** Auto-analyze / auto-skip path: requires global ON *and* per-show ON. */
  const canUseAdDetection = useCallback(async (ep: Episode): Promise<boolean> => {
    if (!(await canCallAdDetectionApi())) return false;
    return isPodcastAdDetectionEnabled({
      collectionId: ep.collectionId,
      feedUrl: ep.feedUrl,
    });
  }, [canCallAdDetectionApi]);

  /**
   * Apply per-show skip settings to filter segments.
   * Returns segments that should actually be skipped based on settings.
   */
  const getMatchingLocalSkipMap = useCallback(async (ep: Episode): Promise<SkipMap | null> => {
    if (!ep.enclosureUrl) return null;
    const audioMd5 = await getCachedAudioMd5(ep.guid, ep.enclosureUrl);
    if (!audioMd5) return null;
    const map = await getCachedSkipMap(ep.guid, ep.enclosureUrl);
    return map?.status === 'ready' && map.audio_md5?.toLowerCase() === audioMd5
      ? map
      : null;
  }, []);

  /**
   * Read-only lookup of a ready map for `ep`'s downloaded copy (local cache first, then the
   * server by fingerprint). Never analyzes or touches the player. Null when there's none.
   */
  const findPreparedSkipMap = useCallback(async (ep: Episode): Promise<SkipMap | null> => {
    const local = await getMatchingLocalSkipMap(ep);
    if (local) return local;
    // Global Ad-skip off means no ad-detection API calls at all.
    if (!ep.enclosureUrl || !(await getAutoSkipEnabled())) return null;
    const audioMd5 = await getCachedAudioMd5(ep.guid, ep.enclosureUrl);
    if (!audioMd5) return null;
    await Promise.all([hydrateApiBaseUrl(), hydrateAppKey()]);
    const remote = await getSkipMap(ep.guid, audioMd5);
    if (remote.status !== 'ready') return null;
    try {
      await cacheSkipMap(ep.guid, remote, ep.enclosureUrl);
    } catch (cacheErr) {
      console.warn('[playback] cacheSkipMap failed (non-fatal):', cacheErr);
    }
    return remote;
  }, [getMatchingLocalSkipMap]);

  const applySkipFilter = useCallback((
    segments: AdSegment[],
    settings: PodcastSkipSettings | null,
  ): AdSegment[] => {
    if (!settings || !settings.skipEnabled) {
      // Master toggle is off: no skipping
      return [];
    }
    
    // Normalize legacy types and filter by per-kind toggles
    const normalized = segments.map(normalizeSegment);
    return filterSkippableSegments(normalized, {
      skipAdvertisement: settings.skipAdvertisement,
      skipIntroOutro: settings.skipIntroOutro,
      skipSelfPromotion: settings.skipSelfPromotion,
    });
  }, []);

  /**
   * Abort an in-flight skip-map load without wiping a cached ready map.
   * Toggling global auto-skip off mid-await used to call clearAdDetection() and
   * permanently break the segment sheet until a full re-analyze.
   */
  const abortLoadKeepCache = useCallback(() => {
    // Never clear while manual Prepare is running — Prepare must show progress and complete.
    if (isPrepareInFlightForCurrent()) {
      console.log('[playback] abortLoadKeepCache blocked: manual prepare in flight');
      return;
    }
    setAdDetectionEnabledState(false);
    player.setAdDetectionEnabled(false);
    // Leave skipMap / analyzeStatus / player segments intact.
  }, [isPrepareInFlightForCurrent]);

  /**
   * Show a ready map for `ep` and hand its filtered segments to the player. With
   * `enableDetection`, also turn auto-skip on for it (a manually prepared map on a show
   * whose auto-detection is off), provided global auto-skip is on.
   */
  const applyReadyMap = useCallback((
    ep: Episode,
    map: SkipMap,
    settings: PodcastSkipSettings | null,
    enableDetection: boolean,
  ) => {
    if (enableDetection && player.getAutoSkip()) {
      setAdDetectionEnabledState(true);
      player.setAdDetectionEnabled(true);
    }
    setSkipMap(map);
    skipMapRef.current = map;
    player.setSkipSegments(applySkipFilter(map.segments, settings), ep.guid);
    setAnalyzeStatus('ready');
    const warnings = detectAudioMismatch(ep, map);
    const summary = formatMismatchSummary(warnings);
    setAudioMismatchWarning(summary);
    if (summary) {
      console.warn('[playback] Audio mismatch detected:', summary, warnings);
    }
  }, [applySkipFilter]);

  const loadSkipMap = useCallback(async (ep: Episode, enabled: boolean): Promise<SkipMap | null> => {
    const gen = skipLoadGen.current;
    const stillCurrent = () => gen === skipLoadGen.current;

    /** Cache a ready server map locally; false if this load went stale meanwhile. */
    const cacheRemoteMap = async (remote: SkipMap): Promise<boolean> => {
      try {
        await cacheSkipMap(ep.guid, remote, ep.enclosureUrl);
      } catch (cacheErr) {
        console.warn('[playback] cacheSkipMap failed (non-fatal):', cacheErr);
      }
      return stillCurrent();
    };

    const restoreExistingMap = async (settings: PodcastSkipSettings): Promise<SkipMap | null> => {
      // The global setting is the API kill-switch; per-show OFF only prevents auto-analysis.
      // A manually prepared map should still be recoverable from the server after a cold start.
      if (!(await getAutoSkipEnabled())) {
        player.setSkipSegments([], ep.guid);
        return null;
      }

      try {
        await Promise.all([hydrateApiBaseUrl(), hydrateAppKey()]);
        if (!stillCurrent()) return null;
        const audioMd5 = ep.enclosureUrl
          ? await getCachedAudioMd5(ep.guid, ep.enclosureUrl)
          : null;
        const remote = await getSkipMap(ep.guid, audioMd5);
        if (!stillCurrent()) return null;

        if (remote.status === 'ready') {
          if (!(await cacheRemoteMap(remote))) return null;
          // Global auto-skip is on (checked above): auto-skip it even if the show's
          // auto-detection is off.
          applyReadyMap(ep, remote, settings, true);
        } else {
          setSkipMap(remote);
          skipMapRef.current = remote;
          setAnalyzeStatus(remote.status);
          player.setSkipSegments([], ep.guid);
        }
        return remote;
      } catch (error) {
        if (!stillCurrent()) return null;
        console.warn('[playback] Existing skip-map lookup failed:', error);
        setAnalyzeStatus('offline');
        player.setSkipSegments([], ep.guid);
        return null;
      }
    };

    /** Detection is off for this show: restore a prepared map, but never auto-analyze. */
    const restoreWithoutDetection = async (): Promise<SkipMap | null> => {
      const settings = await getPodcastSkipSettings({
        collectionId: ep.collectionId,
        feedUrl: ep.feedUrl,
      });
      if (!stillCurrent()) return null;
      setSkipSettingsState(settings);

      // Only restore local maps when the retained audio file has the same fingerprint.
      const local = await getMatchingLocalSkipMap(ep);
      if (!stillCurrent()) return null;
      if (local?.status === 'ready') {
        applyReadyMap(ep, local, settings, true);
        return local;
      }
      abortLoadKeepCache();
      return restoreExistingMap(settings);
    };

    if (!enabled) {
      abortLoadKeepCache();
      return restoreWithoutDetection();
    }
    if (!(await canUseAdDetection(ep))) {
      if (!(await getAutoSkipEnabled())) {
        // Global toggle raced off — keep cached segments for the sheet.
        abortLoadKeepCache();
        return null;
      }
      return restoreWithoutDetection();
    }
    if (!stillCurrent()) return null;

    // Load skip settings for this episode
    const settings = await getPodcastSkipSettings({
      collectionId: ep.collectionId,
      feedUrl: ep.feedUrl,
    });
    if (!stillCurrent()) return null;
    setSkipSettingsState(settings);

    setAdDetectionEnabledState(true);
    player.setAdDetectionEnabled(true);
    const local = await getMatchingLocalSkipMap(ep);
    if (!stillCurrent()) return null;
    if (!(await canUseAdDetection(ep))) {
      if (!(await getAutoSkipEnabled())) {
        abortLoadKeepCache();
        return null;
      }
      // Per-show raced off mid-load: keep any ready local map for the sheet.
      if (local?.status === 'ready') {
        applyReadyMap(ep, local, settings, true);
        return local;
      }
      clearAdDetection();
      return null;
    }
    if (!stillCurrent()) return null;
    if (local?.status === 'ready') {
      applyReadyMap(ep, local, settings, false);
      return local;
    }
    try {
      // Ensure Settings-stored API URL / app key are loaded before cold-start GETs.
      await Promise.all([hydrateApiBaseUrl(), hydrateAppKey()]);
      if (!stillCurrent()) return null;
      const audioMd5 = ep.enclosureUrl
        ? await getCachedAudioMd5(ep.guid, ep.enclosureUrl)
        : null;
      const remote = await getSkipMap(ep.guid, audioMd5);
      if (!stillCurrent()) return null;
      if (!(await canUseAdDetection(ep))) {
        if (!(await getAutoSkipEnabled())) {
          abortLoadKeepCache();
          return null;
        }
        clearAdDetection();
        return null;
      }
      if (!stillCurrent()) return null;
      if (remote.status === 'ready') {
        if (!(await cacheRemoteMap(remote))) return null;
        applyReadyMap(ep, remote, settings, false);
      } else {
        setSkipMap(remote);
        skipMapRef.current = remote;
        setAnalyzeStatus(remote.status);
        player.setSkipSegments([], ep.guid);
        setAudioMismatchWarning(null);
      }
      return remote;
    } catch (error) {
      if (!stillCurrent()) return null;
      console.warn('[playback] Skip-map restore from API failed:', error);
      setAnalyzeStatus('offline');
      player.setSkipSegments([], ep.guid);
      return null;
    }
  }, [abortLoadKeepCache, applyReadyMap, canUseAdDetection, clearAdDetection, getMatchingLocalSkipMap]);

  // Queue items and Android Auto picks carry no show notes (kept small in storage);
  // fill them in from the cached/fetched feed once the episode is loaded.
  const restoreShowNotesRef = useRef((target: Episode) => {
    if (target.description?.trim() || !target.feedUrl) return;
    void findEpisodeNotes(target.feedUrl, target.guid)
      .then((description) => {
        if (!description?.trim()) return;
        // The loaded episode, or one opened but not started yet (or both, briefly).
        if (episodeRef.current?.guid === target.guid) {
          const enriched = { ...episodeRef.current, description };
          episodeRef.current = enriched;
          setEpisode(enriched);
          player.updateEpisodeMetadata(enriched);
        }
        const opened = openedEpisodeRef.current;
        if (opened?.episode.guid === target.guid) {
          const next = { ...opened, episode: { ...opened.episode, description } };
          openedEpisodeRef.current = next;
          setOpenedEpisode(next);
        }
      })
      .catch((error) => {
        console.warn('[playback] Could not restore show notes:', error);
      });
  });

  useEffect(() => {
    externalEpisodeChangeRef.current = (target) => {
      setSkipMap(null);
      skipMapRef.current = null;
      setAnalyzeStatus(null);
      setAnalyzeError(null);
      setAudioMismatchWarning(null);
      setUploadProgress(null);
      skipLoadGen.current += 1;
      restoreShowNotesRef.current(target);
      void (async () => {
        try {
          const globallyEnabled = await getAutoSkipEnabled();
          const enabled = globallyEnabled && await isPodcastAdDetectionEnabled({
            collectionId: target.collectionId,
            feedUrl: target.feedUrl,
          });
          if (episodeRef.current?.guid !== target.guid) return;
          // Started natively (Android Auto pick) from the stream: if ad skipping applies,
          // switch to the downloaded copy (downloading it first) like Play does in the app.
          if (!player.getLoadedSource().localFilePath && target.enclosureUrl) {
            const { source } = await resolvePlaybackSourceRef.current(target, globallyEnabled, enabled);
            if (episodeRef.current?.guid !== target.guid) return;
            if (source === 'download' || source === 'local') {
              // Pick up where the native player already is (it started on its own).
              const here = player.getStatus();
              await playEpisodeRef.current?.(target, {
                resumePositionMs: here.episode?.guid === target.guid ? here.positionMs : undefined,
              });
              return;
            }
          }
          setAdDetectionEnabledState(enabled);
          player.setAdDetectionEnabled(enabled);
          await loadSkipMap(target, enabled);
        } catch (error) {
          if (episodeRef.current?.guid !== target.guid) return;
          console.warn('[playback] Could not load skip map for Android Auto episode:', error);
        }
      })();
    };
    return () => {
      externalEpisodeChangeRef.current = null;
    };
  }, [loadSkipMap]);

  const restoreCurrentSkipMap = useCallback(async (): Promise<SkipMap | null> => {
    const current = episodeRef.current;
    if (!current?.guid) return null;

    const inMemory = skipMapRef.current;
    if (inMemory?.status === 'ready' && inMemory.episode_guid === current.guid) {
      return inMemory;
    }

    try {
      const globalEnabled = await getAutoSkipEnabled();
      const enabled = globalEnabled && await isPodcastAdDetectionEnabled({
        collectionId: current.collectionId,
        feedUrl: current.feedUrl,
      });
      if (episodeRef.current?.guid !== current.guid) return null;
      return await loadSkipMap(current, enabled);
    } catch (error) {
      if (episodeRef.current?.guid !== current.guid) return null;
      console.warn('[playback] Failed to restore current skip map:', error);
      setAnalyzeStatus('offline');
      return null;
    }
  }, [loadSkipMap]);

  /**
   * Whether the server has (or is making) a skip map for this episode from some
   * download, e.g. a manual Prepare on a show whose auto-detection is off. Asked
   * without a fingerprint, so it never returns segment times. False when unreachable.
   */
  const checkServerHasAnalysis = useCallback(async (ep: Episode): Promise<boolean> => {
    try {
      await Promise.all([hydrateApiBaseUrl(), hydrateAppKey()]);
      const map = await Promise.race([
        getSkipMap(ep.guid, null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), PREPARED_CHECK_TIMEOUT_MS)),
      ]);
      return serverHasAnalysis(map);
    } catch {
      return false;
    }
  }, []);

  /**
   * Where `ep` must play from (see playbackSource.ts). Ad skipping only ever applies to
   * the downloaded copy, so episodes that use it are downloaded before they play.
   */
  const resolvePlaybackSource = useCallback(
    async (ep: Episode, autoSkipOn: boolean, detectionEnabled: boolean) => {
      let localFilePath: string | null = null;
      if (ep.enclosureUrl) {
        try {
          localFilePath = await getCachedAudioPath(ep.guid, ep.enclosureUrl);
        } catch (err) {
          console.warn('[playback] Failed to check cached audio:', err);
        }
      }
      const hasPreparedAnalysis =
        !localFilePath && !!ep.enclosureUrl && autoSkipOn && !detectionEnabled
          ? await checkServerHasAnalysis(ep)
          : false;
      const source = decidePlaybackSource({
        hasLocalFile: !!localFilePath,
        hasEnclosureUrl: !!ep.enclosureUrl,
        globalAutoSkip: autoSkipOn,
        podcastDetectionEnabled: detectionEnabled,
        hasPreparedAnalysis,
      });
      return { source, localFilePath };
    },
    [checkServerHasAnalysis],
  );

  /** Download the next queued episode in the background so it can start right away. */
  const prefetchNextQueued = useCallback(
    async (current: Episode) => {
      try {
        const queue = getQueue();
        const index = queue.findIndex((item) => item.guid === current.guid);
        const next = queue[index + 1];
        if (!next?.enclosureUrl || next.guid === current.guid) return;
        const autoSkipOn = await getAutoSkipEnabled();
        if (!autoSkipOn) return;
        const detectionEnabled = await isPodcastAdDetectionEnabled({
          collectionId: next.collectionId,
          feedUrl: next.feedUrl,
        });
        const { source } = await resolvePlaybackSource(next, autoSkipOn, detectionEnabled);
        if (source !== 'download') return;
        console.log('[playback] Prefetching next queued episode:', next.guid);
        await downloadAudioForAnalysis(next.guid, next.enclosureUrl);
        void syncAndroidAutoCatalog();
      } catch (err) {
        // It'll be downloaded (with a visible error if that fails) when it plays.
        console.warn('[playback] Queue prefetch failed (non-fatal):', err);
      }
    },
    [resolvePlaybackSource],
  );

  const playEpisode = useCallback(
    async (ep: Episode, opts?: PlayEpisodeOptions) => {
      const playGen = ++playGenRef.current;
      const isThisPlay = () =>
        playGen === playGenRef.current && episodeRef.current?.guid === ep.guid;
      // Snapshot previous position, then switch React state BEFORE any await so
      // concurrent navigation to Now Playing never flashes the empty state.
      const prev = episodeRef.current;
      const prevPos = positionRef.current;
      const prevDur = durationRef.current;

      // Until loadAndPlay reports `ep`, the player still describes `prev`.
      if (prev?.guid !== ep.guid) switchingToGuidRef.current = ep.guid;
      setEpisode(ep);
      restoreShowNotesRef.current(ep);
      episodeRef.current = ep;
      setPlaybackDownload(null);
      // The player stops saving any other episode once this one loads.
      abandonStreamCacheDownloads(ep.guid);
      // Starting an episode puts it at index 0 of Up Next (no-op if already there).
      void markPlaying(ep);
      setSkipMap(null);
      skipMapRef.current = null;
      setSkipSettingsState(null);
      setAnalyzeStatus(null);
      setAnalyzeError(null);
      setAudioMismatchWarning(null);
      setUploadProgress(null);
      skipLoadGen.current += 1;

      // Persist the previous episode using the snapshot (ref already points at `ep`).
      if (prev?.guid && prev.guid !== ep.guid) {
        try {
          lastSavedAt.current = Date.now();
          lastSavedPos.current = prevPos;
          await savePlaybackPosition(prev.guid, prevPos, prevDur || undefined);
        } catch (err) {
          console.warn('[playback] Failed to persist previous position:', err);
        }
      }

      // Re-sync last-used Ad-skip preference before play (covers cold start
      // race + Metro reload resetting the player module default to true).
      const autoSkipOn = await getAutoSkipEnabled();
      setAutoSkipState(autoSkipOn);
      player.setAutoSkip(autoSkipOn);

      const streamOnly = !!opts?.allowStream;
      const detectionEnabled = autoSkipOn && !streamOnly
        ? await isPodcastAdDetectionEnabled({
            collectionId: ep.collectionId,
            feedUrl: ep.feedUrl,
          })
        : false;
      setAdDetectionEnabledState(detectionEnabled);
      player.setAdDetectionEnabled(detectionEnabled);

      // Load skip settings early so they're available for filtering (even when detection is off)
      const settings = await getPodcastSkipSettings({
        collectionId: ep.collectionId,
        feedUrl: ep.feedUrl,
      });
      setSkipSettingsState(settings);

      const saved = await getPlaybackPosition(ep.guid);
      let startPositionMs = opts?.resumePositionMs ?? saved?.positionMs ?? 0;

      // Ad segment times belong to the exact file that was analyzed. Play the downloaded
      // copy when there is one; when ad skipping applies and there isn't, download it
      // first. Only episodes that won't skip anything (or "Play without ad skipping")
      // stream.
      const resolved = await resolvePlaybackSource(ep, autoSkipOn && !streamOnly, detectionEnabled);
      let localFilePath = resolved.localFilePath;
      if (!isThisPlay()) return;
      // Play right away while the player saves exactly the bytes it plays; skips turn on
      // once that file is complete and fingerprinted. Download-first is the fallback.
      let streamCachePath: string | null = null;
      let streamCacheDone: Promise<string> | null = null;
      if (
        ep.enclosureUrl &&
        shouldPlayWhileDownloading({
          needsDownload: resolved.source === 'download',
          hasEnclosureUrl: !!ep.enclosureUrl,
          nativeAvailable: player.supportsPlayWhileDownloading(),
          regularDownloadInFlight: isAudioDownloadInFlight(ep.guid, ep.enclosureUrl),
        })
      ) {
        try {
          streamCachePath = await prepareStreamCachePath(ep.guid, ep.enclosureUrl);
          streamCacheDone = beginStreamCacheDownload(ep.guid, ep.enclosureUrl);
        } catch (err) {
          console.warn('[playback] Could not set up play-while-downloading:', err);
          streamCachePath = null;
          streamCacheDone = null;
        }
        if (!isThisPlay()) return;
        if (streamCachePath) {
          setPlaybackDownload({ guid: ep.guid, state: 'caching', progressPct: 0 });
          console.log('[playback] Playing while downloading (skips after download):', ep.guid);
        }
      }
      if (resolved.source === 'download' && ep.enclosureUrl && !streamCachePath) {
        // Nothing plays until the download is ready (the previous episode stops now).
        if (player.getStatus().isPlaying) await player.pause('download before play');
        isPlayingRef.current = false;
        setIsPlaying(false);
        setPositionMs(startPositionMs);
        setDurationMs(ep.durationMs ?? saved?.durationMs ?? 0);
        setPlaybackDownload({ guid: ep.guid, state: 'downloading', progressPct: 0 });
        console.log('[playback] Downloading before play (ad skipping applies):', ep.guid);
        try {
          localFilePath = await downloadAudioForAnalysis(ep.guid, ep.enclosureUrl, (progress) => {
            if (!isThisPlay()) return;
            const total = progress.totalBytesExpectedToWrite;
            setPlaybackDownload({
              guid: ep.guid,
              state: 'downloading',
              progressPct:
                total > 0 ? Math.min(100, Math.round((progress.totalBytesWritten / total) * 100)) : null,
            });
          });
          void syncAndroidAutoCatalog();
        } catch (err) {
          console.warn('[playback] Download before play failed:', err);
          if (!isThisPlay()) return;
          // Don't fall back to the stream: its ads (and so the skip times) can differ.
          setPlaybackDownload({
            guid: ep.guid,
            state: 'error',
            progressPct: null,
            message: downloadFailureMessage(err),
          });
          return;
        }
        if (!isThisPlay()) return;
        setPlaybackDownload(null);
        // The user may have scrubbed while it downloaded.
        try {
          startPositionMs = (await getPlaybackPosition(ep.guid))?.positionMs ?? startPositionMs;
        } catch {
          /* keep the earlier position */
        }
        if (!isThisPlay()) return;
      } else if (localFilePath) {
        console.log('[playback] Using cached audio file for playback:', localFilePath);
      }

      try {
        await player.loadAndPlay(ep, {
          startPositionMs,
          localFilePath: localFilePath || undefined,
          streamCachePath: streamCachePath ?? undefined,
          streamUrl: streamCachePath ? opts?.streamUrl : undefined,
        });
        lastSavedAt.current = Date.now();
        lastSavedPos.current = startPositionMs;
      } catch (err) {
        console.error('[playback] Failed to load and play episode:', err);
        // Continue with skip map loading even if player fails (stub mode may still work)
      } finally {
        if (switchingToGuidRef.current === ep.guid) switchingToGuidRef.current = null;
      }
      void prefetchNextQueued(ep);
      // Streaming by choice after a failed download: no skip map, no analysis.
      if (streamOnly) return;
      
      // Load skip map and auto-analyze in parallel without blocking return.
      // This ensures UI navigation happens immediately while analysis proceeds in background.
      void (async () => {
        try {
          if (streamCacheDone) {
            // Skip times must match the bytes being played: wait until the player has saved
            // the whole episode and it's fingerprinted, then look up / make its analysis.
            try {
              localFilePath = await streamCacheDone;
            } catch (err) {
              console.warn('[playback] Play-while-downloading did not complete:', err);
              return;
            }
            if (!isThisPlay()) return;
            console.log('[playback] Episode saved while playing; loading its skip map:', ep.guid);
          }
          const loaded = await loadSkipMap(ep, detectionEnabled);
          // Never re-analyze / clobber when we already have a ready (or in-flight)
          // map from AsyncStorage or the backend — that was wiping segments after
          // cold start whenever the API returned missing (empty/wiped DB).
          if (
            loaded?.status === 'ready' ||
            loaded?.status === 'pending' ||
            loaded?.status === 'queued'
          ) {
            return;
          }
          // The server's map was made from a different download of this episode (other
          // dynamically inserted ads): analyze our copy instead of using those times.
          // Applies to prepared episodes on shows with auto-detection off too.
          if (
            !detectionEnabled &&
            autoSkipOn &&
            localFilePath &&
            needsReanalysisForLocalFile(loaded) &&
            episodeRef.current?.guid === ep.guid
          ) {
            console.log('[playback] Server map is for other audio; re-analyzing local file:', ep.guid);
            void requestAnalyzeForEpisodeRef.current?.(ep);
            return;
          }
          // Fire-and-forget analyze if no map yet, but only while both gates are on.
          if (detectionEnabled && ep.enclosureUrl) {
            try {
              if (!(await canUseAdDetection(ep))) {
                // Do not clearAdDetection here: loadSkipMap may have restored a
                // ready cache while per-show detection is off.
                return;
              }
              const audioMd5 = ep.enclosureUrl
                ? await getCachedAudioMd5(ep.guid, ep.enclosureUrl)
                : null;
              const existing = await getSkipMap(ep.guid, audioMd5);
              const stillCurrent = () => episodeRef.current?.guid === ep.guid;
              if (existing.status === 'ready') {
                try {
                  await cacheSkipMap(ep.guid, existing, ep.enclosureUrl);
                } catch (cacheErr) {
                  console.warn('[playback] cacheSkipMap failed (non-fatal):', cacheErr);
                }
                const showSettings = await getPodcastSkipSettings({
                  collectionId: ep.collectionId,
                  feedUrl: ep.feedUrl,
                });
                if (!stillCurrent()) return;
                applyReadyMap(ep, existing, showSettings, false);
                return;
              }
              if (!stillCurrent()) return;
              if (existing.status === 'pending' || existing.status === 'queued') {
                setSkipMap(existing);
                skipMapRef.current = existing;
                setAnalyzeStatus(existing.status);
                return;
              }
              if (existing.status === 'missing' || existing.status === 'error') {
                void requestAnalyzeForEpisodeRef.current?.(ep);
              }
            } catch {
              /* backend optional while browsing — keep any locally restored map */
            }
          }
        } catch (err) {
          console.warn('[playback] Skip map loading failed:', err);
        }
      })();
    },
    [applyReadyMap, canUseAdDetection, loadSkipMap, prefetchNextQueued, resolvePlaybackSource, setPlaybackDownload],
  );

  playEpisodeRef.current = (target, opts) => playEpisode(target, opts);
  resolvePlaybackSourceRef.current = resolvePlaybackSource;

  const retryPlaybackDownload = useCallback(async () => {
    const current = episodeRef.current;
    const state = playbackDownloadRef.current?.state;
    if (!current || (state !== 'error' && state !== 'cache-error')) return;
    if (state === 'cache-error') {
      // Still playing without skips: start saving again from where we are.
      const here = player.getStatus();
      await playEpisode(current, {
        resumePositionMs: here.episode?.guid === current.guid ? here.positionMs : undefined,
      });
      return;
    }
    await playEpisode(current);
  }, [playEpisode]);

  // Play-while-downloading progress, completion and failure (native reports ~every 500 ms).
  useEffect(() => {
    return player.subscribeStreamCache((cache) => {
      const current = episodeRef.current;
      if (!current?.enclosureUrl) return;
      const audioUrl = current.enclosureUrl;
      const outcome = streamCacheOutcome(cache, current.guid);
      if (outcome === 'none') return;
      const shown = playbackDownloadRef.current;
      if (outcome === 'progress') {
        if (shown?.guid !== current.guid || shown.state !== 'caching') return;
        const pct = streamCacheProgressPct(cache);
        if (pct !== shown.progressPct) {
          setPlaybackDownload({ guid: current.guid, state: 'caching', progressPct: pct });
        }
        return;
      }
      if (outcome === 'ready') {
        void completeStreamCacheDownload(current.guid, audioUrl, cache.md5!).then((handled) => {
          if (!handled) return;
          if (playbackDownloadRef.current?.guid === current.guid) setPlaybackDownload(null);
          void syncAndroidAutoCatalog();
        });
        return;
      }
      // Failed: playback keeps going straight from the network, without skips.
      if (!failStreamCacheDownload(current.guid, audioUrl, cache.error ?? 'Download failed')) return;
      console.warn('[playback] Play-while-downloading failed:', cache.error);
      if (
        isRedirectError(cache.error ?? '') &&
        cache.bytes === 0 &&
        resolvedStreamRetryRef.current !== current.guid
      ) {
        // Tracking-redirect loop on this network: let the server follow the chain, then
        // play/save the final URL (same fallback as regular downloads).
        resolvedStreamRetryRef.current = current.guid;
        void (async () => {
          try {
            const finalUrl = await resolveAudioUrl(audioUrl);
            if (episodeRef.current?.guid !== current.guid) return;
            const here = player.getStatus();
            await playEpisodeRef.current?.(current, {
              streamUrl: finalUrl,
              resumePositionMs: here.episode?.guid === current.guid ? here.positionMs : undefined,
            });
          } catch (err) {
            if (episodeRef.current?.guid !== current.guid) return;
            setPlaybackDownload({
              guid: current.guid,
              state: 'cache-error',
              progressPct: null,
              message: streamCacheFailureMessage(err instanceof Error ? err.message : String(err)),
            });
          }
        })();
        return;
      }
      setPlaybackDownload({
        guid: current.guid,
        state: 'cache-error',
        progressPct: null,
        message: streamCacheFailureMessage(cache.error),
      });
    });
  }, [setPlaybackDownload]);

  const streamWithoutSkipping = useCallback(async () => {
    const current = episodeRef.current;
    if (!current) return;
    await playEpisode(current, { allowStream: true });
  }, [playEpisode]);

  const updateOpened = useCallback((next: OpenedEpisode | null) => {
    openedEpisodeRef.current = next;
    setOpenedEpisode(next);
  }, []);

  const openEpisode = useCallback(
    (ep: Episode) => {
      // Re-opening the loaded episode shows its live state, as before.
      if (episodeRef.current?.guid === ep.guid) {
        updateOpened(null);
        return;
      }
      // Set synchronously so the player screen never flashes stale/empty content.
      updateOpened({ episode: ep, positionMs: 0, durationMs: ep.durationMs ?? 0 });
      restoreShowNotesRef.current(ep);
      void (async () => {
        try {
          const map = await findPreparedSkipMap(ep);
          const cur = openedEpisodeRef.current;
          if (!map || cur?.episode.guid !== ep.guid) return;
          updateOpened({ ...cur, skipMap: map });
        } catch (err) {
          console.warn('[playback] Failed to look up skip map for opened episode:', err);
        }
      })();
      void (async () => {
        try {
          const saved = await getPlaybackPosition(ep.guid);
          const cur = openedEpisodeRef.current;
          if (!saved || cur?.episode.guid !== ep.guid) return;
          updateOpened({
            ...cur,
            positionMs: saved.positionMs ?? 0,
            durationMs: saved.durationMs || cur.durationMs,
          });
        } catch (err) {
          console.warn('[playback] Failed to read saved position for opened episode:', err);
        }
      })();
    },
    [findPreparedSkipMap, updateOpened],
  );

  const startOpenedEpisode = useCallback(async () => {
    const opened = openedEpisodeRef.current;
    if (!opened) return;
    // playEpisode reads the saved resume position; flush any scrub first.
    try {
      await savePlaybackPosition(
        opened.episode.guid,
        opened.positionMs,
        opened.durationMs || undefined,
      );
    } catch (err) {
      console.warn('[playback] Failed to persist opened episode position:', err);
    }
    const playing = playEpisode(opened.episode);
    // playEpisode switched `episode` synchronously; drop the preview now.
    updateOpened(null);
    await playing;
  }, [playEpisode, updateOpened]);

  const seekOpenedEpisode = useCallback(
    async (ms: number) => {
      const cur = openedEpisodeRef.current;
      if (!cur) return;
      const max = cur.durationMs > 0 ? cur.durationMs : Number.MAX_SAFE_INTEGER;
      const pos = Math.max(0, Math.min(Math.floor(ms), max));
      updateOpened({ ...cur, positionMs: pos });
      try {
        await savePlaybackPosition(cur.episode.guid, pos, cur.durationMs || undefined);
      } catch (err) {
        console.warn('[playback] Failed to save opened episode position:', err);
      }
    },
    [updateOpened],
  );

  const closeOpenedEpisode = useCallback(() => updateOpened(null), [updateOpened]);

  // Up Next: hydrate, refresh auto-add shows, and auto-advance when an episode ends
  // (expo-audio didJustFinish, native service STATE_ENDED, or stub clock).
  useEffect(() => {
    void hydrateQueue();
    void hydratePlayed();
    void syncBackgroundRefreshRegistration();
    const stopFeedback = startFeedbackOutbox();
    const stopRefresh = startAutoQueueRefresh();
    return () => {
      stopFeedback();
      stopRefresh();
    };
  }, []);

  useEffect(() => {
    return player.subscribeEnded((finished) => {
      const current = episodeRef.current;
      if (!finished?.guid || (current && current.guid !== finished.guid)) return;
      void setPlayed(finished.guid, true);
      void (async () => {
        const next = await popNext(finished.guid);
        if (!next || episodeRef.current?.guid !== finished.guid) return;
        console.log('[playback] Up Next: advancing to', next.guid);
        try {
          await clearPlaybackPosition(finished.guid);
        } catch {
          /* non-fatal */
        }
        // Counts as starting it: same path as Play (auto-analyze rules apply).
        if (openedEpisodeRef.current?.episode.guid === next.guid) updateOpened(null);
        await playEpisode(next);
      })();
    });
  }, [playEpisode, updateOpened]);

  const setEpisodePlayed = useCallback(async (ep: Episode, value: boolean) => {
    await setPlayed(ep.guid, value);
    const isCurrent = episodeRef.current?.guid === ep.guid;
    if (value) {
      // Played: next open starts from the beginning; stop re-saving the old spot.
      if (isCurrent) clearedPositionGuid.current = ep.guid;
      await clearPlaybackPosition(ep.guid);
    } else if (!isCurrent) {
      // Unplayed: fresh start. (The loaded episode keeps its live position.)
      await clearPlaybackPosition(ep.guid);
    }
  }, []);

  const togglePlay = useCallback(async () => {
    if (isAwaitingDownload()) {
      // Play after a failed download retries it; while downloading it starts by itself.
      if (playbackDownloadRef.current?.state === 'error') await retryPlaybackDownload();
      return;
    }
    if (isPlayingRef.current) {
      await player.pause();
      await persistPosition(true);
    } else {
      await player.play();
    }
  }, [isAwaitingDownload, persistPosition, retryPlaybackDownload]);

  const seek = useCallback(
    async (ms: number) => {
      const waiting = episodeRef.current;
      if (waiting && isAwaitingDownload()) {
        // Not loaded yet (the player still holds the previous episode): just move the
        // resume point; playback starts there once the download is ready.
        const pos = Math.max(0, Math.floor(ms));
        setPositionMs(pos);
        await savePlaybackPosition(waiting.guid, pos, waiting.durationMs || undefined);
        return;
      }
      await player.seekTo(ms);
      positionRef.current = ms;
      await persistPosition(true);
    },
    [isAwaitingDownload, persistPosition],
  );

  const cyclePlaybackRate = useCallback(() => {
    const current = player.getPlaybackRate();
    const next = current === 1 ? 1.5 : current === 1.5 ? 2 : 1;
    player.setPlaybackRate(next);
  }, []);

  const setAutoSkip = useCallback(async (v: boolean) => {
    // Invalidate any in-flight load/analyze kicked off by a prior toggle.
    skipLoadGen.current += 1;
    const gen = skipLoadGen.current;

    setAutoSkipState(v);
    player.setAutoSkip(v);
    await setAutoSkipEnabled(v);
    if (gen !== skipLoadGen.current) return;

    const current = episodeRef.current;
    if (!v) {
      // Keep skipMap / analyzeStatus / segments / adDetectionEnabled for this
      // episode so the segment sheet can reopen and its Switch stays in sync.
      // autoSkip=false already stops seeking over ads in the player.
      return;
    }
    if (current) {
      const podcastEnabled = await isPodcastAdDetectionEnabled({
        collectionId: current.collectionId,
        feedUrl: current.feedUrl,
      });
      if (gen !== skipLoadGen.current) return;
      // A manually prepared episode keeps detection on even when the show's
      // auto-detection is off (was: cleared here, so the switch stuck off).
      const memReady =
        skipMapRef.current?.status === 'ready' &&
        skipMapRef.current?.episode_guid === current.guid;
      const localReady = memReady ? null : await getMatchingLocalSkipMap(current);
      if (gen !== skipLoadGen.current) return;
      const effective = resolveAdDetectionEnabled({
        globalAutoSkip: true,
        podcastEnabled,
        hasReadyMapForEpisode: memReady || localReady?.status === 'ready',
      });
      setAdDetectionEnabledState(effective);
      player.setAdDetectionEnabled(effective);
      if (!effective) {
        // No prepared map: try restoring one from the server without analyzing.
        await loadSkipMap(current, false);
        return;
      }
      if (!memReady && localReady) skipMapRef.current = localReady;

      // Fast path: restore from in-memory ready map (toggle-off must not destroy it).
      // Avoids a network race that used to clearAdDetection() when toggling off mid-load.
      const cached = skipMapRef.current;
      if (
        cached &&
        cached.status === 'ready' &&
        cached.episode_guid === current.guid
      ) {
        // Load skip settings and apply filter
        const settings = await getPodcastSkipSettings({
          collectionId: current.collectionId,
          feedUrl: current.feedUrl,
        });
        if (gen !== skipLoadGen.current) return;
        setSkipSettingsState(settings);
        setSkipMap(cached);
        const filtered = applySkipFilter(cached.segments ?? [], settings);
        player.setSkipSegments(filtered, current.guid);
        setAnalyzeStatus('ready');
        const warnings = detectAudioMismatch(current, cached);
        const summary = formatMismatchSummary(warnings);
        setAudioMismatchWarning(summary);
        if (summary) {
          console.warn('[playback] Audio mismatch detected:', summary, warnings);
        }
        return;
      }

      // Restore from AsyncStorage cache (or GET skip map). Do not force-analyze
      // unless the episode has no ready map.
      const map = await loadSkipMap(current, true);
      if (gen !== skipLoadGen.current) return;
      if (
        current.enclosureUrl &&
        (map?.status === 'missing' || map?.status === 'error')
      ) {
        try {
          if (!(await canUseAdDetection(current))) {
            if (!(await getAutoSkipEnabled())) return;
            clearAdDetection();
            return;
          }
          if (gen !== skipLoadGen.current) return;
          void requestAnalyzeForEpisodeRef.current?.(current);
        } catch {
          if (gen !== skipLoadGen.current) return;
          setAnalyzeStatus('offline');
        }
      }
    }
  }, [canUseAdDetection, clearAdDetection, loadSkipMap, getMatchingLocalSkipMap]);

  const setPodcastAdDetection = useCallback(
    async (target: AdDetectionTarget, enabled: boolean) => {
      await setPodcastAdDetectionEnabled(target, enabled);
      const current = episodeRef.current;
      if (!current) return;
      const matches =
        (target.collectionId != null && current.collectionId === target.collectionId) ||
        (!!target.feedUrl && current.feedUrl === target.feedUrl);
      if (!matches) return;
      const effective = enabled && (await getAutoSkipEnabled());
      setAdDetectionEnabledState(effective);
      player.setAdDetectionEnabled(effective);
      if (!effective) clearAdDetection();
      else {
        // Restore the episode's map (local cache or server) instead of leaving it
        // without skips for the rest of the episode.
        skipLoadGen.current += 1;
        try {
          await loadSkipMap(current, true);
        } catch (error) {
          console.warn('[playback] Could not reload skip map after enabling detection:', error);
        }
      }
    },
    [clearAdDetection, loadSkipMap],
  );

  const setPodcastSkipSetting = useCallback(
    async (target: AdDetectionTarget, settings: Partial<PodcastSkipSettings>) => {
      await setPodcastSkipSettings(target, settings);
      const current = episodeRef.current;
      if (!current) return;
      const matches =
        (target.collectionId != null && current.collectionId === target.collectionId) ||
        (!!target.feedUrl && current.feedUrl === target.feedUrl);
      if (!matches) return;

      // Update in-memory settings
      const updated = await getPodcastSkipSettings(target);
      setSkipSettingsState(updated);

      // Re-filter segments with new settings
      const cached = skipMapRef.current;
      if (cached && cached.status === 'ready') {
        const filtered = applySkipFilter(cached.segments, updated);
        player.setSkipSegments(filtered, current.guid);
      }
    },
    [applySkipFilter],
  );

  // Explicit Prepare / force-analyze: gated by global Settings only.
  // Per-show "Ad detection for this show" OFF still allows user-initiated analyze;
  // that flag only blocks auto-analyze on play (see playEpisode / setAutoSkip).
  // 
  // Uses client-side download + upload to ensure analyzed audio matches playback.
  const runAnalyze = useCallback(
    async (
      force: boolean,
      targetEpisode: Episode | null,
      observe?: AnalyzeObserver,
    ): Promise<SkipMap | null> => {
      if (!targetEpisode?.enclosureUrl) {
        console.warn('[playback] requestAnalyze: no episode or enclosureUrl');
        return null;
      }
      if (!force && !(await canCallAdDetectionApi())) {
        console.log('[playback] requestAnalyze: automatic analysis blocked by Settings');
        observe?.({ analyzeStatus: 'disabled', uploadProgress: null });
        return null;
      }
      const guid = targetEpisode.guid;
      // The download/upload can take minutes; the user may switch episodes meanwhile.
      // UI state and player segments only ever describe the current episode.
      const isCurrent = () => episodeRef.current?.guid === guid;

      console.log('[playback] requestAnalyze: starting download/upload flow for', guid, 'force:', force);

      // Prevent loadSkipMap / clearAdDetection from clobbering this episode's Prepare.
      manualPrepareGuidRef.current = guid;
      if (force) manualReanalysisGuidRef.current = guid;

      if (isCurrent()) {
        // Immediately update UI state so user sees feedback
        setAdDetectionEnabledState(true);
        player.setAdDetectionEnabled(true);
        setAnalyzeStatus('downloading');
        setAnalyzeError(null);
        setUploadProgress({ downloaded: 0, uploaded: 0, total: 100 });
        setAudioMismatchWarning(null);
      }

      observe?.({
        analyzeStatus: 'downloading',
        analyzeError: null,
        uploadProgress: { downloaded: 0, uploaded: 0, total: 100 },
      });

      try {
        // Re-check global setting after state updates
        if (!force && !(await canCallAdDetectionApi())) {
          console.log('[playback] requestAnalyze: automatic analysis disabled during setup');
          observe?.({ analyzeStatus: 'disabled', uploadProgress: null });
          if (isCurrent()) {
            setAnalyzeStatus('disabled');
            setUploadProgress(null);
          }
          return null;
        }

        // Use Settings-stored API URL and key on cold starts before sending the upload.
        await Promise.all([hydrateApiBaseUrl(), hydrateAppKey()]);

        // Download audio locally
        console.log('[playback] requestAnalyze: downloading audio');
        const localPath = await downloadAudioForAnalysis(
          guid,
          targetEpisode.enclosureUrl,
          (progress: DownloadProgress) => {
            const pct = progress.totalBytesExpectedToWrite > 0
              ? (progress.totalBytesWritten / progress.totalBytesExpectedToWrite) * 50 // 0-50% for download
              : 0;
            const next = {
              downloaded: Math.round(pct),
              uploaded: 0,
              total: progress.totalBytesExpectedToWrite,
            };
            observe?.({ uploadProgress: next });
            if (isCurrent()) setUploadProgress(next);
          },
        );
        // Android Auto picks should play this download too.
        void syncAndroidAutoCatalog();

        const localAudioMd5 = await getCachedAudioMd5(guid, targetEpisode.enclosureUrl);
        if (isCurrent()) {
          analyzeFingerprintRef.current = localAudioMd5
            ? { episodeGuid: guid, audioMd5: localAudioMd5 }
            : null;

          // Play the same local bytes used for analysis rather than continuing a
          // potentially different dynamically-injected stream variant. Usually it already
          // does (episodes that use ad skipping are downloaded before they play).
          const loaded = player.getLoadedSource();
          if (loaded.episodeGuid !== guid || loaded.localFilePath !== localPath) {
            const playback = player.getStatus();
            await player.loadAndPlay(targetEpisode, {
              startPositionMs: playback.positionMs,
              localFilePath: localPath,
            });
            if (!playback.isPlaying) await player.pause('prepare: restore paused state');
          }
        }

        console.log('[playback] requestAnalyze: download complete, uploading to API');
        observe?.({ analyzeStatus: 'uploading' });
        if (isCurrent()) setAnalyzeStatus('uploading');

        // Upload to API for analysis
        const result = await uploadAudioForAnalysis(
          getApiBaseUrl(),
          getResolvedAppKey(),
          localPath,
          {
            episodeGuid: guid,
            audioUrl: targetEpisode.enclosureUrl,
            title: targetEpisode.title,
            podcastTitle: targetEpisode.podcastTitle,
            podcastDescription: targetEpisode.podcastDescription,
            episodeDescription: targetEpisode.description,
            durationMs: targetEpisode.durationMs,
            feedUrl: targetEpisode.feedUrl,
            force,
          },
          (progress: UploadProgress) => {
            const pct = progress.totalBytesExpectedToSend > 0
              ? 50 + (progress.totalBytesSent / progress.totalBytesExpectedToSend) * 50 // 50-100% for upload
              : 50;
            observe?.({
              uploadProgress: {
                downloaded: 50,
                uploaded: Math.round(pct - 50),
                total: progress.totalBytesExpectedToSend,
              },
            });
            if (!isCurrent()) return;
            setUploadProgress((prev) => ({
              downloaded: 50,
              uploaded: Math.round(pct - 50),
              total: prev?.total || progress.totalBytesExpectedToSend,
            }));
          },
        );

        const audioMd5 = typeof result.audio_md5 === 'string'
          ? result.audio_md5.toLowerCase()
          : localAudioMd5;
        console.log('[playback] requestAnalyze: upload complete, status:', result.status);
        if (result.status !== 'queued' && result.status !== 'pending') {
          if (manualReanalysisGuidRef.current === guid) {
            manualReanalysisGuidRef.current = null;
          }
        }

        if (result.status === 'ready') {
          // Cache even if the user moved on, so the map is restored when they come back.
          try {
            await cacheSkipMap(guid, result, targetEpisode.enclosureUrl);
          } catch (cacheErr) {
            console.warn('[playback] cacheSkipMap failed (non-fatal):', cacheErr);
          }
        }

        observe?.({ analyzeStatus: result.status, uploadProgress: null });
        if (!isCurrent()) {
          console.log('[playback] requestAnalyze: episode changed; not applying result for', guid);
          return result;
        }
        analyzeFingerprintRef.current = audioMd5 ? { episodeGuid: guid, audioMd5 } : null;
        setUploadProgress(null);
        setSkipMap(result);
        skipMapRef.current = result;
        setAnalyzeStatus(result.status);

        if (result.status === 'ready') {
          // Load settings and apply filter
          const settings = await getPodcastSkipSettings({
            collectionId: targetEpisode.collectionId,
            feedUrl: targetEpisode.feedUrl,
          });
          if (!isCurrent()) return result;
          setSkipSettingsState(settings);
          const filtered = applySkipFilter(result.segments, settings);
          player.setSkipSegments(filtered, guid);
          const warnings = detectAudioMismatch(targetEpisode, result);
          const summary = formatMismatchSummary(warnings);
          setAudioMismatchWarning(summary);
          if (summary) {
            console.warn('[playback] Audio mismatch detected:', summary, warnings);
          }
        }

        // Keep adDetectionEnabled true even if per-show is OFF — manual Prepare overrides.
        // This allows the segment sheet to open and auto-skip toggle to work on Prepare results.
        console.log('[playback] requestAnalyze: complete, keeping adDetectionEnabled=true');
        // queued/pending: shared poll effect below keeps ETA/stage fresh.
        return result;
      } catch (err: any) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error('[playback] Analyze (upload) failed:', err);
        if (manualReanalysisGuidRef.current === guid) {
          manualReanalysisGuidRef.current = null;
        }
        observe?.({ analyzeStatus: 'error', analyzeError: errorMsg, uploadProgress: null });
        if (isCurrent()) {
          setAnalyzeStatus('error');
          setAnalyzeError(errorMsg);
          setUploadProgress(null);
          setAudioMismatchWarning(null);
        }
        return null;
      } finally {
        // Clear flag so auto-analyze paths can run again (unless a newer Prepare owns it).
        if (manualPrepareGuidRef.current === guid) manualPrepareGuidRef.current = null;
      }
    },
    [applySkipFilter, canCallAdDetectionApi],
  );

  /** In-flight analyses by guid, so the same episode is never downloaded/uploaded twice at once. */
  const analyzeInFlightRef = useRef(new Map<string, Promise<SkipMap | null>>());
  const requestAnalyze = useCallback(
    (force = false, requestedEpisode?: Episode, observe?: AnalyzeObserver): Promise<SkipMap | null> => {
      const targetEpisode = requestedEpisode ?? episodeRef.current ?? episode;
      const guid = targetEpisode?.guid;
      if (!guid) return runAnalyze(force, targetEpisode, observe);
      const existing = analyzeInFlightRef.current.get(guid);
      // e.g. Prepare on an unstarted episode while play's auto-analyze is already running.
      if (existing) return existing;
      const run = runAnalyze(force, targetEpisode, observe).finally(() => {
        if (analyzeInFlightRef.current.get(guid) === run) analyzeInFlightRef.current.delete(guid);
      });
      analyzeInFlightRef.current.set(guid, run);
      return run;
    },
    [episode, runAnalyze],
  );
  requestAnalyzeForEpisodeRef.current = (target) => requestAnalyze(false, target);

  const prepareOpenedEpisode = useCallback(
    async (force = false) => {
      const opened = openedEpisodeRef.current;
      const ep = opened?.episode;
      if (!opened || !ep?.enclosureUrl) return;
      const busy = ['downloading', 'uploading', 'queued', 'pending'];
      if (opened.analyzeStatus && busy.includes(opened.analyzeStatus)) return;
      // Apply to this episode's preview only while it's still the one opened. Once it's
      // started (or closed) the player's own skip-map flow takes over.
      const update = (patch: Partial<OpenedEpisode>): boolean => {
        const cur = openedEpisodeRef.current;
        if (cur?.episode.guid !== ep.guid) return false;
        updateOpened({ ...cur, ...patch });
        return true;
      };

      const result = await requestAnalyze(force, ep, update);
      if (!result) return;
      if (result.status === 'ready') {
        update({ skipMap: result, analyzeStatus: 'ready', uploadProgress: null });
        return;
      }
      if (result.status !== 'queued' && result.status !== 'pending') return;

      // The server analyzes in the background: poll until it's done (stage/ETA meanwhile).
      update({ skipMap: result });
      const audioMd5 =
        result.audio_md5?.toLowerCase() ?? (await getCachedAudioMd5(ep.guid, ep.enclosureUrl));
      const started = Date.now();
      while (Date.now() - started < ANALYZE_POLL_MAX_MS) {
        await new Promise((r) => setTimeout(r, ANALYZE_POLL_INTERVAL_MS));
        if (openedEpisodeRef.current?.episode.guid !== ep.guid) return;
        let map: SkipMap;
        try {
          map = await getSkipMap(ep.guid, audioMd5);
        } catch {
          update({ analyzeStatus: 'offline' });
          return;
        }
        if (map.status === 'ready') {
          try {
            await cacheSkipMap(ep.guid, map, ep.enclosureUrl);
          } catch (cacheErr) {
            console.warn('[playback] cacheSkipMap failed (non-fatal):', cacheErr);
          }
          update({ skipMap: map, analyzeStatus: 'ready' });
          return;
        }
        if (map.status === 'error' || map.status === 'missing') {
          update({ skipMap: null, analyzeStatus: 'error', analyzeError: map.message || 'Analysis failed' });
          return;
        }
        update({ skipMap: map, analyzeStatus: map.status });
      }
    },
    [requestAnalyze, updateOpened],
  );

  // While analyze is in flight, poll skip-map for stage / ETA (Prepare + auto-queue).
  const analyzeInFlight =
    analyzeStatus === 'queued' || analyzeStatus === 'pending';

  useEffect(() => {
    const guid = episode?.guid;
    if (!guid || !analyzeInFlight) return;

    let cancelled = false;
    const started = Date.now();

    const tick = async () => {
      while (!cancelled && Date.now() - started < ANALYZE_POLL_MAX_MS) {
        await new Promise((r) => setTimeout(r, ANALYZE_POLL_INTERVAL_MS));
        if (cancelled) return;
        if (
          !(await canCallAdDetectionApi()) &&
          manualReanalysisGuidRef.current !== guid
        ) return;
        try {
          const fingerprint = analyzeFingerprintRef.current;
          const audioMd5 = fingerprint?.episodeGuid === guid ? fingerprint.audioMd5 : null;
          const map = await getSkipMap(guid, audioMd5);
          if (cancelled) return;
          // Ignore stale responses after episode switch.
          if (episodeRef.current?.guid !== guid) return;
          setSkipMap(map);
          skipMapRef.current = map;
          setAnalyzeStatus(map.status);
          if (map.status === 'ready') {
            try {
              await cacheSkipMap(guid, map, episodeRef.current?.enclosureUrl);
            } catch (cacheErr) {
              console.warn('[playback] cacheSkipMap failed (non-fatal):', cacheErr);
            }
            const ep = episodeRef.current;
            if (manualReanalysisGuidRef.current === guid) {
              manualReanalysisGuidRef.current = null;
            }
            if (ep?.guid === guid) {
              // Load settings and apply filter
              const settings = await getPodcastSkipSettings({
                collectionId: ep.collectionId,
                feedUrl: ep.feedUrl,
              });
              if (cancelled || episodeRef.current?.guid !== guid) return;
              const filtered = applySkipFilter(map.segments, settings);
              player.setSkipSegments(filtered, guid);
              const warnings = detectAudioMismatch(ep, map);
              const summary = formatMismatchSummary(warnings);
              setAudioMismatchWarning(summary);
              if (summary) {
                console.warn('[playback] Audio mismatch detected:', summary, warnings);
              }
            }
            return;
          }
          if (map.status === 'error' || map.status === 'missing') {
            if (manualReanalysisGuidRef.current === guid) {
              manualReanalysisGuidRef.current = null;
            }
            return;
          }
        } catch {
          if (manualReanalysisGuidRef.current === guid) {
            manualReanalysisGuidRef.current = null;
          }
          return;
        }
      }
      if (manualReanalysisGuidRef.current === guid) {
        manualReanalysisGuidRef.current = null;
      }
    };

    void tick();
    return () => {
      cancelled = true;
    };
  }, [analyzeInFlight, canCallAdDetectionApi, episode?.guid]);

  const value = useMemo(
    () => ({
      episode,
      isPlaying,
      positionMs,
      durationMs,
      playbackRate,
      autoSkip,
      adDetectionEnabled,
      skipMap,
      skipSettings,
      analyzeStatus,
      analyzeError,
      audioMismatchWarning,
      uploadProgress,
      playEpisode,
      playbackDownload,
      retryPlaybackDownload,
      streamWithoutSkipping,
      openedEpisode,
      openEpisode,
      startOpenedEpisode,
      seekOpenedEpisode,
      closeOpenedEpisode,
      prepareOpenedEpisode,
      restoreCurrentSkipMap,
      togglePlay,
      seek,
      cyclePlaybackRate,
      setAutoSkip,
      setPodcastAdDetection,
      setPodcastSkipSetting,
      requestAnalyze,
      clearCachedPlaybackData,
      setEpisodePlayed,
    }),
    [
      episode,
      isPlaying,
      positionMs,
      durationMs,
      playbackRate,
      autoSkip,
      adDetectionEnabled,
      skipMap,
      skipSettings,
      analyzeStatus,
      analyzeError,
      audioMismatchWarning,
      uploadProgress,
      playEpisode,
      playbackDownload,
      retryPlaybackDownload,
      streamWithoutSkipping,
      openedEpisode,
      openEpisode,
      startOpenedEpisode,
      seekOpenedEpisode,
      closeOpenedEpisode,
      prepareOpenedEpisode,
      restoreCurrentSkipMap,
      togglePlay,
      seek,
      cyclePlaybackRate,
      setAutoSkip,
      setPodcastAdDetection,
      setPodcastSkipSetting,
      requestAnalyze,
      clearCachedPlaybackData,
      setEpisodePlayed,
    ],
  );

  return <PlaybackContext.Provider value={value}>{children}</PlaybackContext.Provider>;
}

export function usePlayback(): Ctx {
  const ctx = useContext(PlaybackContext);
  if (!ctx) throw new Error('usePlayback must be used within PlaybackProvider');
  return ctx;
}
