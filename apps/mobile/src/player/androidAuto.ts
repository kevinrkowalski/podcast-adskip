import { NativeModule, requireNativeModule } from 'expo';
import { Platform } from 'react-native';
import type { Episode, Subscription } from '@/src/types';

export type AndroidAutoStatus = {
  episodeJson: string | null;
  positionMs: number;
  durationMs: number;
  isPlaying: boolean;
  playbackRate: number;
};

type AndroidAutoEvents = {
  onPlaybackStatus: (status: AndroidAutoStatus) => void;
};

declare class PodcastAutoNativeModule extends NativeModule<AndroidAutoEvents> {
  setCatalog: (catalogJson: string) => void;
  loadAndPlay: (episodeJson: string, localFilePath: string | null, startPositionMs: number) => void;
  play: () => void;
  pause: () => void;
  seekTo: (positionMs: number) => void;
  setPlaybackRate: (rate: number) => void;
  setAutoSkip: (enabled: boolean) => void;
  setAdDetectionEnabled: (enabled: boolean) => void;
  setSkipSegments: (segmentsJson: string, episodeGuid: string | null) => void;
  getStatus: () => AndroidAutoStatus;
}

let nativeModule: PodcastAutoNativeModule | null | undefined;

function getNativeModule(): PodcastAutoNativeModule | null {
  if (Platform.OS !== 'android') return null;
  if (nativeModule !== undefined) return nativeModule;
  try {
    nativeModule = requireNativeModule<PodcastAutoNativeModule>('PodcastAuto');
  } catch (error) {
    console.warn('[android-auto] Native playback module is unavailable in this build:', error);
    nativeModule = null;
  }
  return nativeModule;
}

export function isAndroidAutoPlaybackAvailable(): boolean {
  return getNativeModule() !== null;
}

export function setAndroidAutoCatalog(
  subscriptions: Subscription[],
  episodesByFeed: Record<string, Episode[]>,
): void {
  const native = getNativeModule();
  if (!native) return;
  const catalog = subscriptions.map((subscription) => ({
    collectionId: subscription.collectionId,
    title: subscription.collectionName,
    artist: subscription.artistName,
    feedUrl: subscription.feedUrl,
    artworkUrl: subscription.artworkUrl,
    episodes: episodesByFeed[subscription.feedUrl] ?? [],
  }));
  try {
    native.setCatalog(JSON.stringify({ podcasts: catalog }));
  } catch (error) {
    console.warn('[android-auto] Could not publish podcast catalog:', error);
  }
}

export function loadAndroidAutoEpisode(
  episode: Episode,
  localFilePath: string | undefined,
  startPositionMs: number,
): void {
  getNativeModule()?.loadAndPlay(
    JSON.stringify(episode),
    localFilePath ?? null,
    Math.max(0, Math.floor(startPositionMs)),
  );
}

export function controlAndroidAutoPlayer(
  action: 'play' | 'pause' | 'seek' | 'rate',
  value?: number,
): void {
  const native = getNativeModule();
  if (!native) return;
  if (action === 'play') native.play();
  else if (action === 'pause') native.pause();
  else if (action === 'seek') native.seekTo(Math.max(0, Math.floor(value ?? 0)));
  else if (action === 'rate' && value != null) native.setPlaybackRate(value);
}

export function configureAndroidAutoSkip(options: {
  autoSkip?: boolean;
  adDetectionEnabled?: boolean;
  segments?: unknown[];
  episodeGuid?: string | null;
}): void {
  const native = getNativeModule();
  if (!native) return;
  if (options.autoSkip != null) native.setAutoSkip(options.autoSkip);
  if (options.adDetectionEnabled != null) {
    native.setAdDetectionEnabled(options.adDetectionEnabled);
  }
  if (options.segments != null) {
    native.setSkipSegments(JSON.stringify(options.segments), options.episodeGuid ?? null);
  }
}

export function getAndroidAutoStatus(): AndroidAutoStatus | null {
  return getNativeModule()?.getStatus() ?? null;
}

export function subscribeAndroidAutoStatus(
  listener: (status: AndroidAutoStatus) => void,
): (() => void) | null {
  const native = getNativeModule();
  if (!native) return null;
  const subscription = native.addListener('onPlaybackStatus', listener);
  return () => subscription.remove();
}
