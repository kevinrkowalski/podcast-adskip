/// <reference types="jest" />

/**
 * Unit tests for audio validation / mismatch detection.
 */

import { detectAudioMismatch, formatMismatchSummary } from './audioValidation';
import type { Episode, SkipMap } from '@/src/types';

// Mock episode factory
function mockEpisode(overrides?: Partial<Episode>): Episode {
  return {
    guid: 'test-guid',
    title: 'Test Episode',
    feedUrl: 'https://example.com/feed.xml',
    enclosureUrl: 'https://cdn.example.com/episode.mp3',
    durationMs: 1800000, // 30 minutes
    ...overrides,
  };
}

// Mock skip map factory
function mockSkipMap(overrides?: Partial<SkipMap>): SkipMap {
  return {
    status: 'ready',
    episode_guid: 'test-guid',
    segments: [
      { start_ms: 0, end_ms: 15000, type: 'preroll', confidence: 0.9 },
      { start_ms: 600000, end_ms: 660000, type: 'midroll', confidence: 0.85 },
    ],
    audio_url: 'https://cdn.example.com/episode.mp3',
    analyzed_audio_size_bytes: 45000000,
    analyzed_audio_duration_ms: 1800000,
    ...overrides,
  };
}

describe('detectAudioMismatch', () => {
  it('returns no warnings when URLs and metadata match', () => {
    const episode = mockEpisode();
    const skipMap = mockSkipMap();
    const warnings = detectAudioMismatch(episode, skipMap);
    expect(warnings).toHaveLength(0);
  });

  it('detects URL base path mismatch (high severity)', () => {
    const episode = mockEpisode({
      enclosureUrl: 'https://cdn2.example.com/different-episode.mp3',
    });
    const skipMap = mockSkipMap({
      audio_url: 'https://cdn.example.com/episode.mp3',
    });
    const warnings = detectAudioMismatch(episode, skipMap);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].type).toBe('url_different');
    expect(warnings[0].severity).toBe('high');
  });

  it('detects time-based query parameters (medium severity)', () => {
    const episode = mockEpisode({
      enclosureUrl: 'https://cdn.example.com/episode.mp3?timestamp=1234567890&token=abc',
    });
    const skipMap = mockSkipMap();
    const warnings = detectAudioMismatch(episode, skipMap);
    expect(warnings.some((w) => w.type === 'url_query_params')).toBe(true);
    const queryWarning = warnings.find((w) => w.type === 'url_query_params');
    expect(queryWarning?.severity).toBe('medium');
  });

  it('detects duration mismatch (high severity)', () => {
    const episode = mockEpisode({ durationMs: 1900000 }); // 31:40
    const skipMap = mockSkipMap({ analyzed_audio_duration_ms: 1800000 }); // 30:00
    const warnings = detectAudioMismatch(episode, skipMap);
    expect(warnings.some((w) => w.type === 'duration_mismatch')).toBe(true);
    const durationWarning = warnings.find((w) => w.type === 'duration_mismatch');
    expect(durationWarning?.severity).toBe('high');
  });

  it('ignores small duration differences (<5s)', () => {
    const episode = mockEpisode({ durationMs: 1801000 }); // 30:01
    const skipMap = mockSkipMap({ analyzed_audio_duration_ms: 1800000 }); // 30:00
    const warnings = detectAudioMismatch(episode, skipMap);
    expect(warnings.some((w) => w.type === 'duration_mismatch')).toBe(false);
  });

  it('detects stale analysis with time-based URLs (low severity)', () => {
    const episode = mockEpisode({
      enclosureUrl: 'https://cdn.example.com/episode.mp3?expires=1234567890',
    });
    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48 hours ago
    const skipMap = mockSkipMap({
      analyzed_at: oldDate.toISOString(),
    });
    const warnings = detectAudioMismatch(episode, skipMap);
    expect(warnings.some((w) => w.type === 'stale_analysis')).toBe(true);
    const staleWarning = warnings.find((w) => w.type === 'stale_analysis');
    expect(staleWarning?.severity).toBe('low');
  });

  it('returns empty array when skip map is not ready', () => {
    const episode = mockEpisode();
    const skipMap = mockSkipMap({ status: 'pending', segments: [] });
    const warnings = detectAudioMismatch(episode, skipMap);
    expect(warnings).toHaveLength(0);
  });

  it('returns empty array when skip map is null', () => {
    const episode = mockEpisode();
    const warnings = detectAudioMismatch(episode, null);
    expect(warnings).toHaveLength(0);
  });

  it('returns empty array when no segments', () => {
    const episode = mockEpisode();
    const skipMap = mockSkipMap({ segments: [] });
    const warnings = detectAudioMismatch(episode, skipMap);
    expect(warnings).toHaveLength(0);
  });
});

describe('formatMismatchSummary', () => {
  it('returns null when no warnings', () => {
    const summary = formatMismatchSummary([]);
    expect(summary).toBeNull();
  });

  it('prioritizes high severity warnings', () => {
    const warnings = [
      { type: 'stale_analysis', severity: 'low', message: 'Low priority' },
      { type: 'url_different', severity: 'high', message: 'High priority' },
      { type: 'url_query_params', severity: 'medium', message: 'Medium priority' },
    ] as const;
    const summary = formatMismatchSummary(warnings as any);
    expect(summary).toBe('High priority');
  });

  it('shows medium severity when no high', () => {
    const warnings = [
      { type: 'stale_analysis', severity: 'low', message: 'Low priority' },
      { type: 'url_query_params', severity: 'medium', message: 'Medium priority' },
    ] as const;
    const summary = formatMismatchSummary(warnings as any);
    expect(summary).toBe('Medium priority');
  });

  it('shows first warning when all low severity', () => {
    const warnings = [
      { type: 'stale_analysis', severity: 'low', message: 'First low' },
      { type: 'stale_analysis', severity: 'low', message: 'Second low' },
    ] as const;
    const summary = formatMismatchSummary(warnings as any);
    expect(summary).toBe('First low');
  });
});
