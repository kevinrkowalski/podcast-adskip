/// <reference types="jest" />
import {
  localPathAfterStreamCache,
  shouldPlayWhileDownloading,
  streamCacheFailureMessage,
  streamCacheNotice,
  streamCacheOutcome,
  streamCacheProgressPct,
  type StreamCacheStatus,
} from './streamCache';

const base = { needsDownload: true, hasEnclosureUrl: true, nativeAvailable: true, regularDownloadInFlight: false };

test('plays while downloading only when a download is needed and the native player can save it', () => {
  expect(shouldPlayWhileDownloading(base)).toBe(true);
  expect(shouldPlayWhileDownloading({ ...base, needsDownload: false })).toBe(false);
  expect(shouldPlayWhileDownloading({ ...base, hasEnclosureUrl: false })).toBe(false);
  // No native service (iOS/web): fall back to download-first.
  expect(shouldPlayWhileDownloading({ ...base, nativeAvailable: false })).toBe(false);
  // A prefetch/Prepare download is already running: its copy is the one that gets analyzed.
  expect(shouldPlayWhileDownloading({ ...base, regularDownloadInFlight: true })).toBe(false);
});

test('progress and notice text', () => {
  expect(streamCacheProgressPct({ state: 'downloading', bytes: 25, total: 100 })).toBe(25);
  expect(streamCacheProgressPct({ state: 'downloading', bytes: 100, total: 100 })).toBe(99);
  expect(streamCacheProgressPct({ state: 'downloading', bytes: 5, total: 0 })).toBeNull();
  expect(streamCacheProgressPct({ state: 'complete', bytes: 100, total: 100 })).toBe(100);
  expect(streamCacheNotice(42)).toBe('Ad skip ready after download (42%)');
  expect(streamCacheNotice(null)).toBe('Ad skip ready after download');
});

const done: StreamCacheStatus = {
  state: 'complete',
  guid: 'ep-1',
  bytes: 100,
  total: 100,
  md5: 'abc',
  verified: true,
};

test('only a complete, verified, fingerprinted save of the same episode is ready', () => {
  expect(streamCacheOutcome(done, 'ep-1')).toBe('ready');
  expect(streamCacheOutcome(done, 'ep-2')).toBe('none');
  expect(streamCacheOutcome(null, 'ep-1')).toBe('none');
  expect(streamCacheOutcome({ ...done, state: 'downloading' }, 'ep-1')).toBe('progress');
  expect(streamCacheOutcome({ ...done, verified: false }, 'ep-1')).toBe('failed');
  expect(streamCacheOutcome({ ...done, md5: null }, 'ep-1')).toBe('failed');
  expect(streamCacheOutcome({ ...done, state: 'failed', error: 'HTTP 403' }, 'ep-1')).toBe('failed');
  expect(streamCacheOutcome({ ...done, state: 'canceled' }, 'ep-1')).toBe('failed');
});

test('the loaded episode counts as local (skips allowed) only after a verified save', () => {
  const target = { guid: 'ep-1', path: 'file:///cache/podcast-audio/ep-1.mp3' };
  expect(localPathAfterStreamCache(null, target, { ...done, state: 'downloading' }, 'ep-1')).toBeNull();
  expect(localPathAfterStreamCache(null, target, done, 'ep-1')).toBe(target.path);
  expect(localPathAfterStreamCache(null, target, { ...done, verified: false }, 'ep-1')).toBeNull();
  // A report for a different loaded episode never applies.
  expect(localPathAfterStreamCache(null, target, done, 'ep-2')).toBeNull();
  expect(localPathAfterStreamCache(null, null, done, 'ep-1')).toBeNull();
  // Already on a local file: unchanged.
  expect(localPathAfterStreamCache('/x.mp3', target, done, 'ep-1')).toBe('/x.mp3');
});

test('failure message', () => {
  expect(streamCacheFailureMessage('Unable to resolve host')).toBe(
    'Ad skipping is off for this play: the connection dropped.',
  );
  expect(streamCacheFailureMessage("server can't resume (HTTP 200), so this copy can't be verified")).toBe(
    "Ad skipping is off for this play: server can't resume (HTTP 200), so this copy can't be verified.",
  );
  expect(streamCacheFailureMessage(null)).toBe('Ad skipping is off for this play: the download stopped.');
});
