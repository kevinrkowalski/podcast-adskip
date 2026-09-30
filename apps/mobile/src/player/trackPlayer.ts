/**
 * Audio playback facade using expo-audio (SDK 57).
 *
 * Supports background playback + lock-screen / notification controls when the
 * native module is present. Falls back to a stub clock so UI + skip-map
 * seeking still work without native audio.
 *
 * After programmatic seeks (ad-skip, scrub, ±15/30), UI position is pinned to
 * the seek target until native currentTime catches up — avoids scrubber lag.
 */

import { Platform } from 'react-native';
import type { AdSegment, Episode } from '@/src/types';
import { seekTargetIfInAd } from './skipLogic';

export type PlayerStatus = {
  isPlaying: boolean;
  positionMs: number;
  durationMs: number;
  playbackRate: number;
  episode: Episode | null;
};

type Listener = (status: PlayerStatus) => void;
type Backend = 'expo-audio' | 'stub';

type ExpoAudioPlayer = {
  play: () => void;
  pause: () => void;
  seekTo: (seconds: number) => Promise<void>;
  replace: (source: { uri: string }) => void;
  remove: () => void;
  currentTime: number;
  duration: number;
  playing: boolean;
  playbackRate?: number;
  setPlaybackRate?: (rate: number) => void;
  isLoaded: boolean;
  setActiveForLockScreen: (
    active: boolean,
    metadata?: {
      title?: string;
      artist?: string;
      albumTitle?: string;
      artworkUrl?: string;
    },
    options?: { showSeekForward?: boolean; showSeekBackward?: boolean },
  ) => void;
  clearLockScreenControls: () => void;
  addListener: (
    event: string,
    listener: (status: { playing?: boolean; currentTime?: number; duration?: number }) => void,
  ) => { remove: () => void };
};

type ExpoAudioMod = {
  createAudioPlayer: (
    source?: { uri: string } | string | null,
    options?: { updateInterval?: number },
  ) => ExpoAudioPlayer;
  setAudioModeAsync: (mode: {
    playsInSilentMode?: boolean;
    shouldPlayInBackground?: boolean;
    interruptionMode?: 'doNotMix' | 'duckOthers' | 'mixWithOthers';
  }) => Promise<void>;
  requestNotificationPermissionsAsync?: () => Promise<{ granted: boolean }>;
};

/** How close native position must be to clear a pending seek (ms). */
const SEEK_CATCHUP_MS = 1200;
/** Drop pending seek pin after this long even if native never matches. */
const SEEK_PIN_MAX_MS = 2500;

let status: PlayerStatus = {
  isPlaying: false,
  positionMs: 0,
  durationMs: 0,
  playbackRate: 1,
  episode: null,
};

const listeners = new Set<Listener>();
let tickTimer: ReturnType<typeof setInterval> | null = null;
let autoSkip = true;
let adDetectionEnabled = true;
let playbackRate = 1;
let segments: AdSegment[] = [];
let backend: Backend = 'stub';
let seeking = false;
/** Optimistic position after seek; overrides stale native reports until catch-up. */
let pendingSeekMs: number | null = null;
let pendingSeekAt = 0;
let audioModeReady = false;
let player: ExpoAudioPlayer | null = null;
let statusSub: { remove: () => void } | null = null;

function emit() {
  listeners.forEach((l) => l({ ...status }));
}

function clearPendingSeek() {
  pendingSeekMs = null;
  pendingSeekAt = 0;
}

/**
 * Apply a native-reported position. While a seek is pending, keep showing the
 * seek target until native catches up (or the pin times out).
 */
function applyNativePosition(rawMs: number) {
  if (pendingSeekMs != null) {
    const age = Date.now() - pendingSeekAt;
    if (Math.abs(rawMs - pendingSeekMs) <= SEEK_CATCHUP_MS || age >= SEEK_PIN_MAX_MS) {
      clearPendingSeek();
      status.positionMs = Math.max(0, rawMs);
    } else {
      status.positionMs = pendingSeekMs;
    }
    return;
  }
  status.positionMs = Math.max(0, rawMs);
}

function tryRequireExpoAudio(): ExpoAudioMod | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-audio') as ExpoAudioMod;
  } catch {
    return null;
  }
}

async function ensureAudioMode(mod: ExpoAudioMod): Promise<void> {
  if (audioModeReady) return;
  try {
    if (Platform.OS === 'android' && typeof mod.requestNotificationPermissionsAsync === 'function') {
      try {
        await mod.requestNotificationPermissionsAsync();
      } catch {
        /* optional on older builds */
      }
    }
    await mod.setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    });
    audioModeReady = true;
  } catch (e: any) {
    console.warn('[player] setAudioModeAsync failed:', e?.message ?? e);
  }
}

function syncFromNative() {
  if (!player || backend !== 'expo-audio') return;
  try {
    applyNativePosition(Math.floor((player.currentTime ?? 0) * 1000));
    const dur = Math.floor((player.duration ?? 0) * 1000);
    if (dur > 0) status.durationMs = dur;
    status.isPlaying = !!player.playing;
    if (typeof player.playbackRate === 'number' && Number.isFinite(player.playbackRate)) {
      playbackRate = player.playbackRate;
      status.playbackRate = playbackRate;
    }
  } catch {
    /* ignore */
  }
}

function applyPlaybackRate() {
  if (!player || backend !== 'expo-audio') return;
  try {
    if (typeof player.setPlaybackRate === 'function') {
      player.setPlaybackRate(playbackRate);
    } else if (typeof player.playbackRate === 'number') {
      player.playbackRate = playbackRate;
    }
  } catch (e: any) {
    console.warn('[player] setPlaybackRate failed:', e?.message ?? e);
  }
}

function activateLockScreen(episode: Episode) {
  if (!player) return;
  try {
    player.setActiveForLockScreen(
      true,
      {
        title: episode.title,
        artist: episode.podcastTitle ?? 'Podcast',
        albumTitle: episode.podcastTitle,
        artworkUrl: episode.artworkUrl,
      },
      { showSeekForward: true, showSeekBackward: true },
    );
  } catch (e: any) {
    console.warn('[player] setActiveForLockScreen:', e?.message ?? e);
  }
}

function releasePlayer() {
  if (statusSub) {
    try {
      statusSub.remove();
    } catch {
      /* ignore */
    }
    statusSub = null;
  }
  if (player) {
    try {
      player.clearLockScreenControls();
    } catch {
      /* ignore */
    }
    try {
      player.pause();
    } catch {
      /* ignore */
    }
    try {
      player.remove();
    } catch {
      /* ignore */
    }
    player = null;
  }
  clearPendingSeek();
}

function startTick() {
  if (tickTimer) return;
  tickTimer = setInterval(async () => {
    if (seeking) {
      // Keep UI pinned to pending seek target while native seek runs.
      if (pendingSeekMs != null) status.positionMs = pendingSeekMs;
      emit();
      return;
    }
    if (backend === 'stub') {
      if (!status.isPlaying) {
        emit();
        return;
      }
      // Stub advances from pinned/current position.
      const base = pendingSeekMs != null ? pendingSeekMs : status.positionMs;
      if (pendingSeekMs != null) clearPendingSeek();
      status.positionMs = Math.min(
        base + Math.round(500 * playbackRate),
        status.durationMs || base + Math.round(500 * playbackRate),
      );
    } else if (backend === 'expo-audio') {
      syncFromNative();
    }

    if (autoSkip && adDetectionEnabled && segments.length && status.isPlaying && pendingSeekMs == null) {
      const target = seekTargetIfInAd(status.positionMs, segments);
      if (target != null) {
        await seekTo(target);
      }
    }
    emit();
  }, 250);
}

function stopTick() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

export function subscribePlayer(listener: Listener): () => void {
  listeners.add(listener);
  listener({ ...status });
  return () => {
    listeners.delete(listener);
  };
}

export function setAutoSkip(enabled: boolean) {
  autoSkip = enabled;
}

export function getAutoSkip(): boolean {
  return autoSkip;
}

export function setAdDetectionEnabled(enabled: boolean) {
  adDetectionEnabled = enabled;
}

export function setSkipSegments(segs: AdSegment[]) {
  segments = segs ?? [];
}

export function getBackend(): Backend {
  return backend;
}

export type LoadPlayOptions = {
  /** Resume from a previously persisted position (ms). */
  startPositionMs?: number;
};

export async function loadAndPlay(
  episode: Episode,
  opts?: LoadPlayOptions,
): Promise<void> {
  clearPendingSeek();
  const startMs =
    opts?.startPositionMs != null && opts.startPositionMs > 0
      ? Math.floor(opts.startPositionMs)
      : 0;
  status.episode = episode;
  status.positionMs = startMs;
  status.durationMs = episode.durationMs ?? 0;
  status.isPlaying = false;
  emit();

  const url = episode.enclosureUrl;
  if (!url) {
    releasePlayer();
    backend = 'stub';
    status.isPlaying = true;
    if (!status.durationMs) status.durationMs = 30 * 60 * 1000;
    if (startMs > 0) status.positionMs = startMs;
    startTick();
    emit();
    return;
  }

  const mod = tryRequireExpoAudio();
  if (mod && typeof mod.createAudioPlayer === 'function') {
    try {
      await ensureAudioMode(mod);
      releasePlayer();
      player = mod.createAudioPlayer({ uri: url }, { updateInterval: 250 });
      statusSub = player.addListener('playbackStatusUpdate', (st) => {
        if (seeking) {
          if (pendingSeekMs != null) status.positionMs = pendingSeekMs;
          emit();
          return;
        }
        if (typeof st.currentTime === 'number') {
          applyNativePosition(Math.floor(st.currentTime * 1000));
        }
        if (typeof st.duration === 'number' && st.duration > 0) {
          status.durationMs = Math.floor(st.duration * 1000);
        }
        if (typeof st.playing === 'boolean') {
          status.isPlaying = st.playing;
        }
        if (typeof (st as { playbackRate?: number }).playbackRate === 'number') {
          playbackRate = (st as { playbackRate: number }).playbackRate;
          status.playbackRate = playbackRate;
        }
        emit();
      });
      activateLockScreen(episode);
      applyPlaybackRate();
      player.play();
      backend = 'expo-audio';
      status.isPlaying = true;
      startTick();
      emit();
      if (startMs > 0) {
        // Seek after play so native player has a chance to load the URI.
        await seekTo(startMs);
      }
      return;
    } catch (e: any) {
      console.warn('[player] expo-audio load failed, falling back to stub:', e?.message ?? e);
      releasePlayer();
    }
  }

  console.warn('[player] no native audio — stub playback clock (UI + skip logic only)');
  backend = 'stub';
  status.isPlaying = true;
  if (!status.durationMs) status.durationMs = 30 * 60 * 1000;
  if (startMs > 0) status.positionMs = startMs;
  startTick();
  emit();
}

export async function play(): Promise<void> {
  if (backend === 'expo-audio' && player) {
    try {
      if (status.episode) activateLockScreen(status.episode);
      player.play();
    } catch (e: any) {
      console.warn('[player] play failed:', e?.message ?? e);
    }
  }
  status.isPlaying = true;
  startTick();
  emit();
}

export async function pause(): Promise<void> {
  if (backend === 'expo-audio' && player) {
    try {
      player.pause();
    } catch (e: any) {
      console.warn('[player] pause failed:', e?.message ?? e);
    }
  }
  status.isPlaying = false;
  emit();
}

export async function seekTo(positionMs: number): Promise<void> {
  const target = Math.max(0, Math.floor(positionMs));
  const capped =
    status.durationMs > 0 ? Math.min(target, status.durationMs) : target;

  seeking = true;
  pendingSeekMs = capped;
  pendingSeekAt = Date.now();
  status.positionMs = capped;
  emit();

  try {
    if (backend === 'expo-audio' && player) {
      await player.seekTo(capped / 1000);
      // Re-assert after native seek; status updates may still be stale briefly.
      status.positionMs = capped;
      pendingSeekMs = capped;
      pendingSeekAt = Date.now();
      emit();
    } else {
      // Stub: position is already set; clear pin so tick advances from here.
      clearPendingSeek();
      status.positionMs = capped;
      emit();
    }
  } catch (e: any) {
    console.warn('[player] seekTo failed:', e?.message ?? e);
    clearPendingSeek();
  } finally {
    seeking = false;
  }
}

export function getPlaybackRate(): number {
  return playbackRate;
}

export function setPlaybackRate(rate: number): void {
  if (rate !== 1 && rate !== 1.5 && rate !== 2) return;
  playbackRate = rate;
  status.playbackRate = rate;
  applyPlaybackRate();
  emit();
}

export function getStatus(): PlayerStatus {
  return { ...status };
}

export async function teardown(): Promise<void> {
  stopTick();
  releasePlayer();
  backend = 'stub';
  status = {
    isPlaying: false,
    positionMs: 0,
    durationMs: 0,
    playbackRate,
    episode: null,
  };
  emit();
}
