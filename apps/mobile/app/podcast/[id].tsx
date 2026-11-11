import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { lookupPodcastWithEpisodes } from '@/src/api/itunes';
import {
  getCachedRssXml,
  loadRssEpisodesCached,
  parseMoreFromCachedXml,
} from '@/src/api/rss';
import {
  getPlaybackPositions,
  getSubscriptions,
  isPodcastAdDetectionEnabled,
  getPodcastSkipSettings,
  getEpisodeListPrefs,
  isMeaningfulPosition,
  setEpisodeListPrefs,
  type EpisodeListPrefs,
  subscribe,
  unsubscribe,
  type PlaybackPosition,
  type PodcastSkipSettings,
} from '@/src/db/storage';
import { formatDurationWords } from '@/src/player/adSkipLine';
import { syncAndroidAutoCatalog } from '@/src/player/androidAutoCatalog';
import { usePlayback } from '@/src/store/PlaybackContext';
import { isAutoQueueEnabled, useQueue } from '@/src/queue/queueStore';
import { isPlayed, usePlayedVersion } from '@/src/played/playedStore';
import { EpisodeProgress } from '@/components/EpisodeProgress';
import { FloatingMiniPlayer } from '@/components/MiniPlayer';
import { ShowSettingsSheet } from '@/components/ShowSettingsSheet';
import { Button, Chip, Cover, Divider, Group, Icon, Sheet, ToggleRow, type } from '@/components/ui';
import { showEpisodeSheet } from '@/src/ui/overlayBus';
import type { Episode, PodcastSearchResult } from '@/src/types';
import { theme } from '@/constants/Colors';
import { listEpisodes } from '@/src/ui/episodeList';
import { htmlToPlainText } from '@/src/ui/htmlText';
import { font } from '@/constants/Typography';

const EPISODES_PAGE_SIZE = 20;
/** First RSS parse budget — never full archive on open. */
const RSS_INITIAL_ITEMS = 40;
/** Grow in-memory RSS window by this many items when user scrolls for more. */
const RSS_EXPAND_STEP = 40;

function mergeEpisodes(primary: Episode[], secondary: Episode[]): Episode[] {
  const seen = new Set<string>();
  const out: Episode[] = [];
  for (const ep of [...primary, ...secondary]) {
    if (seen.has(ep.guid)) continue;
    seen.add(ep.guid);
    out.push(ep);
  }
  // Feeds are usually newest-first, but sorting keeps the first page correct
  // when iTunes, RSS, and an older cache are merged together.
  return out.sort((a, b) => {
    const aTime = a.pubDate ? Date.parse(a.pubDate) : 0;
    const bTime = b.pubDate ? Date.parse(b.pubDate) : 0;
    return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
  });
}

export default function PodcastDetailScreen() {
  const { id, feedUrl: feedParam, title: titleParam, artwork: artworkParam } = useLocalSearchParams<{
    id: string;
    feedUrl?: string;
    title?: string;
    artwork?: string;
  }>();
  const { episode: currentEpisode, isPlaying, playEpisode, togglePlay } = usePlayback();
  const insets = useSafeAreaInsets();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [show, setShow] = useState<PodcastSearchResult | null>(null);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [visibleCount, setVisibleCount] = useState(EPISODES_PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [expanding, setExpanding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSub, setIsSub] = useState(false);
  const [adDetectionEnabled, setAdDetectionEnabled] = useState(true);
  const [skipSettings, setSkipSettings] = useState<PodcastSkipSettings | null>(null);
  const [autoQueue, setAutoQueue] = useState(false);
  const queue = useQueue();
  const [sourceHint, setSourceHint] = useState<string | null>(null);
  /** The show's description from its feed (HTML), shown as "About". */
  const [about, setAbout] = useState<string | null>(null);
  const [aboutExpanded, setAboutExpanded] = useState(false);
  const [positions, setPositions] = useState<Record<string, PlaybackPosition>>({});
  const [rssHasMore, setRssHasMore] = useState(false);
  const [listPrefs, setListPrefs] = useState<EpisodeListPrefs>({ hidePlayed: false, oldestFirst: false });
  // Each load gets its own generation; anything from an older load (or after
  // unmount) is stale and must not write state.
  const loadGen = useRef(0);
  const unmounted = useRef(false);
  const positionsReq = useRef(0);
  // Mirror of the current episode list so merges happen outside setState updaters.
  const episodesRef = useRef<Episode[]>([]);
  const [subBusy, setSubBusy] = useState(false);
  const subBusyRef = useRef(false);
  const rssMaxItems = useRef(RSS_INITIAL_ITEMS);
  const feedMeta = useRef<{
    collectionId: number;
    podcastTitle: string;
    artworkUrl?: string;
    feedUrl: string;
  } | null>(null);
  const expandingLock = useRef(false);

  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  const refreshPositions = useCallback(async (eps: Episode[]) => {
    const req = ++positionsReq.current;
    const gen = loadGen.current;
    const map = await getPlaybackPositions(eps.map((e) => e.guid));
    // Drop out-of-order reads and anything from a superseded load.
    if (req !== positionsReq.current || gen !== loadGen.current || unmounted.current) return;
    setPositions(map);
  }, []);

  const applyEpisodes = useCallback(
    (next: Episode[]) => {
      episodesRef.current = next;
      setEpisodes(next);
      void refreshPositions(next);
    },
    [refreshPositions],
  );

  const load = useCallback(async () => {
    const gen = ++loadGen.current;
    const isStale = () => gen !== loadGen.current || unmounted.current;
    setLoading(true);
    setVisibleCount(EPISODES_PAGE_SIZE);
    episodesRef.current = [];
    setEpisodes([]);
    setExpanding(false);
    setError(null);
    setSourceHint(null);
    setAbout(null);
    setAboutExpanded(false);
    setAutoQueue(false);
    setListPrefs({ hidePlayed: false, oldestFirst: false });
    setRssHasMore(false);
    setPositions({});
    rssMaxItems.current = RSS_INITIAL_ITEMS;
    feedMeta.current = null;
    try {
      const collectionId = Number(id);
      // Fast path: iTunes show + recent episodes (does not wait on RSS archive).
      // OPML imports that are not in Apple Podcasts fall back to the stored feed.
      let podcast: PodcastSearchResult | null = null;
      let itunesEps: Episode[] = [];
      try {
        const looked = await lookupPodcastWithEpisodes(collectionId, EPISODES_PAGE_SIZE);
        podcast = looked.podcast;
        itunesEps = looked.episodes;
      } catch {
        podcast = null;
      }
      if (isStale()) return;
      if (!podcast?.feedUrl) {
        const stored = (await getSubscriptions()).find((s) => s.collectionId === collectionId);
        if (stored?.feedUrl) {
          podcast = {
            collectionId: stored.collectionId,
            collectionName: stored.collectionName,
            artistName: stored.artistName,
            feedUrl: stored.feedUrl,
            artworkUrl600: stored.artworkUrl,
            artworkUrl100: stored.artworkUrl,
          };
        }
      }
      if (!podcast?.feedUrl && typeof feedParam === 'string' && feedParam) {
        // Opened from the player for a show that isn't subscribed / isn't in Apple
        // Podcasts: build the show from the episode's own feed URL.
        const want = feedParam.trim().toLowerCase();
        const stored = (await getSubscriptions()).find((s) => s.feedUrl.trim().toLowerCase() === want);
        podcast = stored
          ? {
              collectionId: stored.collectionId,
              collectionName: stored.collectionName,
              artistName: stored.artistName,
              feedUrl: stored.feedUrl,
              artworkUrl600: stored.artworkUrl,
              artworkUrl100: stored.artworkUrl,
            }
          : {
              collectionId,
              collectionName: (typeof titleParam === 'string' && titleParam) || 'Podcast',
              artistName: '',
              feedUrl: feedParam,
              artworkUrl600: typeof artworkParam === 'string' ? artworkParam : undefined,
              artworkUrl100: typeof artworkParam === 'string' ? artworkParam : undefined,
            };
      }
      if (isStale()) return;
      if (!podcast?.feedUrl) throw new Error('Podcast or feedUrl not found');
      setShow(podcast);
      const subs = await getSubscriptions();
      if (isStale()) return;
      // The feed-URL fallback can resolve to a stored show with a different id.
      const resolvedId = podcast.collectionId;
      const resolvedFeed = podcast.feedUrl.trim().toLowerCase();
      setIsSub(
        subs.some(
          (s) =>
            s.collectionId === resolvedId ||
            (!!s.feedUrl && s.feedUrl.trim().toLowerCase() === resolvedFeed),
        ),
      );

      const meta = {
        collectionId,
        podcastTitle: podcast.collectionName,
        artworkUrl: podcast.artworkUrl600 || podcast.artworkUrl100,
        feedUrl: podcast.feedUrl,
      };
      feedMeta.current = meta;
      const adEnabled = await isPodcastAdDetectionEnabled(meta);
      if (isStale()) return;
      setAdDetectionEnabled(adEnabled);
      const skip = await getPodcastSkipSettings(meta);
      if (isStale()) return;
      setSkipSettings(skip);
      const aq = await isAutoQueueEnabled(meta);
      if (isStale()) return;
      setAutoQueue(aq);
      const prefs = await getEpisodeListPrefs(meta);
      if (isStale()) return;
      setListPrefs(prefs);

      if (itunesEps.length) {
        applyEpisodes(mergeEpisodes(itunesEps, []));
        setSourceHint(`Showing the ${itunesEps.length} most recent from iTunes`);
        setLoading(false);
      }

      // Disk cache + bounded RSS refresh — never await full archive on open.
      const { cached, refreshed } = await loadRssEpisodesCached(podcast.feedUrl, meta, {
        maxItems: RSS_INITIAL_ITEMS,
        onUpdate: (parsed) => {
          if (isStale()) return;
          if (parsed.description?.trim()) setAbout(parsed.description);
          applyEpisodes(mergeEpisodes(parsed.episodes, episodesRef.current));
          setRssHasMore(!!parsed.truncated);
          setSourceHint(
            parsed.episodes.length
              ? `${parsed.episodes.length} episodes${parsed.truncated ? '+' : ''} from RSS`
              : null,
          );
        },
      });

      if (isStale()) return;

      if (cached.length) {
        // Saved copies keep a shortened description; the feed refresh fills in the rest.
        const savedAbout = cached.find((e) => e.podcastDescription?.trim())?.podcastDescription;
        if (savedAbout) setAbout((cur) => cur ?? savedAbout);
        applyEpisodes(mergeEpisodes(cached, episodesRef.current));
        if (!itunesEps.length) {
          setSourceHint(`${cached.length} cached episodes`);
        }
        setLoading(false);
      } else {
        setLoading(false);
      }

      // Fire-and-forget: surface soft failure only if we have nothing else.
      refreshed.catch((rssErr) => {
        if (isStale()) return;
        if (episodesRef.current.length === 0) {
          setError(rssErr instanceof Error ? rssErr.message : 'Failed to load feed');
        } else {
          setSourceHint((h) => h ?? 'RSS refresh failed · showing available episodes');
        }
      });
    } catch (e) {
      if (isStale()) return;
      setError(e instanceof Error ? e.message : 'Failed to load');
      setLoading(false);
    }
  }, [id, feedParam, titleParam, artworkParam, applyEpisodes]);

  useEffect(() => {
    load();
    return () => {
      // Invalidate this load when params change or the screen unmounts.
      loadGen.current++;
    };
  }, [load]);

  const onToggleSubscribe = async () => {
    if (!show?.feedUrl || subBusyRef.current) return;
    subBusyRef.current = true;
    setSubBusy(true);
    const wasSub = isSub;
    try {
      if (wasSub) {
        await unsubscribe(show.collectionId);
      } else {
        await subscribe({
          collectionId: show.collectionId,
          collectionName: show.collectionName,
          artistName: show.artistName,
          feedUrl: show.feedUrl,
          artworkUrl: show.artworkUrl600 || show.artworkUrl100,
          subscribedAt: new Date().toISOString(),
        });
      }
      if (!unmounted.current) setIsSub(!wasSub);
      await syncAndroidAutoCatalog();
    } catch (e) {
      Alert.alert(
        wasSub ? 'Could not unsubscribe' : 'Could not subscribe',
        e instanceof Error ? e.message : 'Please try again.',
      );
    } finally {
      subBusyRef.current = false;
      if (!unmounted.current) setSubBusy(false);
    }
  };

  /** Tap a row: notes and actions in the episode sheet (the loaded episode opens the player). */
  const onOpen = (ep: Episode) => showEpisodeSheet(ep);

  /** The row's play button: start it now, or pause/resume if it is the loaded episode. */
  const onPlayPress = (ep: Episode) => {
    if (ep.guid === currentEpisode?.guid) void togglePlay();
    else void playEpisode(ep);
  };

  const playedVersion = usePlayedVersion();
  // What the list shows: played episodes left out when asked, oldest first when asked
  // (`episodes` itself is always newest first).
  const listedEpisodes = useMemo(
    () => listEpisodes(episodes, listPrefs, isPlayed),
    // playedVersion: re-filter when episodes are marked played/unplayed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [episodes, listPrefs, playedVersion],
  );

  // Oldest first needs the whole archive (the page reads the newest items first): parse
  // the rest of the already-downloaded feed once it's in memory.
  useEffect(() => {
    if (!listPrefs.oldestFirst || !rssHasMore) return;
    const meta = feedMeta.current;
    if (!meta?.feedUrl || !getCachedRssXml(meta.feedUrl)) return;
    const parsed = parseMoreFromCachedXml(meta.feedUrl, meta);
    if (!parsed) return;
    rssMaxItems.current = parsed.episodes.length;
    setRssHasMore(false);
    applyEpisodes(mergeEpisodes(parsed.episodes, episodesRef.current));
    setSourceHint(`${parsed.episodes.length} episodes from RSS`);
  }, [listPrefs.oldestFirst, rssHasMore, applyEpisodes]);

  const onListPrefChange = (patch: Partial<EpisodeListPrefs>) => {
    setListPrefs((cur) => ({ ...cur, ...patch }));
    setVisibleCount(EPISODES_PAGE_SIZE);
    const meta = feedMeta.current;
    if (meta) void setEpisodeListPrefs(meta, patch);
  };

  const loadMore = useCallback(async () => {
    if (expandingLock.current || unmounted.current) return;
    const gen = loadGen.current;
    const isStale = () => gen !== loadGen.current || unmounted.current;

    // First page more from what we already have in memory.
    if (visibleCount < listedEpisodes.length) {
      setVisibleCount((count) => Math.min(count + EPISODES_PAGE_SIZE, listedEpisodes.length));
      return;
    }

    // Need more episodes: expand from cached XML (preferred) without blocking open.
    const meta = feedMeta.current;
    if (!meta?.feedUrl || !rssHasMore) return;
    if (!getCachedRssXml(meta.feedUrl)) return;

    expandingLock.current = true;
    setExpanding(true);
    try {
      const nextMax = rssMaxItems.current + RSS_EXPAND_STEP;
      const parsed = parseMoreFromCachedXml(meta.feedUrl, meta, nextMax);
      if (isStale() || !parsed) return;
      rssMaxItems.current = nextMax;
      setRssHasMore(!!parsed.truncated);
      applyEpisodes(mergeEpisodes(parsed.episodes, episodesRef.current));
      setVisibleCount((count) => count + EPISODES_PAGE_SIZE);
      setSourceHint(
        `${parsed.episodes.length} episodes${parsed.truncated ? '+' : ''} from RSS`,
      );
    } finally {
      expandingLock.current = false;
      if (!isStale()) setExpanding(false);
    }
  }, [listedEpisodes.length, applyEpisodes, rssHasMore, visibleCount]);

  // Progress bars: re-read saved positions when coming back from the player.
  useFocusEffect(
    useCallback(() => {
      if (episodesRef.current.length) void refreshPositions(episodesRef.current);
    }, [refreshPositions]),
  );
  const displayedEpisodes = listedEpisodes.slice(0, visibleCount);
  const queuedGuids = new Set(queue.map((e) => e.guid));
  const hasMoreEpisodes =
    displayedEpisodes.length < listedEpisodes.length || (rssHasMore && !!getCachedRssXml(feedMeta.current?.feedUrl ?? ''));

  const aboutText = useMemo(() => htmlToPlainText(about ?? undefined), [about]);
  // ~3 lines; shorter descriptions show in full with no toggle.
  const aboutIsLong = aboutText.length > 180 || aboutText.split('\n').length > 3;

  const artwork = show?.artworkUrl600 || show?.artworkUrl100;
  const filterLabel = `${listPrefs.hidePlayed ? 'Unplayed' : 'All'} · ${listPrefs.oldestFirst ? 'Oldest' : 'Newest'}`;

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: '',
          headerStyle: { backgroundColor: theme.background },
          headerTintColor: theme.text,
          headerShadowVisible: false,
          headerRight: () =>
            show ? (
              <Pressable
                onPress={() => setSettingsOpen(true)}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="Show settings"
                style={styles.headerBtn}>
                <Icon name="tune" size={22} color={theme.text} />
              </Pressable>
            ) : null,
        }}
      />
      {loading && !show && <ActivityIndicator color={theme.accent} style={{ marginTop: 24 }} />}
      {error && <Text style={styles.error}>{error}</Text>}
      <FlatList
        data={displayedEpisodes}
        keyExtractor={(item) => item.guid}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 96, paddingHorizontal: 20 }}
        onEndReached={() => {
          void loadMore();
        }}
        onEndReachedThreshold={0.5}
        ListHeaderComponent={
          show ? (
            <View style={styles.header}>
              <View style={styles.hero}>
                <Cover uri={artwork} size={92} />
                <View style={styles.flex}>
                  <Text style={styles.title} numberOfLines={3}>
                    {show.collectionName}
                  </Text>
                  {!!show.artistName && (
                    <Text style={[type.meta, { marginTop: 2 }]} numberOfLines={1}>
                      {show.artistName}
                    </Text>
                  )}
                  <View style={styles.subRow}>
                    {isSub ? (
                      <Chip
                        label="Subscribed"
                        trailing="check"
                        onPress={subBusy ? undefined : onToggleSubscribe}
                        accessibilityLabel="Subscribed. Tap to unsubscribe"
                      />
                    ) : (
                      <Button
                        kind="accent"
                        label="Subscribe"
                        icon="plus"
                        onPress={onToggleSubscribe}
                        disabled={subBusy}
                        style={styles.subBtn}
                      />
                    )}
                  </View>
                </View>
              </View>
              {!!aboutText && (
                <View style={styles.about}>
                  <Text style={type.meta} numberOfLines={aboutExpanded || !aboutIsLong ? undefined : 3}>
                    {aboutText}
                  </Text>
                  {aboutIsLong && (
                    <Pressable
                      onPress={() => setAboutExpanded((v) => !v)}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={aboutExpanded ? 'Show less of the description' : 'Show the full description'}
                      style={{ alignSelf: 'flex-start', marginTop: 6 }}>
                      <Text style={type.link}>{aboutExpanded ? 'Less' : 'More'}</Text>
                    </Pressable>
                  )}
                </View>
              )}
              <Divider style={{ marginTop: 20 }} />
              <View style={styles.epHeadingRow}>
                <Text style={[type.heading, styles.flex]}>Episodes</Text>
                <Chip
                  label={filterLabel}
                  trailing="down"
                  onPress={() => setFilterOpen(true)}
                  accessibilityLabel={`Filter and sort: ${filterLabel}`}
                />
              </View>
              {!!sourceHint && <Text style={styles.sourceHint}>{sourceHint}</Text>}
            </View>
          ) : null
        }
        ListEmptyComponent={
          !loading && !error && show ? (
            <Text style={styles.empty}>
              {listPrefs.hidePlayed && episodes.length
                ? 'Every episode loaded so far is played. Change the filter to see them.'
                : 'No episodes found yet.'}
            </Text>
          ) : null
        }
        ListFooterComponent={
          expanding ? (
            <ActivityIndicator color={theme.accent} style={{ marginVertical: 16 }} />
          ) : hasMoreEpisodes ? (
            <Text style={styles.loadMore}>Scroll for more episodes</Text>
          ) : null
        }
        renderItem={({ item }) => {
          const pos = positions[item.guid];
          const dur = pos?.durationMs ?? item.durationMs;
          const showResume = !!pos && isMeaningfulPosition(pos.positionMs, dur);
          const played = isPlayed(item.guid);
          const isCurrent = item.guid === currentEpisode?.guid;
          const date = item.pubDate ? Date.parse(item.pubDate) : NaN;
          const meta = [
            Number.isFinite(date)
              ? new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
              : null,
            showResume && dur && dur > pos.positionMs
              ? `${formatDurationWords(dur - pos.positionMs)} left`
              : item.duration,
            !item.enclosureUrl ? 'no audio' : null,
            played ? 'Played' : null,
            isCurrent ? 'Playing' : queuedGuids.has(item.guid) ? 'In queue' : null,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <View style={[styles.epRow, played && !isCurrent && styles.epPlayed]}>
              <Pressable
                style={({ pressed }) => [styles.flex, pressed && { opacity: 0.6 }]}
                onPress={() => onOpen(item)}
                accessibilityRole="button"
                accessibilityLabel={`${item.title}. ${meta}`}>
                <Text style={type.metaMuted} numberOfLines={1}>
                  {meta}
                </Text>
                <Text style={[type.title, { marginTop: 3 }]} numberOfLines={2}>
                  {item.title}
                </Text>
                {showResume && dur && dur > 0 ? (
                  <EpisodeProgress positionMs={pos.positionMs} durationMs={dur} />
                ) : null}
              </Pressable>
              {!!item.enclosureUrl && (
                <Pressable
                  onPress={() => onPlayPress(item)}
                  hitSlop={8}
                  style={({ pressed }) => [styles.playBtn, pressed && { opacity: 0.6 }]}
                  accessibilityRole="button"
                  accessibilityLabel={isCurrent && isPlaying ? `Pause ${item.title}` : `Play ${item.title}`}>
                  <Icon name={isCurrent && isPlaying ? 'pause' : 'play'} size={20} color={theme.text} />
                </Pressable>
              )}
            </View>
          );
        }}
      />
      <FloatingMiniPlayer />
      <ShowSettingsSheet
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        show={show ? { collectionId: show.collectionId, feedUrl: show.feedUrl, title: show.collectionName } : null}
        knownEpisodes={episodes}
      />
      <Sheet visible={filterOpen} onClose={() => setFilterOpen(false)} title="Episodes">
        <Group>
          <ToggleRow
            label="Hide played"
            value={listPrefs.hidePlayed}
            onChange={(v) => onListPrefChange({ hidePlayed: v })}
          />
          <Divider />
          <ToggleRow
            label="Oldest first"
            hint="For shows you listen to in order"
            value={listPrefs.oldestFirst}
            onChange={(v) => onListPrefChange({ oldestFirst: v })}
          />
        </Group>
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  flex: { flex: 1, minWidth: 0 },
  headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  header: { paddingTop: 4 },
  hero: { flexDirection: 'row', gap: 16 },
  title: { fontFamily: font.display, fontSize: 22, lineHeight: 27, letterSpacing: -0.2, color: theme.text },
  subRow: { flexDirection: 'row', marginTop: 12 },
  subBtn: { minHeight: 36, paddingHorizontal: 14 },
  about: { marginTop: 16 },
  epHeadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 18, marginBottom: 4 },
  sourceHint: { fontFamily: font.body, fontSize: 12, color: theme.textMuted, marginBottom: 2 },
  epRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  epPlayed: { opacity: 0.55 },
  playBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: theme.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  error: { fontFamily: font.body, color: theme.danger, marginTop: 16, paddingHorizontal: 20 },
  loadMore: { fontFamily: font.body, color: theme.textMuted, textAlign: 'center', fontSize: 12, paddingVertical: 16 },
  empty: { fontFamily: font.body, color: theme.textMuted, marginTop: 24, fontSize: 14, lineHeight: 20 },
});
