import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Episode, SkipMap } from '@/src/types';
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
  type AdDetectionTarget,
} from '@/src/db/storage';

type Ctx = {
  episode: Episode | null;
  isPlaying: boolean;
  positionMs: number;
  durationMs: number;
  playbackRate: number;
  autoSkip: boolean;
  adDetectionEnabled: boolean;
  skipMap: SkipMap | null;
  analyzeStatus: string | null;
  playEpisode: (ep: Episode) => Promise<void>;
  togglePlay: () => Promise<void>;
  seek: (ms: number) => Promise<void>;
  cyclePlaybackRate: () => void;
  setAutoSkip: (v: boolean) => Promise<void>;
  setPodcastAdDetection: (target: AdDetectionTarget, enabled: boolean) => Promise<void>;
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
  const [analyzeStatus, setAnalyzeStatus] = useState<string | null>(null);

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
    setAdDetectionEnabledState(false);
    setSkipMap(null);
    skipMapRef.current = null;
    setAnalyzeStatus(status);
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
   * Abort an in-flight skip-map load without wiping a cached ready map.
   * Toggling global auto-skip off mid-await used to call clearAdDetection() and
   * permanently break the segment sheet until a full re-analyze.
   */
  const abortLoadKeepCache = useCallback(() => {
    setAdDetectionEnabledState(false);
    player.setAdDetectionEnabled(false);
    // Leave skipMap / analyzeStatus / player segments intact.
  }, []);

  const loadSkipMap = useCallback(async (ep: Episode, enabled: boolean): Promise<SkipMap | null> => {
    const gen = skipLoadGen.current;
    const stillCurrent = () => gen === skipLoadGen.current;

    if (!enabled) {
      // playEpisode already cleared map when switching episodes; do not wipe here.
      abortLoadKeepCache();
      return null;
    }
    if (!(await canUseAdDetection(ep))) {
      if (!(await getAutoSkipEnabled())) {
        // Global toggle raced off — keep cached segments for the sheet.
        abortLoadKeepCache();
        return null;
      }
      // Per-show detection off.
      clearAdDetection();
      return null;
    }
    if (!stillCurrent()) return null;

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
      player.setSkipSegments(local.segments);
      setAnalyzeStatus('ready');
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
        await cacheSkipMap(ep.guid, remote);
        if (!stillCurrent()) return null;
        player.setSkipSegments(remote.segments);
        setAnalyzeStatus('ready');
      } else {
        setAnalyzeStatus(remote.status);
        player.setSkipSegments([]);
      }
      return remote;
    } catch {
      if (!stillCurrent()) return null;
      setAnalyzeStatus('offline');
      player.setSkipSegments([]);
      return null;
    }
  }, [abortLoadKeepCache, canUseAdDetection, clearAdDetection]);

  const playEpisode = useCallback(
    async (ep: Episode) => {
      // Save previous episode position before switching.
      await persistPosition(true);

      setEpisode(ep);
      episodeRef.current = ep;
      setSkipMap(null);
      skipMapRef.current = null;
      setAnalyzeStatus(null);
      skipLoadGen.current += 1;

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
      if (!detectionEnabled) player.setSkipSegments([]);

      const saved = await getPlaybackPosition(ep.guid);
      const startPositionMs = saved?.positionMs ?? 0;

      await player.loadAndPlay(ep, { startPositionMs });
      lastSavedAt.current = Date.now();
      lastSavedPos.current = startPositionMs;
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
    },
    [canUseAdDetection, clearAdDetection, loadSkipMap, persistPosition],
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
        setSkipMap(cached);
        player.setSkipSegments(cached.segments ?? []);
        setAnalyzeStatus('ready');
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
            await cacheSkipMap(current.guid, queued);
            if (gen !== skipLoadGen.current) return;
            player.setSkipSegments(queued.segments);
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

  // Explicit Prepare / force-analyze: gated by global Settings only.
  // Per-show "Ad detection for this show" OFF still allows user-initiated analyze;
  // that flag only blocks auto-analyze on play (see playEpisode / setAutoSkip).
  const requestAnalyze = useCallback(
    async (force = false) => {
      if (!episode?.enclosureUrl) return;
      if (!(await canCallAdDetectionApi())) {
        // Global kill-switch: no ad-detection API calls.
        return;
      }
      setAdDetectionEnabledState(true);
      player.setAdDetectionEnabled(true);
      setAnalyzeStatus('queued');
      try {
        if (!(await canCallAdDetectionApi())) {
          return;
        }
        const result = await analyzeEpisode({
          episode_guid: episode.guid,
          audio_url: episode.enclosureUrl,
          title: episode.title,
          duration_ms: episode.durationMs,
          feed_url: episode.feedUrl,
          force,
          sync: false,
        });
        setSkipMap(result);
        skipMapRef.current = result;
        setAnalyzeStatus(result.status);
        if (result.status === 'ready') {
          await cacheSkipMap(episode.guid, result);
          player.setSkipSegments(result.segments);
        }
        // queued/pending: shared poll effect below keeps ETA/stage fresh.
      } catch {
        setAnalyzeStatus('error');
      }
    },
    [canCallAdDetectionApi, episode],
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
            await cacheSkipMap(guid, map);
            player.setSkipSegments(map.segments);
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
      analyzeStatus,
      playEpisode,
      togglePlay,
      seek,
      cyclePlaybackRate,
      setAutoSkip,
      setPodcastAdDetection,
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
      analyzeStatus,
      playEpisode,
      togglePlay,
      seek,
      cyclePlaybackRate,
      setAutoSkip,
      setPodcastAdDetection,
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
