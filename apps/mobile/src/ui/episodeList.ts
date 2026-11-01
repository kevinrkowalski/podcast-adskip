import type { Episode } from '@/src/types';
import type { EpisodeListPrefs } from '@/src/db/storage';

/**
 * The episodes a show page lists, from `episodes` (newest first): played ones left out
 * when `hidePlayed`, reversed when `oldestFirst`. Returns the input when nothing applies.
 */
export function listEpisodes(
  episodes: Episode[],
  prefs: EpisodeListPrefs,
  isPlayed: (guid: string) => boolean,
): Episode[] {
  const kept = prefs.hidePlayed ? episodes.filter((e) => !isPlayed(e.guid)) : episodes;
  return prefs.oldestFirst ? [...kept].reverse() : kept;
}
