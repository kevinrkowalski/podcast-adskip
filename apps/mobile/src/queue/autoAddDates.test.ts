/// <reference types="jest" />
import type { Episode } from '@/src/types';
import { detectNewEpisodes, enableAutoQueueState } from './queueLogic';

const ep = (guid: string, pubDate: string): Episode => ({
  guid,
  title: guid,
  pubDate,
  enclosureUrl: `https://cdn/${guid}.mp3`,
  feedUrl: 'https://f.example/feed',
});
const day = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-11-01T00:00:00Z');

test('a future-dated episode does not stop later episodes being auto-added', () => {
  let state = enableAutoQueueState([ep('old', '2026-10-01T00:00:00Z')], now);
  let r = detectNewEpisodes(state, [ep('typo', '2062-11-03T00:00:00Z'), ep('old', '2026-10-01T00:00:00Z')], now);
  expect(r.toAdd.map((e) => e.guid)).toEqual(['typo']); // it is a real, new episode
  expect(r.state.lastSeenPubMs).toBeLessThanOrEqual(now);

  state = r.state;
  r = detectNewEpisodes(state, [ep('real', '2026-11-08T00:00:00Z'), ep('typo', '2062-11-03T00:00:00Z')], now + 7 * day);
  expect(r.toAdd.map((e) => e.guid)).toEqual(['real']);
});

test('a show whose saved marker is already in the future recovers', () => {
  const stuck = { ...enableAutoQueueState([], now), lastSeenPubMs: Date.parse('2062-11-03T00:00:00Z') };
  const r = detectNewEpisodes(stuck, [ep('real', '2026-11-05T00:00:00Z')], now + 7 * day);
  expect(r.toAdd.map((e) => e.guid)).toEqual(['real']);
  expect(r.state.lastSeenPubMs).toBeLessThanOrEqual(now + 7 * day);
});

test('turning auto-add on with a future-dated episode in the feed still works', () => {
  const state = enableAutoQueueState([ep('typo', '2062-01-01T00:00:00Z')], now);
  expect(state.lastSeenPubMs).toBe(now);
  const r = detectNewEpisodes(state, [ep('real', '2026-11-03T00:00:00Z')], now + 2 * day);
  expect(r.toAdd.map((e) => e.guid)).toEqual(['real']);
});
