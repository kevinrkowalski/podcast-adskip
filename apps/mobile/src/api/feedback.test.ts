/// <reference types="jest" />
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));
jest.mock('./backend', () => ({
  getApiBaseUrl: () => 'http://api.test',
  getResolvedAppKey: () => 'k',
  hydrateApiBaseUrl: async () => 'http://api.test',
  hydrateAppKey: async () => 'k',
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { flushFeedbackOutbox, submitFeedback, type FeedbackReport } from './feedback';

const OUTBOX_KEY = '@podcast-adskip/feedbackOutbox';

const report = (n: number): FeedbackReport => ({
  kind: 'missed_ad',
  episode_guid: `g${n}`,
  segments: [],
  client_created_at: `2026-10-19T00:00:0${n}Z`,
});

async function outboxGuids(): Promise<string[]> {
  const raw = await AsyncStorage.getItem(OUTBOX_KEY);
  return (raw ? (JSON.parse(raw) as FeedbackReport[]) : []).map((r) => r.episode_guid);
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

test('a report queued while a flush is running is not lost', async () => {
  await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify([report(1), report(2)]));

  let releaseFlush!: () => void;
  const flushGate = new Promise<void>((r) => (releaseFlush = r));
  const fetchMock = jest.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as FeedbackReport;
    if (body.episode_guid === 'g3') return { ok: false, status: 503 } as Response; // server down
    await flushGate; // slow network for the outbox flush
    return { ok: true, status: 201 } as Response;
  });
  (globalThis as any).fetch = fetchMock;

  const flushing = flushFeedbackOutbox();
  await new Promise((r) => setTimeout(r, 0));
  expect(await submitFeedback(report(3))).toBe('queued');
  releaseFlush();
  expect(await flushing).toBe(2);

  expect(await outboxGuids()).toEqual(['g3']);
});
