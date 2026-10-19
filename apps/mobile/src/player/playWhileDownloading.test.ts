/// <reference types="jest" />
import type { Episode } from '@/src/types';

// The native service plays the stream while saving the same bytes. Skips must not apply
// until the save is complete and verified: only then does the loaded episode count as
// playing its downloaded copy.

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));

const mockNative = {
  listener: null as null | ((status: unknown) => void),
  load: jest.fn(),
};

jest.mock('./androidAuto', () => ({
  isAndroidAutoPlaybackAvailable: () => true,
  subscribeAndroidAutoStatus: (listener: (status: unknown) => void) => {
    mockNative.listener = listener;
    return () => {
      mockNative.listener = null;
    };
  },
  loadAndroidAutoEpisode: (...args: unknown[]) => mockNative.load(...args),
  configureAndroidAutoSkip: jest.fn(),
  controlAndroidAutoPlayer: jest.fn(),
  getAndroidAutoStatus: () => null,
  logPlaybackEvent: jest.fn(),
}));
jest.mock('expo-audio', () => {
  throw new Error('unavailable');
});

import * as player from './trackPlayer';

const PATH = 'file:///cache/podcast-audio/ep-1.mp3';
const ep: Episode = { guid: 'ep-1', title: 'One', feedUrl: 'https://example.com/feed', enclosureUrl: 'https://cdn/x.mp3' };

function status(streamCache: unknown, guid = 'ep-1') {
  return {
    episodeJson: JSON.stringify({ ...ep, guid }),
    positionMs: 1000,
    durationMs: 3_600_000,
    isPlaying: true,
    playbackRate: 1,
    streamCache,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockNative.load.mockClear();
});

afterEach(async () => {
  await player.teardown();
  jest.useRealTimers();
});

test('passes the save path to the native player and enables local playback only once verified', async () => {
  const seen: string[] = [];
  const unsubscribe = player.subscribeStreamCache((s) => seen.push(s.state));
  await player.loadAndPlay(ep, { streamCachePath: PATH });
  expect(mockNative.load).toHaveBeenCalledWith(ep, undefined, 0, { cachePath: PATH, url: undefined });
  expect(player.getLoadedSource()).toEqual({ episodeGuid: 'ep-1', localFilePath: null });

  mockNative.listener!(status({ state: 'downloading', guid: 'ep-1', bytes: 10, total: 100 }));
  expect(player.getLoadedSource().localFilePath).toBeNull();

  // Complete but not verified (part of it was played from the network): still no skips.
  mockNative.listener!(status({ state: 'complete', guid: 'ep-1', bytes: 100, total: 100, md5: 'a', verified: false }));
  expect(player.getLoadedSource().localFilePath).toBeNull();

  mockNative.listener!(status({ state: 'complete', guid: 'ep-1', bytes: 100, total: 100, md5: 'a', verified: true }));
  expect(player.getLoadedSource().localFilePath).toBe(PATH);
  expect(seen).toEqual(['downloading', 'complete', 'complete']);
  unsubscribe();
});

test('a local file load never asks the native player to save a stream', async () => {
  await player.loadAndPlay(ep, { localFilePath: PATH, streamCachePath: PATH });
  expect(mockNative.load).toHaveBeenCalledWith(ep, PATH, 0, { cachePath: undefined, url: undefined });
});

test('if the service stops reporting the save (restarted), it is treated as lost', async () => {
  const seen: unknown[] = [];
  const unsubscribe = player.subscribeStreamCache((s) => seen.push(s));
  await player.loadAndPlay(ep, { streamCachePath: PATH });
  mockNative.listener!(status(undefined));
  expect(seen).toHaveLength(0);
  jest.advanceTimersByTime(6000);
  mockNative.listener!(status(undefined));
  expect(seen).toEqual([expect.objectContaining({ state: 'canceled', guid: 'ep-1' })]);
  expect(player.getLoadedSource().localFilePath).toBeNull();
  unsubscribe();
});
