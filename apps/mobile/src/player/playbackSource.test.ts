/// <reference types="jest" />
import {
  decidePlaybackSource,
  downloadFailureMessage,
  needsReanalysisForLocalFile,
  serverHasAnalysis,
} from './playbackSource';

const base = {
  hasLocalFile: false,
  hasEnclosureUrl: true,
  globalAutoSkip: true,
  podcastDetectionEnabled: false,
  hasPreparedAnalysis: false,
};

describe('decidePlaybackSource', () => {
  it('always plays the downloaded copy when there is one', () => {
    expect(decidePlaybackSource({ ...base, hasLocalFile: true })).toBe('local');
    expect(decidePlaybackSource({ ...base, hasLocalFile: true, globalAutoSkip: false })).toBe('local');
  });

  it('downloads first when the show has ad detection on', () => {
    expect(decidePlaybackSource({ ...base, podcastDetectionEnabled: true })).toBe('download');
  });

  it('downloads first for a prepared episode even if the show has detection off', () => {
    expect(decidePlaybackSource({ ...base, hasPreparedAnalysis: true })).toBe('download');
  });

  it('streams only when nothing will be skipped', () => {
    expect(decidePlaybackSource(base)).toBe('stream');
    expect(
      decidePlaybackSource({ ...base, globalAutoSkip: false, podcastDetectionEnabled: true }),
    ).toBe('stream');
  });

  it('streams when there is no enclosure to download', () => {
    expect(
      decidePlaybackSource({ ...base, hasEnclosureUrl: false, podcastDetectionEnabled: true }),
    ).toBe('stream');
  });
});

describe('server analysis flags', () => {
  const map = (extra: object) => ({ episode_guid: 'g', segments: [], ...extra }) as any;

  it('detects analysis made from another download', () => {
    expect(serverHasAnalysis(map({ status: 'missing', analysis_for_other_audio: true }))).toBe(true);
    expect(serverHasAnalysis(map({ status: 'ready' }))).toBe(true);
    expect(serverHasAnalysis(map({ status: 'pending' }))).toBe(true);
    expect(serverHasAnalysis(map({ status: 'missing' }))).toBe(false);
    expect(serverHasAnalysis(null)).toBe(false);
  });

  it('asks for re-analysis only when the server map is for other bytes', () => {
    expect(needsReanalysisForLocalFile(map({ status: 'missing', analysis_for_other_audio: true }))).toBe(true);
    expect(needsReanalysisForLocalFile(map({ status: 'missing' }))).toBe(false);
    expect(needsReanalysisForLocalFile(map({ status: 'ready', analysis_for_other_audio: true }))).toBe(false);
  });

  it('explains download failures', () => {
    expect(downloadFailureMessage(new Error('Network request failed'))).toMatch(/offline/);
    expect(downloadFailureMessage(new Error('Audio download failed: HTTP 404'))).toMatch(/HTTP 404/);
  });
});
