import { useEffect, useState } from 'react';
import { findEpisodeChapters } from '@/src/api/rss';
import { resolveFeedUrl } from '@/src/db/storage';
import type { Chapter, Episode } from '@/src/types';

/** Index of the chapter playing at `positionMs` (the last one started), or -1. */
export function currentChapterIndex(chapters: Chapter[], positionMs: number): number {
  let index = -1;
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i].startMs <= positionMs) index = i;
    else break;
  }
  return index;
}

/**
 * The episode's chapters from its feed (empty when it has none, or while loading).
 * Loaded once per episode; the feed is usually already in memory.
 */
export function useChapters(episode: Episode | null): { chapters: Chapter[]; loading: boolean } {
  const guid = episode?.guid;
  const [state, setState] = useState<{ guid?: string; chapters: Chapter[]; loading: boolean }>({
    chapters: [],
    loading: false,
  });

  useEffect(() => {
    if (!episode || !guid) {
      setState({ chapters: [], loading: false });
      return;
    }
    let cancelled = false;
    setState({ guid, chapters: [], loading: true });
    void (async () => {
      try {
        const feedUrl = await resolveFeedUrl(episode);
        const chapters = feedUrl
          ? await findEpisodeChapters(feedUrl, guid, {
              enclosureUrl: episode.enclosureUrl,
              title: episode.title,
            })
          : [];
        if (!cancelled) setState({ guid, chapters, loading: false });
      } catch (error) {
        console.warn('[chapters] Could not load chapters:', error);
        if (!cancelled) setState({ guid, chapters: [], loading: false });
      }
    })();
    return () => {
      cancelled = true;
    };
    // Per episode: later metadata updates (show notes arriving) don't refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guid]);

  return state.guid === guid ? state : { chapters: [], loading: !!guid };
}
