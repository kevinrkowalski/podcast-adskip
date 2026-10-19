/// <reference types="jest" />
declare const require: (m: string) => any;
declare const __dirname: string;
import type { AdSegment, Episode } from '@/src/types';

// Regression: ba5edb9 only auto-skipped when the episode played from the downloaded file,
// so any streamed episode with a ready skip map played straight through its ads.

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

jest.mock('./androidAuto', () => ({
  isAndroidAutoPlaybackAvailable: () => false,
  subscribeAndroidAutoStatus: () => () => {},
  loadAndroidAutoEpisode: jest.fn(),
  configureAndroidAutoSkip: jest.fn(),
  controlAndroidAutoPlayer: jest.fn(),
  getAndroidAutoStatus: () => null,
  logPlaybackEvent: jest.fn(),
}));

type FakePlayer = {
  source: unknown;
  currentTime: number;
  duration: number;
  playing: boolean;
  isLoaded: boolean;
  seeks: number[];
  play: () => void;
  pause: () => void;
  remove: () => void;
  seekTo: (sec: number) => Promise<void>;
  setActiveForLockScreen: () => void;
  clearLockScreenControls: () => void;
  addListener: () => { remove: () => void };
};

const mockAudio = { last: null as FakePlayer | null };

jest.mock('expo-audio', () => ({
  setAudioModeAsync: async () => {},
  createAudioPlayer: (source: unknown) => {
    const p: FakePlayer = {
      source,
      currentTime: 0,
      duration: 3600,
      playing: false,
      isLoaded: true,
      seeks: [],
      play() {
        p.playing = true;
      },
      pause() {
        p.playing = false;
      },
      remove() {},
      async seekTo(sec: number) {
        p.seeks.push(sec);
        p.currentTime = sec;
      },
      setActiveForLockScreen() {},
      clearLockScreenControls() {},
      addListener: () => ({ remove() {} }),
    };
    mockAudio.last = p;
    return p;
  },
}));

import * as player from './trackPlayer';

const ad: AdSegment = { start_ms: 10_000, end_ms: 40_000, type: 'sponsor', confidence: 0.95 };
const ep: Episode = {
  guid: 'stream-ep',
  title: 'Streamed episode',
  feedUrl: 'https://example.com/feed',
  enclosureUrl: 'https://cdn.example.com/ep.mp3',
};

beforeEach(() => {
  jest.useFakeTimers();
  mockAudio.last = null;
});

afterEach(async () => {
  await player.teardown();
  jest.useRealTimers();
});

async function playInto(opts?: { localFilePath?: string }) {
  await player.loadAndPlay(ep, opts);
  player.setAutoSkip(true);
  player.setAdDetectionEnabled(true);
  player.setSkipSegments([ad], ep.guid);
  const fake = mockAudio.last!;
  expect(fake).not.toBeNull();
  // Playback runs into the ad.
  fake.currentTime = 15;
  await jest.advanceTimersByTimeAsync(500);
  return fake;
}

describe('auto-skip on the real (expo-audio) backend', () => {
  it('skips an ad while streaming (no downloaded file)', async () => {
    const fake = await playInto();
    expect(fake.source).toMatchObject({ uri: ep.enclosureUrl });
    expect(fake.seeks).toContain(ad.end_ms / 1000);
    expect(player.getStatus().positionMs).toBeGreaterThanOrEqual(ad.end_ms);
  });

  it('skips an ad when playing the downloaded file', async () => {
    const fake = await playInto({ localFilePath: 'file:///cache/podcast-audio/stream-ep.mp3' });
    expect(fake.seeks).toContain(ad.end_ms / 1000);
  });
});

// The Android playback service does the skipping natively (screen off, Android Auto).
// It must not refuse to skip just because the item is a stream rather than a file.
test('native service auto-skip is not limited to local files', () => {
  const fs = require('fs');
  const path = require('path');
  const src: string = fs.readFileSync(
    path.join(
      __dirname,
      '../../modules/podcast-auto/android/src/main/java/expo/modules/podcastauto/PodcastAutoPlaybackService.kt',
    ),
    'utf8',
  );
  const start = src.indexOf('private fun applyNativeAdSkip');
  expect(start).toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('\n  private fun ', start + 10));
  expect(body).not.toMatch(/isPlayingLocalFile|scheme\s*==\s*"file"/);
  expect(body).toMatch(/currentSegments\(exoPlayer\)/);
});
