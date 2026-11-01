/// <reference types="jest" />
import type { Episode } from '@/src/types';
import { listEpisodes } from './episodeList';

const ep = (guid: string): Episode => ({ guid, title: guid, feedUrl: 'https://f/feed' });
const newestFirst = [ep('e3'), ep('e2'), ep('e1')];
const played = new Set(['e2']);
const isPlayed = (g: string) => played.has(g);
const ids = (eps: Episode[]) => eps.map((e) => e.guid);

test('default: as loaded, newest first, played included', () => {
  expect(listEpisodes(newestFirst, { hidePlayed: false, oldestFirst: false }, isPlayed)).toBe(newestFirst);
});

test('hide played and oldest first, alone and together', () => {
  expect(ids(listEpisodes(newestFirst, { hidePlayed: true, oldestFirst: false }, isPlayed))).toEqual(['e3', 'e1']);
  expect(ids(listEpisodes(newestFirst, { hidePlayed: false, oldestFirst: true }, isPlayed))).toEqual(['e1', 'e2', 'e3']);
  expect(ids(listEpisodes(newestFirst, { hidePlayed: true, oldestFirst: true }, isPlayed))).toEqual(['e1', 'e3']);
  expect(ids(newestFirst)).toEqual(['e3', 'e2', 'e1']); // input untouched
});
