import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
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
import { formatMs } from '@/src/player/skipLogic';
import { syncAndroidAutoCatalog } from '@/src/player/androidAutoCatalog';
import { usePlayback } from '@/src/store/PlaybackContext';
import { isAutoQueueEnabled, setAutoQueueEnabled, useQueue } from '@/src/queue/queueStore';
import { showQueueActions } from '@/src/queue/queueActions';
import { isPlayed, usePlayedVersion } from '@/src/played/playedStore';
import { ShowSettingsCard } from '@/components/ShowSettingsCard';
import type { Episode, PodcastSearchResult } from '@/src/types';
import { theme } from '@/constants/Colors';
import { listEpisodes } from '@/src/ui/episodeList';
import { htmlToPlainText } from '@/src/ui/htmlText';
import { displayFontFamily } from '@/constants/Typography';

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
  const router = useRouter();
  const { episode: currentEpisode, openEpisode, setEpisodePlayed, setPodcastAdDetection, setPodcastSkipSetting } = usePlayback();
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

  const onToggleAdDetection = async (enabled: boolean) => {
    if (!show?.feedUrl) return;
    setAdDetectionEnabled(enabled);
    await setPodcastAdDetection(
      { collectionId: show.collectionId, feedUrl: show.feedUrl },
      enabled,
    );
  };

  const onToggleAutoQueue = async (enabled: boolean) => {
    if (!show?.feedUrl) return;
    setAutoQueue(enabled);
    // Everything already listed counts as seen: only later releases are added.
    await setAutoQueueEnabled(
      { collectionId: show.collectionId, feedUrl: show.feedUrl },
      enabled,
      episodes,
    );
  };

  const onToggleSkipSetting = async (
    setting: keyof PodcastSkipSettings,
    enabled: boolean,
  ) => {
    if (!show?.feedUrl || !skipSettings) return;
    const updated = { ...skipSettings, [setting]: enabled };
    setSkipSettings(updated);
    await setPodcastSkipSetting(
      { collectionId: show.collectionId, feedUrl: show.feedUrl },
      { [setting]: enabled },
    );
  };

  const onPlay = (ep: Episode) => {
    // Open the same player screen without loading audio or starting analysis;
    // playback + auto-analyze start on the first Play tap there.
    // openEpisode sets state synchronously before navigating, so Now Playing
    // does not mount on the empty "Nothing playing" flash.
    try {
      openEpisode(ep);
      router.push('/now-playing' as Href);
    } catch (err) {
      console.error('[podcast-detail] Failed to open episode:', err);
    }
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
  const onSetPlayed = async (ep: Episode, value: boolean) => {
    await setEpisodePlayed(ep, value);
    void refreshPositions(episodesRef.current);
  };

  const displayedEpisodes = listedEpisodes.slice(0, visibleCount);
  const queuedGuids = new Set(queue.map((e) => e.guid));
  const hasMoreEpisodes =
    displayedEpisodes.length < listedEpisodes.length || (rssHasMore && !!getCachedRssXml(feedMeta.current?.feedUrl ?? ''));

  const aboutText = useMemo(() => htmlToPlainText(about ?? undefined), [about]);
  // ~3 lines; shorter descriptions show in full with no toggle.
  const aboutIsLong = aboutText.length > 180 || aboutText.split('\n').length > 3;

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: show?.collectionName ?? 'Podcast',
          headerStyle: { backgroundColor: theme.background },
          headerTintColor: theme.text,
          headerTitleStyle: { fontFamily: displayFontFamily, fontSize: 20, fontWeight: '600' },
          headerShadowVisible: false,
        }}
      />
      {loading && !show && <ActivityIndicator color={theme.accent} style={{ marginTop: 24 }} />}
      {error && <Text style={styles.error}>{error}</Text>}
      <FlatList
        data={displayedEpisodes}
        keyExtractor={(item) => item.guid}
        contentContainerStyle={{ paddingBottom: 120 }}
        onEndReached={() => {
          void loadMore();
        }}
        onEndReachedThreshold={0.5}
        ListHeaderComponent={
          show ? (
            <View style={styles.header}>
              {!!(show.artworkUrl600 || show.artworkUrl100) && (
                <Image
                  source={{ uri: show.artworkUrl600 || show.artworkUrl100 }}
                  style={styles.art}
                />
              )}
              <View style={styles.headerMeta}>
                <Text style={styles.showEyebrow}>PODCAST</Text>
                <Text style={styles.title}>{show.collectionName}</Text>
                <Text style={styles.artist}>{show.artistName}</Text>
                <Pressable
                  style={[styles.subBtn, isSub && styles.unsubBtn, subBusy && { opacity: 0.6 }]}
                  onPress={onToggleSubscribe}
                  disabled={subBusy}>
                  <Text style={[styles.subText, isSub && styles.unsubText]}>
                    {isSub ? 'Unsubscribe' : 'Subscribe'}
                  </Text>
                </Pressable>
              </View>
              {!!aboutText && (
                <View style={styles.about}>
                  <Text style={styles.aboutText} numberOfLines={aboutExpanded || !aboutIsLong ? undefined : 3}>
                    {aboutText}
                  </Text>
                  {aboutIsLong && (
                    <Pressable
                      onPress={() => setAboutExpanded((v) => !v)}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={aboutExpanded ? 'Show less of the description' : 'Show the full description'}>
                      <Text style={styles.aboutToggle}>{aboutExpanded ? 'Less' : 'More'}</Text>
                    </Pressable>
                  )}
                </View>
              )}
              <ShowSettingsCard
                autoQueue={autoQueue}
                onAutoQueueChange={onToggleAutoQueue}
                adDetectionEnabled={adDetectionEnabled}
                onAdDetectionChange={onToggleAdDetection}
                skipSettings={skipSettings}
                onSkipSettingChange={onToggleSkipSetting}
              />
              <View style={styles.epHeadingRow}>
                <Text style={styles.epHeading}>Episodes</Text>
              </View>
              <View style={styles.listToggles}>
                <ListToggle
                  label="Hide played"
                  on={listPrefs.hidePlayed}
                  onPress={() => onListPrefChange({ hidePlayed: !listPrefs.hidePlayed })}
                />
                <ListToggle
                  label="Oldest first"
                  on={listPrefs.oldestFirst}
                  onPress={() => onListPrefChange({ oldestFirst: !listPrefs.oldestFirst })}
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
                ? 'Every episode loaded so far is played. Turn off “Hide played” to see them.'
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
          const showResume =
            pos && isMeaningfulPosition(pos.positionMs, dur);
          const played = isPlayed(item.guid);
          const pct =
            showResume && dur && dur > 0
              ? Math.min(99, Math.round((pos.positionMs / dur) * 100))
              : null;
          return (
            <Pressable
              style={[styles.epRow, !item.enclosureUrl && styles.epDisabled, played && styles.epPlayed]}
              onPress={() => onPlay(item)}
              disabled={!item.enclosureUrl}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.epTitle} numberOfLines={2}>
                  {item.title}
                </Text>
                <Text style={styles.epMeta}>
                  {item.pubDate ? new Date(item.pubDate).toLocaleDateString() : ''}
                  {item.duration ? ` · ${item.duration}` : ''}
                  {!item.enclosureUrl ? ' · no audio' : ''}
                  {played ? ' · ✓ Played' : ''}
                  {queuedGuids.has(item.guid) && item.guid !== currentEpisode?.guid ? ' · Queued' : ''}
                  {showResume
                    ? ` · Resume ${formatMs(pos.positionMs)}${pct != null ? ` (${pct}%)` : ''}`
                    : ''}
                </Text>
                {showResume && dur && dur > 0 ? (
                  <View style={styles.resumeTrack}>
                    <View
                      style={[
                        styles.resumeFill,
                        { width: `${Math.min(100, (pos.positionMs / dur) * 100)}%` as unknown as number },
                      ]}
                    />
                  </View>
                ) : null}
              </View>
              {!!item.enclosureUrl && (
                <Pressable
                  onPress={() =>
                    showQueueActions(item, {
                      isCurrent: item.guid === currentEpisode?.guid,
                      onSetPlayed: (ep, v) => void onSetPlayed(ep, v),
                    })
                  }
                  hitSlop={8}
                  style={styles.moreBtn}
                  accessibilityLabel={`Queue actions for ${item.title}`}>
                  <SymbolView
                    name={{ ios: 'ellipsis', android: 'more_vert', web: 'more_vert' }}
                    size={18}
                    tintColor={theme.textMuted}
                  />
                </Pressable>
              )}
              <View style={styles.playChip}>
                <Text style={styles.playChipText}>{played ? '✓' : showResume ? '↻' : '▶'}</Text>
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

/** A pill toggle for the episode list (Hide played / Oldest first). */
function ListToggle({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      style={({ pressed }) => [styles.toggle, on && styles.toggleOn, pressed && { opacity: 0.7 }]}>
      <Text style={[styles.toggleText, on && styles.toggleTextOn]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  listToggles: { flexDirection: 'row', gap: 8, marginTop: 10 },
  toggle: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  toggleOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  toggleText: { color: theme.textSecondary, fontSize: 13, fontWeight: '600' },
  toggleTextOn: { color: theme.text },
  container: {
    flex: 1,
    backgroundColor: theme.background,
    paddingHorizontal: 16,
  },
  header: { marginBottom: 8, paddingTop: 8 },
  art: {
    width: 136,
    height: 136,
    borderRadius: 19,
    backgroundColor: theme.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.border,
    alignSelf: 'center',
    marginBottom: 18,
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  headerMeta: { alignItems: 'center', marginBottom: 20 },
  about: { marginBottom: 20 },
  aboutText: { color: theme.textSecondary, fontSize: 14, lineHeight: 20 },
  aboutToggle: { color: theme.accentSoft, fontWeight: '600', fontSize: 14, marginTop: 6 },
  showEyebrow: {
    color: theme.accentSoft,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    marginBottom: 6,
  },
  title: {
    color: theme.text,
    fontFamily: displayFontFamily,
    fontSize: 27,
    fontWeight: '600',
    textAlign: 'center',
    letterSpacing: -0.3,
    lineHeight: 33,
    paddingHorizontal: 10,
  },
  artist: {
    color: theme.textSecondary,
    marginVertical: 6,
    fontSize: 14,
  },
  subBtn: {
    backgroundColor: theme.accent,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 22,
    marginTop: 8,
  },
  unsubBtn: {
    backgroundColor: theme.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.border,
  },
  subText: { color: '#fff', fontWeight: '700' },
  unsubText: { color: theme.danger },

  epHeadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 20,
    marginBottom: 4,
    gap: 8,
  },
  epHeading: {
    color: theme.text,
    fontFamily: displayFontFamily,
    fontSize: 22,
    fontWeight: '600',
  },
  sourceHint: {
    color: theme.textMuted,
    fontSize: 12,
    marginBottom: 8,
  },
  epRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
    gap: 12,
  },
  epDisabled: { opacity: 0.45 },
  epPlayed: { opacity: 0.55 },
  epTitle: { color: theme.text, fontSize: 15, fontWeight: '600' },
  epMeta: { color: theme.textMuted, fontSize: 12, marginTop: 4 },
  resumeTrack: {
    height: 3,
    borderRadius: 2,
    backgroundColor: theme.progressTrack,
    marginTop: 8,
    overflow: 'hidden',
  },
  resumeFill: {
    height: 3,
    borderRadius: 2,
    backgroundColor: theme.progressFill,
  },
  moreBtn: { width: 28, height: 36, alignItems: 'center', justifyContent: 'center' },
  playChip: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: theme.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playChipText: { color: theme.accent, fontSize: 12, fontWeight: '700' },
  error: { color: theme.danger, marginTop: 16 },
  loadMore: {
    color: theme.textMuted,
    textAlign: 'center',
    fontSize: 12,
    paddingVertical: 16,
  },
  empty: {
    color: theme.textMuted,
    textAlign: 'center',
    marginTop: 24,
    fontSize: 14,
  },
});
