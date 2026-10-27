import AsyncStorage from '@react-native-async-storage/async-storage';
import { startQueueAnalyzer, triggerQueueAnalysis, __resetForTesting } from './queueAnalyzer';
import type { Episode } from '@/src/types';

// Mock dependencies
jest.mock('@react-native-async-storage/async-storage');
jest.mock('@/src/db/storage');
jest.mock('@/src/api/audioUpload');
jest.mock('@/src/api/backend');

const mockAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

describe('queueAnalyzer', () => {
  let mockAnalyze: jest.Mock;
  let mockGetQueue: jest.Mock;
  let stopAnalyzer: (() => void) | null = null;

  const createEpisode = (guid: string, collectionId: number): Episode => ({
    guid,
    title: `Episode ${guid}`,
    feedUrl: 'https://example.com/feed.xml',
    enclosureUrl: `https://example.com/audio/${guid}.mp3`,
    collectionId,
    podcastTitle: 'Test Podcast',
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    
    // Reset module state between tests
    __resetForTesting();
    
    mockAnalyze = jest.fn().mockResolvedValue({ status: 'ready' });
    mockGetQueue = jest.fn().mockReturnValue([]);
    
    mockAsyncStorage.getItem.mockResolvedValue(null);
    mockAsyncStorage.setItem.mockResolvedValue(undefined);
    
    // Mock storage functions
    const storage = require('@/src/db/storage');
    storage.getAutoSkipEnabled = jest.fn().mockResolvedValue(true);
    storage.isPodcastAdDetectionEnabled = jest.fn().mockResolvedValue(true);
    
    // Mock audio functions
    const audioUpload = require('@/src/api/audioUpload');
    audioUpload.getCachedAudioPath = jest.fn().mockResolvedValue(null);
    audioUpload.getCachedAudioMd5 = jest.fn().mockResolvedValue(null);
    
    // Mock backend
    const backend = require('@/src/api/backend');
    backend.getSkipMap = jest.fn().mockResolvedValue({ status: 'missing' });
  });

  afterEach(() => {
    if (stopAnalyzer) {
      stopAnalyzer();
      stopAnalyzer = null;
    }
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('should not analyze when queue is empty', async () => {
    mockGetQueue.mockReturnValue([]);
    
    stopAnalyzer = startQueueAnalyzer(mockAnalyze, mockGetQueue);
    
    // Fast-forward past startup delay
    jest.advanceTimersByTime(6000);
    await Promise.resolve();
    
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it('should start and stop without errors', () => {
    const ep1 = createEpisode('ep1', 1);
    const ep2 = createEpisode('ep2', 1);
    
    mockGetQueue.mockReturnValue([ep1, ep2]);
    
    stopAnalyzer = startQueueAnalyzer(mockAnalyze, mockGetQueue);
    expect(stopAnalyzer).toBeDefined();
    
    stopAnalyzer();
    stopAnalyzer = null;
  });

  it('should not analyze when podcast ad detection is disabled', async () => {
    const storage = require('@/src/db/storage');
    storage.isPodcastAdDetectionEnabled.mockResolvedValue(false);
    
    const ep1 = createEpisode('playing', 1);
    const ep2 = createEpisode('queued', 1);
    mockGetQueue.mockReturnValue([ep1, ep2]);
    
    stopAnalyzer = startQueueAnalyzer(mockAnalyze, mockGetQueue);
    
    jest.advanceTimersByTime(6000);
    await Promise.resolve();
    
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it('should skip episodes that already have a ready skip map', async () => {
    const backend = require('@/src/api/backend');
    backend.getSkipMap.mockResolvedValue({ status: 'ready' });
    
    const ep1 = createEpisode('playing', 1);
    const ep2 = createEpisode('queued', 1);
    mockGetQueue.mockReturnValue([ep1, ep2]);
    
    stopAnalyzer = startQueueAnalyzer(mockAnalyze, mockGetQueue);
    
    jest.advanceTimersByTime(6000);
    await Promise.resolve();
    
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it('should handle trigger without errors', () => {
    const ep1 = createEpisode('playing', 1);
    const ep2 = createEpisode('queued', 1);
    mockGetQueue.mockReturnValue([ep1, ep2]);
    
    stopAnalyzer = startQueueAnalyzer(mockAnalyze, mockGetQueue);
    
    // Trigger analysis should not throw
    expect(() => triggerQueueAnalysis(true)).not.toThrow();
    expect(() => triggerQueueAnalysis(false)).not.toThrow();
  });

  it('should handle episodes being analyzed elsewhere', async () => {
    const backend = require('@/src/api/backend');
    backend.getSkipMap.mockResolvedValue({ status: 'pending' });
    
    const ep1 = createEpisode('playing', 1);
    const ep2 = createEpisode('queued', 1);
    mockGetQueue.mockReturnValue([ep1, ep2]);
    
    stopAnalyzer = startQueueAnalyzer(mockAnalyze, mockGetQueue);
    
    jest.advanceTimersByTime(6000);
    await Promise.resolve();
    
    // Should not analyze if already pending
    expect(mockAnalyze).not.toHaveBeenCalled();
  });
});
