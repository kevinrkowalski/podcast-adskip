import {
  MAX_RETRIES,
  RETRY_DELAY_MS,
  SERVER_POLL_MS,
  STARTUP_DELAY_MS,
  __resetForTesting,
  startQueueAnalyzer,
  triggerQueueAnalysis,
} from './queueAnalyzer';
import type { Episode } from '@/src/types';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
}));
jest.mock('@/src/db/storage', () => ({
  getAutoSkipEnabled: jest.fn(),
  isPodcastAdDetectionEnabled: jest.fn(),
  getCachedSkipMap: jest.fn(),
}));
jest.mock('@/src/api/audioUpload', () => ({
  getCachedAudioPath: jest.fn(),
  getCachedAudioMd5: jest.fn(),
}));
jest.mock('@/src/api/backend', () => ({
  getSkipMap: jest.fn(),
}));

const storage = jest.requireMock('@/src/db/storage');
const audio = jest.requireMock('@/src/api/audioUpload');
const backend = jest.requireMock('@/src/api/backend');

const ep = (guid: string, collectionId = 1): Episode =>
  ({
    guid,
    title: `Episode ${guid}`,
    feedUrl: `https://example.com/${collectionId}.xml`,
    enclosureUrl: `https://example.com/audio/${guid}.mp3`,
    collectionId,
    podcastTitle: 'Test Podcast',
  }) as Episode;

/** Resolves after `ms` of fake time, letting every awaited promise settle along the way. */
const advance = (ms: number) => jest.advanceTimersByTimeAsync(ms);

describe('queueAnalyzer', () => {
  let queue: Episode[];
  let current: string | null;
  let analyze: jest.Mock;
  let stop: (() => void) | null;

  const start = () => {
    stop = startQueueAnalyzer(analyze, () => queue, () => [current]);
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    __resetForTesting();
    queue = [];
    current = null;
    stop = null;
    analyze = jest.fn(async (e: Episode) => ({ status: 'ready', episode_guid: e.guid, segments: [] }));
    storage.getAutoSkipEnabled.mockResolvedValue(true);
    storage.isPodcastAdDetectionEnabled.mockResolvedValue(true);
    storage.getCachedSkipMap.mockResolvedValue(null);
    audio.getCachedAudioPath.mockResolvedValue(null);
    audio.getCachedAudioMd5.mockResolvedValue(null);
    backend.getSkipMap.mockResolvedValue({ status: 'missing', episode_guid: 'x', segments: [] });
  });

  afterEach(() => {
    stop?.();
    jest.useRealTimers();
  });

  it('waits for the startup delay, then analyzes the first eligible queued episode', async () => {
    queue = [ep('a'), ep('b')];
    start();
    await advance(STARTUP_DELAY_MS - 100);
    expect(analyze).not.toHaveBeenCalled();
    await advance(200);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze.mock.calls[0][0].guid).toBe('a');
  });

  it('analyzes a not-yet-playing first item, but skips the current episode', async () => {
    queue = [ep('playing'), ep('next')];
    current = 'playing';
    start();
    await advance(STARTUP_DELAY_MS + 10);
    expect(analyze.mock.calls.map((c) => c[0].guid)).toEqual(['next']);
  });

  it('never analyzes shows with ad detection off, or when global detection is off', async () => {
    queue = [ep('off', 2), ep('on', 1)];
    storage.isPodcastAdDetectionEnabled.mockImplementation(async (t: { collectionId?: number }) => t.collectionId !== 2);
    start();
    await advance(STARTUP_DELAY_MS + 5_000);
    expect(analyze.mock.calls.map((c) => c[0].guid)).toEqual(['on']);

    stop?.();
    __resetForTesting();
    analyze.mockClear();
    storage.getAutoSkipEnabled.mockResolvedValue(false);
    queue = [ep('c'), ep('d')];
    start();
    await advance(STARTUP_DELAY_MS + 5_000);
    expect(analyze).not.toHaveBeenCalled();
  });

  it('skips episodes with a ready or in-progress map', async () => {
    queue = [ep('ready'), ep('local'), ep('busy'), ep('todo')];
    audio.getCachedAudioPath.mockImplementation(async (g: string) => (g === 'local' ? '/cache/local.mp3' : null));
    audio.getCachedAudioMd5.mockImplementation(async (g: string) => (g === 'local' ? 'abc' : null));
    storage.getCachedSkipMap.mockImplementation(async (g: string) =>
      g === 'local' ? { status: 'ready', audio_md5: 'ABC', episode_guid: g, segments: [] } : null,
    );
    backend.getSkipMap.mockImplementation(async (g: string) => ({
      status: g === 'ready' ? 'ready' : g === 'busy' ? 'pending' : 'missing',
      episode_guid: g,
      segments: [],
    }));
    start();
    await advance(STARTUP_DELAY_MS + 5_000);
    expect(analyze.mock.calls.map((c) => c[0].guid)).toEqual(['todo']);
  });

  it('runs one analysis at a time, in queue order', async () => {
    queue = [ep('a'), ep('b'), ep('c')];
    let inFlight = 0;
    let maxInFlight = 0;
    const done = new Set<string>();
    analyze.mockImplementation(async (e: Episode) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10_000));
      inFlight -= 1;
      done.add(e.guid);
      return { status: 'ready', episode_guid: e.guid, segments: [] };
    });
    backend.getSkipMap.mockImplementation(async (g: string) => ({
      status: done.has(g) ? 'ready' : 'missing',
      episode_guid: g,
      segments: [],
    }));
    start();
    await advance(STARTUP_DELAY_MS + 10);
    triggerQueueAnalysis();
    triggerQueueAnalysis();
    await advance(60_000);
    expect(analyze.mock.calls.map((c) => c[0].guid)).toEqual(['a', 'b', 'c']);
    expect(maxInFlight).toBe(1);
  });

  it('holds the next upload while the server is still working on the last one', async () => {
    queue = [ep('a'), ep('b')];
    let aServerDone = false;
    analyze.mockImplementation(async (e: Episode) => ({
      status: e.guid === 'a' ? 'queued' : 'ready',
      episode_guid: e.guid,
      audio_md5: 'md5-' + e.guid,
      segments: [],
    }));
    backend.getSkipMap.mockImplementation(async (g: string) => ({
      status: g === 'a' ? (aServerDone ? 'ready' : analyze.mock.calls.length ? 'pending' : 'missing') : 'missing',
      episode_guid: g,
      segments: [],
    }));
    start();
    await advance(STARTUP_DELAY_MS + 10);
    expect(analyze).toHaveBeenCalledTimes(1);
    const pollsBefore = backend.getSkipMap.mock.calls.length;
    await advance(SERVER_POLL_MS * 3);
    expect(analyze).toHaveBeenCalledTimes(1);
    // Bounded polling: about one check per SERVER_POLL_MS, not a tight loop.
    expect(backend.getSkipMap.mock.calls.length - pollsBefore).toBeLessThanOrEqual(4);
    expect(backend.getSkipMap).toHaveBeenCalledWith('a', 'md5-a');
    aServerDone = true;
    await advance(SERVER_POLL_MS + 2_000);
    expect(analyze.mock.calls.map((c) => c[0].guid)).toEqual(['a', 'b']);
  });

  it(`retries a failing episode at most ${MAX_RETRIES} times, spaced out`, async () => {
    queue = [ep('bad')];
    analyze.mockRejectedValue(new Error('upload failed'));
    start();
    await advance(STARTUP_DELAY_MS + 10);
    expect(analyze).toHaveBeenCalledTimes(1);
    await advance(RETRY_DELAY_MS / 2);
    expect(analyze).toHaveBeenCalledTimes(1);
    await advance(RETRY_DELAY_MS * 10);
    expect(analyze).toHaveBeenCalledTimes(MAX_RETRIES);
    triggerQueueAnalysis();
    await advance(RETRY_DELAY_MS * 10);
    expect(analyze).toHaveBeenCalledTimes(MAX_RETRIES);
  });

  it('a null / error result counts as a failure too', async () => {
    queue = [ep('x')];
    analyze.mockResolvedValue(null);
    start();
    await advance(STARTUP_DELAY_MS + RETRY_DELAY_MS * 10);
    expect(analyze).toHaveBeenCalledTimes(MAX_RETRIES);
  });

  it('picks up an episode added to the queue later via trigger', async () => {
    start();
    await advance(STARTUP_DELAY_MS + 10);
    expect(analyze).not.toHaveBeenCalled();
    queue = [ep('new')];
    triggerQueueAnalysis();
    await advance(2_000);
    expect(analyze.mock.calls.map((c) => c[0].guid)).toEqual(['new']);
  });

  it('a trigger right after start still respects the startup delay', async () => {
    queue = [ep('a')];
    start();
    triggerQueueAnalysis();
    await advance(STARTUP_DELAY_MS - 500);
    expect(analyze).not.toHaveBeenCalled();
    await advance(1_000);
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it('does nothing after stop', async () => {
    queue = [ep('a')];
    start();
    stop?.();
    stop = null;
    triggerQueueAnalysis();
    await advance(STARTUP_DELAY_MS * 3);
    expect(analyze).not.toHaveBeenCalled();
  });
});
