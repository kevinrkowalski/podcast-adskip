/// <reference types="jest" />
import type { AdSegment, Episode } from '@/src/types';

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));

const mockNative = {
  available: false,
  listener: null as null | ((status: unknown) => void),
  configure: jest.fn(),
};

jest.mock('./androidAuto', () => ({
  isAndroidAutoPlaybackAvailable: () => mockNative.available,
  subscribeAndroidAutoStatus: (listener: (status: unknown) => void) => {
    mockNative.listener = listener;
    return () => {
      mockNative.listener = null;
    };
  },
  loadAndroidAutoEpisode: jest.fn(),
  configureAndroidAutoSkip: (opts: unknown) => mockNative.configure(opts),
  controlAndroidAutoPlayer: jest.fn(),
  getAndroidAutoStatus: () => null,
  logPlaybackEvent: jest.fn(),
}));

// No native expo-audio in tests: force the stub clock.
jest.mock('expo-audio', () => {
  throw new Error('unavailable');
});

import * as player from './trackPlayer';

function episode(guid: string, extra: Partial<Episode> = {}): Episode {
  return { guid, title: guid, feedUrl: 'https://example.com/feed', ...extra };
}

function nativeStatus(ep: Episode, positionMs: number) {
  return {
    episodeJson: JSON.stringify(ep),
    positionMs,
    durationMs: 3_600_000,
    isPlaying: true,
    playbackRate: 1,
  };
}

const ad: AdSegment = { start_ms: 10_000, end_ms: 40_000, type: 'sponsor', confidence: 0.95 };

beforeEach(() => {
  jest.useFakeTimers();
  mockNative.available = false;
  mockNative.listener = null;
  mockNative.configure.mockClear();
});

afterEach(async () => {
  await player.teardown();
  jest.useRealTimers();
});

describe('android playback service status', () => {
  it('ignores late status for the previous episode right after loading a new one', async () => {
    mockNative.available = true;
    const a = episode('A', { enclosureUrl: 'https://cdn/a.mp3' });
    const b = episode('B', { enclosureUrl: 'https://cdn/b.mp3' });
    await player.loadAndPlay(b, { startPositionMs: 60_000 });

    mockNative.listener?.(nativeStatus(a, 1_234_000));
    expect(player.getStatus().episode?.guid).toBe('B');
    expect(player.getStatus().positionMs).toBe(60_000);

    mockNative.listener?.(nativeStatus(b, 61_000));
    expect(player.getStatus().episode?.guid).toBe('B');
    expect(player.getStatus().positionMs).toBe(61_000);
  });

  it('clears segments persisted natively for the episode when it loads', async () => {
    mockNative.available = true;
    await player.loadAndPlay(episode('B', { enclosureUrl: 'https://cdn/b.mp3' }));
    expect(mockNative.configure).toHaveBeenCalledWith({ segments: [], episodeGuid: 'B' });
  });
});

describe('show notes', () => {
  it('keeps restored notes when the same episode is reloaded from a slim copy', async () => {
    const slim = episode('Q', { enclosureUrl: 'https://cdn/q.mp3' });
    await player.loadAndPlay(slim);
    player.updateEpisodeMetadata({ ...slim, description: '<p>Notes</p>' });
    // e.g. switching to the downloaded file with the queue's description-less copy
    await player.loadAndPlay(slim, { localFilePath: '/tmp/q.mp3' });
    expect(player.getStatus().episode?.description).toBe('<p>Notes</p>');
  });

  it('does not carry notes over to a different episode', async () => {
    await player.loadAndPlay(episode('A', { description: 'A notes' }));
    await player.loadAndPlay(episode('B'));
    expect(player.getStatus().episode?.description).toBeUndefined();
  });
});

describe('setSkipSegments', () => {
  it('ignores segments meant for an episode that is not loaded', async () => {
    mockNative.available = true;
    await player.loadAndPlay(episode('B', { enclosureUrl: 'https://cdn/b.mp3' }));
    mockNative.configure.mockClear();

    player.setSkipSegments([ad], 'A');
    expect(mockNative.configure).not.toHaveBeenCalled();

    player.setSkipSegments([ad], 'B');
    expect(mockNative.configure).toHaveBeenCalledWith({ segments: [ad], episodeGuid: 'B' });
  });
});

describe('auto-skip (stub clock)', () => {
  async function startStub() {
    await player.loadAndPlay(episode('S'), { startPositionMs: 5_000 });
    player.setAutoSkip(true);
    player.setAdDetectionEnabled(true);
    player.setSkipSegments([ad]);
  }

  it('skips an ad that playback runs into', async () => {
    await startStub();
    await jest.advanceTimersByTimeAsync(11_000);
    expect(player.getStatus().positionMs).toBeGreaterThanOrEqual(ad.end_ms);
  });

  it('lets the user seek into an ad and hear it, then skips it again next time', async () => {
    await startStub();
    await player.seekTo(20_000);
    await jest.advanceTimersByTimeAsync(2_000);
    const pos = player.getStatus().positionMs;
    expect(pos).toBeGreaterThanOrEqual(20_000);
    expect(pos).toBeLessThan(ad.end_ms);

    // Leave the ad, then play into it again: it is skipped.
    await player.seekTo(5_000);
    await jest.advanceTimersByTimeAsync(6_000);
    expect(player.getStatus().positionMs).toBeGreaterThanOrEqual(ad.end_ms);
  });
});
