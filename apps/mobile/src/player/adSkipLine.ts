import type { PodcastSkipSettings } from '@/src/db/storage';
import type { AdSegment, SkipMap } from '@/src/types';
import { filterSkippableSegments, normalizeSegment } from './skipLogic';

/**
 * The one-line ad-skipping status shown under the player controls (and on an episode
 * sheet). Every state reads as a sentence; when there is something for the listener to
 * do, the line carries the button for it. Tapping the line itself always opens the
 * Ad skipping sheet.
 */

/** What a button on the line does. */
export type AdLineActionKind =
  /** Download (if needed) and analyze this episode now. */
  | 'check'
  /** Turn ad skipping on for the whole app. */
  | 'turnOn'
  /** Open this show's settings. */
  | 'showSettings'
  | 'retryDownload'
  | 'streamWithoutSkipping';

export type AdLineAction = { label: string; kind: AdLineActionKind };

export type AdLine = {
  /** on: skipping; ok: checked and clean; idle: nothing happening; busy: working; bad: needs attention. */
  tone: 'on' | 'ok' | 'idle' | 'busy' | 'bad';
  text: string;
  detail?: string;
  /** 0-100 while busy, null when unknown, undefined when not busy. */
  progressPct?: number | null;
  action?: AdLineAction;
  secondAction?: AdLineAction;
};

export type AdLineInput = {
  /** False for episodes with no audio file (nothing to check). */
  hasAudio: boolean;
  /** App-wide ad skipping switch. */
  autoSkip: boolean;
  /** This show's ad detection switch. */
  adDetectionEnabled: boolean;
  skipSettings: PodcastSkipSettings | null;
  skipMap: SkipMap | null;
  analyzeStatus: string | null;
  analyzeError?: string | null;
  uploadProgress?: { downloaded: number; uploaded: number; total: number } | null;
  playbackDownload?: {
    state: 'downloading' | 'error' | 'caching' | 'cache-error';
    progressPct: number | null;
    message?: string;
  } | null;
  audioMismatchWarning?: string | null;
};

const ANALYZING = new Set(['queued', 'pending', 'downloading', 'uploading']);

export function isAnalyzing(status: string | null | undefined): boolean {
  return !!status && ANALYZING.has(status);
}

/** Segments that will actually be skipped under this show's settings. */
export function skippableSegments(segments: AdSegment[], settings: PodcastSkipSettings | null): AdSegment[] {
  if (settings && !settings.skipEnabled) return [];
  return filterSkippableSegments(segments.map(normalizeSegment), {
    skipAdvertisement: settings?.skipAdvertisement ?? true,
    skipIntroOutro: settings?.skipIntroOutro ?? true,
    skipSelfPromotion: settings?.skipSelfPromotion ?? true,
  });
}

/** "4 min 20 s", "45 s", "1 hr 5 min". */
export function formatDurationWords(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h} hr ${m} min` : `${h} hr`;
  if (m > 0) return s > 0 && m < 10 ? `${m} min ${s} s` : `${m} min`;
  return `${s} s`;
}

function etaWords(sec: number | null | undefined): string | undefined {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return undefined;
  if (sec < 60) return `About ${Math.max(5, Math.round(sec / 5) * 5)} sec left`;
  return `About ${Math.max(1, Math.round(sec / 60))} min left`;
}

function clampPct(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
}

function pctSuffix(pct: number | null): string {
  return pct != null ? ` · ${Math.round(pct)}%` : '';
}

/** "3 ads" when every skipped segment is an advertisement, otherwise "3 segments". */
export function skipCountWords(segments: AdSegment[]): string {
  const n = segments.length;
  const allAds = segments.every((s) => normalizeSegment(s).type === 'advertisement');
  const noun = allAds ? 'ad' : 'segment';
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

export function adSkipLine(input: AdLineInput): AdLine {
  const { skipMap, analyzeStatus, playbackDownload: download } = input;
  if (!input.hasAudio) return { tone: 'idle', text: 'No audio to check for ads' };

  const check: AdLineAction = { label: 'Check now', kind: 'check' };
  const segments = skipMap?.segments ?? [];
  const willSkip = skippableSegments(segments, input.skipSettings);

  if (download?.state === 'downloading') {
    const pct = clampPct(download.progressPct);
    return {
      tone: 'busy',
      text: `Downloading${pctSuffix(pct)}`,
      detail: 'Plays when ready, so skips line up',
      progressPct: pct,
    };
  }
  if (download?.state === 'error') {
    return {
      tone: 'bad',
      text: "Couldn't download this episode",
      // The message usually opens by saying the same thing; keep only what it adds.
      detail: download.message?.replace(/^couldn['’]t download[^.]*\.\s*/i, '').trim() || undefined,
      action: { label: 'Retry', kind: 'retryDownload' },
      secondAction: { label: 'Play without skipping', kind: 'streamWithoutSkipping' },
    };
  }
  if (isAnalyzing(analyzeStatus)) {
    if (input.uploadProgress) {
      const pct = clampPct(input.uploadProgress.downloaded + input.uploadProgress.uploaded);
      return {
        tone: 'busy',
        text: analyzeStatus === 'uploading' ? `Sending for an ad check${pctSuffix(pct)}` : `Downloading to check for ads${pctSuffix(pct)}`,
        progressPct: pct,
      };
    }
    return {
      tone: 'busy',
      text: 'Checking for ads',
      detail: [skipMap?.stage_label?.trim(), etaWords(skipMap?.eta_seconds)].filter(Boolean).join(' · ') || undefined,
      progressPct: clampPct(skipMap?.progress_pct),
    };
  }
  if (download?.state === 'caching') {
    const pct = clampPct(download.progressPct);
    return { tone: 'busy', text: `Skips turn on after download${pctSuffix(pct)}`, progressPct: pct };
  }
  if (download?.state === 'cache-error') {
    return {
      tone: 'bad',
      text: 'Ad skipping is off for this play',
      detail: download.message,
      action: { label: 'Retry', kind: 'retryDownload' },
    };
  }
  if (input.audioMismatchWarning && segments.length > 0) {
    return {
      tone: 'bad',
      text: 'Skips may be off',
      detail: input.audioMismatchWarning,
      action: { label: 'Check again', kind: 'check' },
    };
  }
  if (analyzeStatus === 'error') {
    return {
      tone: 'bad',
      text: "Couldn't check for ads",
      detail: input.analyzeError ?? undefined,
      action: { label: 'Try again', kind: 'check' },
    };
  }
  if (analyzeStatus === 'offline') {
    return {
      tone: 'bad',
      text: "Couldn't check for ads",
      detail: "The server didn't respond",
      action: { label: 'Try again', kind: 'check' },
    };
  }

  const ready = analyzeStatus === 'ready' || skipMap?.status === 'ready';
  if (ready) {
    if (segments.length === 0) return { tone: 'ok', text: 'No ads found' };
    const found = `${segments.length} segment${segments.length === 1 ? '' : 's'} found`;
    if (!input.autoSkip) {
      return { tone: 'idle', text: `${found}, not skipping`, action: { label: 'Turn on', kind: 'turnOn' } };
    }
    if (!input.adDetectionEnabled || (input.skipSettings && !input.skipSettings.skipEnabled)) {
      return {
        tone: 'idle',
        text: `${found}, skipping is off for this show`,
        action: { label: 'Change', kind: 'showSettings' },
      };
    }
    if (willSkip.length === 0) {
      return { tone: 'idle', text: `${found}, none will be skipped`, detail: 'Unsure, or switched off for this show' };
    }
    const totalMs = willSkip.reduce((sum, s) => sum + Math.max(0, s.end_ms - s.start_ms), 0);
    return { tone: 'on', text: `Skipping ${skipCountWords(willSkip)}`, detail: `${formatDurationWords(totalMs)} in total` };
  }

  if (!input.autoSkip) {
    return { tone: 'idle', text: 'Ad skipping is off', action: { label: 'Turn on', kind: 'turnOn' } };
  }
  if (!input.adDetectionEnabled) {
    return {
      tone: 'idle',
      text: 'Ad skipping is off for this show',
      action: { label: 'Change', kind: 'showSettings' },
      secondAction: check,
    };
  }
  return { tone: 'idle', text: 'Not checked for ads', action: check };
}
