/// <reference types="jest" />
import type { AdSegment, SkipMap } from '@/src/types';
import { adSkipLine, formatDurationWords, type AdLineInput } from './adSkipLine';

const seg = (start: number, end: number, type = 'sponsor', confidence = 0.95): AdSegment =>
  ({ start_ms: start, end_ms: end, type, confidence }) as AdSegment;
const map = (segments: AdSegment[], extra: Partial<SkipMap> = {}): SkipMap => ({
  status: 'ready',
  episode_guid: 'g',
  segments,
  ...extra,
});
const settings = { skipEnabled: true, skipAdvertisement: true, skipIntroOutro: true, skipSelfPromotion: true };
const base: AdLineInput = {
  hasAudio: true,
  autoSkip: true,
  adDetectionEnabled: true,
  skipSettings: settings,
  skipMap: null,
  analyzeStatus: null,
};
const line = (patch: Partial<AdLineInput>) => adSkipLine({ ...base, ...patch });

test('ads found and skipping on: count and total time', () => {
  const l = line({ skipMap: map([seg(0, 92_000), seg(1_040_000, 1_184_000), seg(1_800_000, 1_824_000)]), analyzeStatus: 'ready' });
  expect(l).toMatchObject({ tone: 'on', text: 'Skipping 3 ads', detail: '4 min 20 s in total' });
  expect(l.action).toBeUndefined();
});

test('mixed kinds are called segments; unsure ones are not counted', () => {
  const l = line({
    skipMap: map([seg(0, 60_000), seg(60_000, 90_000, 'intro_outro'), seg(500_000, 520_000, 'sponsor', 0.7)]),
    analyzeStatus: 'ready',
  });
  expect(l.text).toBe('Skipping 2 segments');
});

test('checked and clean', () => {
  expect(line({ skipMap: map([]), analyzeStatus: 'ready' })).toMatchObject({ tone: 'ok', text: 'No ads found' });
});

test('not checked yet offers Check now', () => {
  expect(line({})).toMatchObject({ text: 'Not checked for ads', action: { label: 'Check now', kind: 'check' } });
});

test('switched off for the app, with and without segments', () => {
  expect(line({ autoSkip: false })).toMatchObject({ text: 'Ad skipping is off', action: { kind: 'turnOn' } });
  expect(line({ autoSkip: false, skipMap: map([seg(0, 30_000)]), analyzeStatus: 'ready' })).toMatchObject({
    text: '1 segment found, not skipping',
    action: { kind: 'turnOn' },
  });
});

test('switched off for the show points at its settings', () => {
  expect(line({ adDetectionEnabled: false })).toMatchObject({
    text: 'Ad skipping is off for this show',
    action: { kind: 'showSettings' },
    secondAction: { kind: 'check' },
  });
  expect(
    line({ skipSettings: { ...settings, skipEnabled: false }, skipMap: map([seg(0, 30_000)]), analyzeStatus: 'ready' }),
  ).toMatchObject({ action: { kind: 'showSettings' } });
});

test('download before play, then failure with both ways out', () => {
  expect(line({ playbackDownload: { state: 'downloading', progressPct: 42 } })).toMatchObject({
    tone: 'busy',
    text: 'Downloading · 42%',
    progressPct: 42,
  });
  expect(line({ playbackDownload: { state: 'error', progressPct: null, message: 'No connection' } })).toMatchObject({
    tone: 'bad',
    detail: 'No connection',
    action: { kind: 'retryDownload' },
    secondAction: { kind: 'streamWithoutSkipping' },
  });
});

test('playing while it downloads', () => {
  expect(line({ playbackDownload: { state: 'caching', progressPct: 60 } }).text).toBe('Skips turn on after download · 60%');
  expect(line({ playbackDownload: { state: 'cache-error', progressPct: null } })).toMatchObject({
    tone: 'bad',
    action: { kind: 'retryDownload' },
  });
});

test('server analysis shows stage and time left', () => {
  const l = line({
    analyzeStatus: 'pending',
    skipMap: map([], { status: 'pending', stage_label: 'Transcribing', eta_seconds: 130, progress_pct: 35 }),
  });
  expect(l).toMatchObject({ tone: 'busy', text: 'Checking for ads', detail: 'Transcribing · About 2 min left', progressPct: 35 });
});

test('upload progress while preparing', () => {
  expect(
    line({ analyzeStatus: 'uploading', uploadProgress: { downloaded: 50, uploaded: 20, total: 1 } }).text,
  ).toBe('Sending for an ad check · 70%');
});

test('errors offer another try; a changed audio file offers a re-check', () => {
  expect(line({ analyzeStatus: 'error', analyzeError: 'Upload failed: 500' })).toMatchObject({
    tone: 'bad',
    detail: 'Upload failed: 500',
    action: { label: 'Try again', kind: 'check' },
  });
  expect(line({ analyzeStatus: 'offline' }).action).toMatchObject({ kind: 'check' });
  expect(
    line({ skipMap: map([seg(0, 30_000)]), analyzeStatus: 'ready', audioMismatchWarning: 'This audio differs' }),
  ).toMatchObject({ tone: 'bad', text: 'Skips may be off', action: { label: 'Check again' } });
});

test('duration words', () => {
  expect(formatDurationWords(45_000)).toBe('45 s');
  expect(formatDurationWords(260_000)).toBe('4 min 20 s');
  expect(formatDurationWords(15 * 60_000 + 20_000)).toBe('15 min');
  expect(formatDurationWords(3_900_000)).toBe('1 hr 5 min');
});

test('a download error message is not repeated under the headline', () => {
  const l = adSkipLine({
    ...base,
    playbackDownload: { state: 'error', progressPct: null, message: "Couldn't download this episode for ad skipping. No connection." },
  });
  expect(l.detail).toBe('No connection.');
});
