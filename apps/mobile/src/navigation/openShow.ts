import type { useRouter } from 'expo-router';
type Router = ReturnType<typeof useRouter>;
import { getSubscriptions } from '@/src/db/storage';
import type { Episode } from '@/src/types';
import { syntheticCollectionId } from '@/src/import/importOpml';
import { normalizeFeedUrl } from '@/src/import/opml';

export type ShowRouteParams = {
  id: string;
  feedUrl?: string;
  title?: string;
  artwork?: string;
};

function normFeed(url?: string): string {
  return (url ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
}

/** Resolve the show page params for an episode (works for unsubscribed / RSS-only shows). */
export async function showParamsForEpisode(episode: Episode): Promise<ShowRouteParams | null> {
  let id = episode.collectionId;
  if (id == null || !Number.isFinite(id)) {
    const want = normFeed(episode.feedUrl);
    const sub = want
      ? (await getSubscriptions()).find((s) => normFeed(s.feedUrl) === want)
      : undefined;
    id = sub?.collectionId;
  }
  if (id == null && !episode.feedUrl) return null;
  // Unknown show: use the same stable synthetic id that RSS/OPML imports use.
  if (id == null) id = syntheticCollectionId(normalizeFeedUrl(episode.feedUrl), new Set());
  const params: ShowRouteParams = { id: String(id) };
  if (episode.feedUrl) params.feedUrl = episode.feedUrl;
  if (episode.podcastTitle) params.title = episode.podcastTitle;
  if (episode.artworkUrl) params.artwork = episode.artworkUrl;
  return params;
}

type NavLike = {
  getState?: () => { routes: { name: string; params?: object }[]; index: number } | undefined;
  getParent?: () => NavLike | undefined;
};

/**
 * Open the show page for an episode. From the full-screen player we replace the
 * player (or pop back to the same show page if that is what is underneath), so
 * Back from the show returns to wherever the user was before opening the player.
 */
export async function openShowForEpisode(
  router: Router,
  episode: Episode,
  opts: { fromPlayer?: boolean; navigation?: NavLike } = {},
): Promise<void> {
  const params = await showParamsForEpisode(episode);
  if (!params) return;
  const href = { pathname: '/podcast/[id]' as const, params };
  if (!opts.fromPlayer) {
    router.push(href);
    return;
  }
  try {
    const state = opts.navigation?.getState?.();
    const prev = state && state.index > 0 ? state.routes[state.index - 1] : undefined;
    const prevId = (prev?.params as { id?: string } | undefined)?.id;
    if (prev?.name === 'podcast/[id]' && prevId === params.id) {
      router.back();
      return;
    }
  } catch {
    // fall through to replace
  }
  router.replace(href);
}
