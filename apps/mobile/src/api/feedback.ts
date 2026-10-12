/**
 * "Report bad skip" client: POST /v1/feedback, with a local outbox so reports
 * made offline (or when the API is down) are retried later.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import type { AdSegment } from '@/src/types';
import { getApiBaseUrl, getResolvedAppKey, hydrateApiBaseUrl, hydrateAppKey } from './backend';

const OUTBOX_KEY = '@podcast-adskip/feedbackOutbox';
const MAX_OUTBOX = 50;

export type FeedbackKind = 'skipped_content' | 'missed_ad';

type Seg = { start_ms: number; end_ms: number; type?: string | null; confidence?: number | null };

export type FeedbackReport = {
  kind: FeedbackKind;
  episode_guid: string;
  title?: string | null;
  feed_url?: string | null;
  position_ms?: number | null;
  selected_segment?: Seg | null;
  segments: Seg[];
  model?: string | null;
  analyzed_at?: string | null;
  note?: string | null;
  client_created_at: string;
  app_version?: string | null;
};

export function toFeedbackSegment(s: AdSegment): Seg {
  return {
    start_ms: Math.round(s.start_ms),
    end_ms: Math.round(s.end_ms),
    type: s.type ?? null,
    confidence: typeof s.confidence === 'number' && Number.isFinite(s.confidence) ? s.confidence : null,
  };
}

async function post(report: FeedbackReport): Promise<void> {
  await Promise.all([hydrateApiBaseUrl(), hydrateAppKey()]);
  const key = getResolvedAppKey();
  const res = await fetch(`${getApiBaseUrl()}/v1/feedback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(key ? { 'X-App-Key': key } : {}),
    },
    body: JSON.stringify(report),
  });
  if (!res.ok) {
    const err = new Error(`feedback failed: ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
}

async function readOutbox(): Promise<FeedbackReport[]> {
  try {
    const raw = await AsyncStorage.getItem(OUTBOX_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function writeOutbox(list: FeedbackReport[]) {
  await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(list.slice(-MAX_OUTBOX)));
}

/** Rejected for good (bad payload/auth): don't retry those forever. */
function isPermanent(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  return status === 400 || status === 422;
}

/** Send now; on failure keep it in the outbox. Returns 'sent' or 'queued'. */
export async function submitFeedback(report: FeedbackReport): Promise<'sent' | 'queued'> {
  try {
    await post(report);
    void flushFeedbackOutbox();
    return 'sent';
  } catch (e) {
    if (isPermanent(e)) throw e;
    await writeOutbox([...(await readOutbox()), report]);
    return 'queued';
  }
}

let flushing: Promise<number> | null = null;

/** Retry queued reports; returns how many were sent. */
export function flushFeedbackOutbox(): Promise<number> {
  if (flushing) return flushing;
  flushing = (async () => {
    let sent = 0;
    try {
      const list = await readOutbox();
      if (!list.length) return 0;
      const remaining: FeedbackReport[] = [];
      for (const r of list) {
        try {
          await post(r);
          sent += 1;
        } catch (e) {
          if (!isPermanent(e)) remaining.push(r);
        }
      }
      await writeOutbox(remaining);
      return sent;
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

/** Flush on start and whenever the app returns to the foreground. */
export function startFeedbackOutbox(): () => void {
  void flushFeedbackOutbox();
  const sub = AppState.addEventListener('change', (s) => {
    if (s === 'active') void flushFeedbackOutbox();
  });
  return () => sub.remove();
}
