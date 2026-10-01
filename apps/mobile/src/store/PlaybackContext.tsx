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
import { analyzeEpisode, getSkipMap } from '@/src/api/backend';
import {
  cacheSkipMap,
  getAutoSkipEnabled,
  getCachedSkipMap,
  getPlaybackPosition,
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
  downloadAudioForAnalysis,
  uploadAudioForAnalysis,
  getCachedAudioPath,
  type DownloadProgress,
  type UploadProgress,
} from '@/src/api/audioUpload';
import { getApiBaseUrl, getResolvedAppKey } from '@/src/api/backend';
import { filterSkippableSegments, normalizeSegment } from '@/src/player/skipLogic';

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
  playEpisode: (ep: Episode) => Promise<void>;
  togglePlay: () => Promise<void>;
  seek: (ms: number) => Promise<void>;
  cyclePlaybackRate: () => void;
  setAutoSkip: (v: boolean) => Promise<void>;
  setPodcastAdDetection: (target: AdDetectionTarget, enabled: boolean) => Promise<void>;
  setPodcastSkipSetting: (target: AdDetectionTarget, settings: Partial<PodcastSkipSettings>) => Promise<void>;
  requestAnalyze: (force?: boolean) => Promise<void>;
};

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

  const episodeRef = useRef<Episode | null>(null);
  const positionRef = useRef(0);
  const durationRef = useRef(0);
  const isPlayingRef = useRef(false);
  const lastSavedAt = useRef(0);
  const lastSavedPos = useRef(-1);
  /** Mirrors skipMap so setAutoSkip can restore without a stale closure. */
  const skipMapRef = useRef<SkipMap | null>(null);
  /** Bumped on auto-skip toggle to invalidate in-flight loadSkipMap work. */
  const skipLoadGen = useRef(0);
  /** True while requestAnalyze (manual Prepare) is in flight; prevents loadSkipMap/clearAdDetection from clobbering. */
  const manualPrepareInFlight = useRef(false);

  const persistPosition = useCallback(async (force = false) => {
    const ep = episodeRef.current;
    if (!ep?.guid) return;
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
    return player.subscribePlayer((st) => {
      episodeRef.current = st.episode;
      positionRef.current = st.positionMs;
      durationRef.current = st.durationMs;
      isPlayingRef.current = st.isPlaying;
      setEpisode(st.episode);
      setIsPlaying(st.isPlaying);
      setPositionMs(st.positionMs);
      setDurationMs(st.durationMs);
      setPlaybackRateState(st.playbackRate);

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

  const clearAdDetection = useCallback((status = 'disabled') => {
    // Never clear while manual Prepare is running — Prepare must show progress and complete.
    if (manualPrepareInFlight.current) {
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
  }, []);

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
    if (manualPrepareInFlight.current) {
      console.log('[playback] abortLoadKeepCache blocked: manual prepare in flight');
      return;
    }
    setAdDetectionEnabledState(false);
    player.setAdDetectionEnabled(false);
    // Leave skipMap / analyzeStatus / player segments intact.
  }, []);

  const loadSkipMap = useCallback(async (ep: Episode, enabled: boolean): Promise<SkipMap | null> => {
    const gen = skipLoadGen.current;
    const stillCurrent = () => gen === skipLoadGen.current;

    if (!enabled) {
      // Detection is off for this show, but still load cached maps (from manual Prepare).
      // We won't auto-analyze, but we should restore and filter any existing ready map.
      abortLoadKeepCache();
      
      // Load skip settings for filtering
      const settings = await getPodcastSkipSettings({
        collectionId: ep.collectionId,
        feedUrl: ep.feedUrl,
      });
      if (!stillCurrent()) return null;
      setSkipSettingsState(settings);
      
      // Try to load cached skip map (from previous manual Prepare)
      const local = await getCachedSkipMap(ep.guid);
      if (!stillCurrent()) return null;
      
      if (local?.status === 'ready') {
        setSkipMap(local);
        skipMapRef.current = local;
        const filtered = applySkipFilter(local.segments, settings);
        player.setSkipSegments(filtered);
        setAnalyzeStatus('ready');
        const warnings = detectAudioMismatch(ep, local);
        const summary = formatMismatchSummary(warnings);
        setAudioMismatchWarning(summary);
        if (summary) {
          console.warn('[playback] Audio mismatch detected:', summary, warnings);
        }
        return local;
      }
      
      // No cached map and detection is off — clear segments and return
      player.setSkipSegments([]);
      return null;
    }
    if (!(await canUseAdDetection(ep))) {
      if (!(await getAutoSkipEnabled())) {
        // Global toggle raced off — keep cached segments for the sheet.
        abortLoadKeepCache();
        return null;
      }
      // Per-show detection off — same logic as above (load cached, no auto-analyze)
      const settings = await getPodcastSkipSettings({
        collectionId: ep.collectionId,
        feedUrl: ep.feedUrl,
      });
      if (!stillCurrent()) return null;
      setSkipSettingsState(settings);
      
      const local = await getCachedSkipMap(ep.guid);
      if (!stillCurrent()) return null;
      
      if (local?.status === 'ready') {
        setSkipMap(local);
        skipMapRef.current = local;
        const filtered = applySkipFilter(local.segments, settings);
        player.setSkipSegments(filtered);
        setAnalyzeStatus('ready');
        const warnings = detectAudioMismatch(ep, local);
        const summary = formatMismatchSummary(warnings);
        setAudioMismatchWarning(summary);
        if (summary) {
          console.warn('[playback] Audio mismatch detected:', summary, warnings);
        }
        return local;
      }
      
      clearAdDetection();
      return null;
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
    const local = await getCachedSkipMap(ep.guid);
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
    if (local?.status === 'ready') {
      setSkipMap(local);
      skipMapRef.current = local;
      // Apply skip filter before passing to player
      const filtered = applySkipFilter(local.segments, settings);
      player.setSkipSegments(filtered);
      setAnalyzeStatus('ready');
      const warnings = detectAudioMismatch(ep, local);
      const summary = formatMismatchSummary(warnings);
      setAudioMismatchWarning(summary);
      if (summary) {
        console.warn('[playback] Audio mismatch detected:', summary, warnings);
      }
      return local;
    }
    try {
      const remote = await getSkipMap(ep.guid);
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
      setSkipMap(remote);
      skipMapRef.current = remote;
      if (remote.status === 'ready') {
        try {
          await cacheSkipMap(ep.guid, remote);
        } catch (cacheErr) {
          console.warn('[playback] cacheSkipMap failed (non-fatal):', cacheErr);
        }
        if (!stillCurrent()) return null;
        // Apply skip filter before passing to player
        const filtered = applySkipFilter(remote.segments, settings);
        player.setSkipSegments(filtered);
        setAnalyzeStatus('ready');
        const warnings = detectAudioMismatch(ep, remote);
        const summary = formatMismatchSummary(warnings);
        setAudioMismatchWarning(summary);
        if (summary) {
          console.warn('[playback] Audio mismatch detected:', summary, warnings);
        }
      } else {
        setAnalyzeStatus(remote.status);
        player.setSkipSegments([]);
        setAudioMismatchWarning(null);
      }
      return remote;
    } catch {
      if (!stillCurrent()) return null;
      setAnalyzeStatus('offline');
      player.setSkipSegments([]);
      return null;
    }
  }, [abortLoadKeepCache, applySkipFilter, canUseAdDetection, clearAdDetection]);

  const playEpisode = useCallback(
    async (ep: Episode) => {
      // Snapshot previous position, then switch React state BEFORE any await so
      // concurrent navigation to Now Playing never flashes the empty state.
      const prev = episodeRef.current;
      const prevPos = positionRef.current;
      const prevDur = durationRef.current;

      setEpisode(ep);
      episodeRef.current = ep;
      setSkipMap(null);
      skipMapRef.current = null;
      setSkipSettingsState(null);
      setAnalyzeStatus(null);
      setAnalyzeError(null);
      setAudioMismatchWarning(null);
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

      const detectionEnabled = autoSkipOn
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
      const startPositionMs = saved?.positionMs ?? 0;

      // Check if we have a locally cached audio file (from previous Prepare).
      // If so, play from cache to ensure we play the SAME audio we analyzed.
      let localFilePath: string | null = null;
      if (ep.enclosureUrl) {
        try {
          localFilePath = await getCachedAudioPath(ep.guid, ep.enclosureUrl);
          if (localFilePath) {
            console.log('[playback] Using cached audio file for playback:', localFilePath);
          }
        } catch (err) {
          console.warn('[playback] Failed to check cached audio, will stream:', err);
          localFilePath = null;
        }
      }

      try {
        await player.loadAndPlay(ep, { startPositionMs, localFilePath: localFilePath || undefined });
        lastSavedAt.current = Date.now();
        lastSavedPos.current = startPositionMs;
      } catch (err) {
        console.error('[playback] Failed to load and play episode:', err);
        // Continue with skip map loading even if player fails (stub mode may still work)
      }
      
      // Load skip map and auto-analyze in parallel without blocking return.
      // This ensures UI navigation happens immediately while analysis proceeds in background.
      void (async () => {
        try {
          await loadSkipMap(ep, detectionEnabled);
          // Fire-and-forget analyze if no map yet, but only while both gates are on.
          if (detectionEnabled && ep.enclosureUrl) {
            try {
              if (!(await canUseAdDetection(ep))) {
                clearAdDetection();
                return;
              }
              const existing = await getSkipMap(ep.guid);
              if (existing.status === 'missing' || existing.status === 'error') {
                setAnalyzeStatus('queued');
                const queued = await analyzeEpisode({
                  episode_guid: ep.guid,
                  audio_url: ep.enclosureUrl,
                  title: ep.title,
                  duration_ms: ep.durationMs,
                  feed_url: ep.feedUrl,
                });
                setSkipMap(queued);
                skipMapRef.current = queued;
                setAnalyzeStatus(queued.status);
              }
            } catch {
              /* backend optional while browsing */
            }
          }
        } catch (err) {
          console.warn('[playback] Skip map loading failed:', err);
        }
      })();
    },
    [canUseAdDetection, clearAdDetection, loadSkipMap],
  );

  const togglePlay = useCallback(async () => {
    if (isPlayingRef.current) {
      await player.pause();
      await persistPosition(true);
    } else {
      await player.play();
    }
  }, [persistPosition]);

  const seek = useCallback(
    async (ms: number) => {
      await player.seekTo(ms);
      positionRef.current = ms;
      await persistPosition(true);
    },
    [persistPosition],
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
      setAdDetectionEnabledState(podcastEnabled);
      player.setAdDetectionEnabled(podcastEnabled);
      if (!podcastEnabled) {
        clearAdDetection();
        return;
      }

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
        player.setSkipSegments(filtered);
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
          setAnalyzeStatus('queued');
          const queued = await analyzeEpisode({
            episode_guid: current.guid,
            audio_url: current.enclosureUrl,
            title: current.title,
            duration_ms: current.durationMs,
            feed_url: current.feedUrl,
          });
          if (gen !== skipLoadGen.current) return;
          setSkipMap(queued);
          skipMapRef.current = queued;
          setAnalyzeStatus(queued.status);
          if (queued.status === 'ready') {
            try {
              await cacheSkipMap(current.guid, queued);
            } catch (cacheErr) {
              console.warn('[playback] cacheSkipMap failed (non-fatal):', cacheErr);
            }
            if (gen !== skipLoadGen.current) return;
            // Load settings and apply filter
            const settings = await getPodcastSkipSettings({
              collectionId: current.collectionId,
              feedUrl: current.feedUrl,
            });
            if (gen !== skipLoadGen.current) return;
            const filtered = applySkipFilter(queued.segments, settings);
            player.setSkipSegments(filtered);
            const warnings = detectAudioMismatch(current, queued);
            const summary = formatMismatchSummary(warnings);
            setAudioMismatchWarning(summary);
            if (summary) {
              console.warn('[playback] Audio mismatch detected:', summary, warnings);
            }
          }
        } catch {
          if (gen !== skipLoadGen.current) return;
          setAnalyzeStatus('offline');
        }
      }
    }
  }, [canUseAdDetection, clearAdDetection, loadSkipMap]);

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
        setSkipMap(null);
        skipMapRef.current = null;
        setAnalyzeStatus(null);
        player.setSkipSegments([]);
      }
    },
    [clearAdDetection],
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
        player.setSkipSegments(filtered);
      }
    },
    [applySkipFilter],
  );

  // Explicit Prepare / force-analyze: gated by global Settings only.
  // Per-show "Ad detection for this show" OFF still allows user-initiated analyze;
  // that flag only blocks auto-analyze on play (see playEpisode / setAutoSkip).
  // 
  // Uses client-side download + upload to ensure analyzed audio matches playback.
  const requestAnalyze = useCallback(
    async (force = false) => {
      if (!episode?.enclosureUrl) {
        console.warn('[playback] requestAnalyze: no episode or enclosureUrl');
        return;
      }
      if (!(await canCallAdDetectionApi())) {
        // Global kill-switch: no ad-detection API calls.
        console.log('[playback] requestAnalyze: blocked by global kill-switch');
        return;
      }
      
      console.log('[playback] requestAnalyze: starting download/upload flow for', episode.guid);
      
      // Set flag to prevent loadSkipMap / clearAdDetection from clobbering this manual prepare.
      manualPrepareInFlight.current = true;
      
      // Immediately update UI state so user sees feedback
      setAdDetectionEnabledState(true);
      player.setAdDetectionEnabled(true);
      setAnalyzeStatus('downloading');
      setAnalyzeError(null);
      setUploadProgress({ downloaded: 0, uploaded: 0, total: 100 });
      setAudioMismatchWarning(null);
      
      try {
        // Re-check global setting after state updates
        if (!(await canCallAdDetectionApi())) {
          console.log('[playback] requestAnalyze: global kill-switch turned off during setup');
          setAnalyzeStatus('disabled');
          setUploadProgress(null);
          return;
        }
        
        // Download audio locally
        console.log('[playback] requestAnalyze: downloading audio');
        const localPath = await downloadAudioForAnalysis(
          episode.guid,
          episode.enclosureUrl,
          (progress: DownloadProgress) => {
            const pct = progress.totalBytesExpectedToWrite > 0
              ? (progress.totalBytesWritten / progress.totalBytesExpectedToWrite) * 50 // 0-50% for download
              : 0;
            setUploadProgress({
              downloaded: Math.round(pct),
              uploaded: 0,
              total: progress.totalBytesExpectedToWrite,
            });
          },
        );
        
        console.log('[playback] requestAnalyze: download complete, uploading to API');
        setAnalyzeStatus('uploading');
        
        // Upload to API for analysis
        const result = await uploadAudioForAnalysis(
          getApiBaseUrl(),
          getResolvedAppKey(),
          localPath,
          {
            episodeGuid: episode.guid,
            audioUrl: episode.enclosureUrl,
            title: episode.title,
            durationMs: episode.durationMs,
            feedUrl: episode.feedUrl,
            force,
          },
          (progress: UploadProgress) => {
            const pct = progress.totalBytesExpectedToSend > 0
              ? 50 + (progress.totalBytesSent / progress.totalBytesExpectedToSend) * 50 // 50-100% for upload
              : 50;
            setUploadProgress((prev) => ({
              downloaded: 50,
              uploaded: Math.round(pct - 50),
              total: prev?.total || progress.totalBytesExpectedToSend,
            }));
          },
        );
        
        console.log('[playback] requestAnalyze: upload complete, status:', result.status);
        setUploadProgress(null);
        setSkipMap(result);
        skipMapRef.current = result;
        setAnalyzeStatus(result.status);
        
        if (result.status === 'ready') {
          // Cache skip map; don't let storage failure break the analyze flow.
          try {
            await cacheSkipMap(episode.guid, result);
          } catch (cacheErr) {
            console.warn('[playback] cacheSkipMap failed (non-fatal):', cacheErr);
          }
          // Load settings and apply filter
          const settings = await getPodcastSkipSettings({
            collectionId: episode.collectionId,
            feedUrl: episode.feedUrl,
          });
          setSkipSettingsState(settings);
          const filtered = applySkipFilter(result.segments, settings);
          player.setSkipSegments(filtered);
          const warnings = detectAudioMismatch(episode, result);
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
      } catch (err: any) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error('[playback] Analyze (upload) failed:', err);
        setAnalyzeStatus('error');
        setAnalyzeError(errorMsg);
        setUploadProgress(null);
        setAudioMismatchWarning(null);
      } finally {
        // Clear flag so auto-analyze paths can run again.
        manualPrepareInFlight.current = false;
      }
    },
    [applySkipFilter, canCallAdDetectionApi, episode],
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
        if (!(await canCallAdDetectionApi())) return;
        try {
          const map = await getSkipMap(guid);
          if (cancelled) return;
          // Ignore stale responses after episode switch.
          if (episodeRef.current?.guid !== guid) return;
          setSkipMap(map);
          skipMapRef.current = map;
          setAnalyzeStatus(map.status);
          if (map.status === 'ready') {
            try {
              await cacheSkipMap(guid, map);
            } catch (cacheErr) {
              console.warn('[playback] cacheSkipMap failed (non-fatal):', cacheErr);
            }
            const ep = episodeRef.current;
            if (ep) {
              // Load settings and apply filter
              const settings = await getPodcastSkipSettings({
                collectionId: ep.collectionId,
                feedUrl: ep.feedUrl,
              });
              const filtered = applySkipFilter(map.segments, settings);
              player.setSkipSegments(filtered);
              const warnings = detectAudioMismatch(ep, map);
              const summary = formatMismatchSummary(warnings);
              setAudioMismatchWarning(summary);
              if (summary) {
                console.warn('[playback] Audio mismatch detected:', summary, warnings);
              }
            }
            return;
          }
          if (map.status === 'error' || map.status === 'missing') return;
        } catch {
          return;
        }
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
      togglePlay,
      seek,
      cyclePlaybackRate,
      setAutoSkip,
      setPodcastAdDetection,
      setPodcastSkipSetting,
      requestAnalyze,
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
      togglePlay,
      seek,
      cyclePlaybackRate,
      setAutoSkip,
      setPodcastAdDetection,
      setPodcastSkipSetting,
      requestAnalyze,
    ],
  );

  return <PlaybackContext.Provider value={value}>{children}</PlaybackContext.Provider>;
}

export function usePlayback(): Ctx {
  const ctx = useContext(PlaybackContext);
  if (!ctx) throw new Error('usePlayback must be used within PlaybackProvider');
  return ctx;
}
