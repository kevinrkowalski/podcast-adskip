import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Link, useFocusEffect, useRouter } from 'expo-router';
import { cleanFeedUrlInput, subscribeByFeedUrl } from '@/src/import/importOpml';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  fetchTopPodcasts,
  PODCAST_CHART_GENRES,
  searchPodcasts,
} from '@/src/api/itunes';
import { subscribe, getSubscriptions } from '@/src/db/storage';
import type { PodcastSearchResult } from '@/src/types';
import { theme } from '@/constants/Colors';
import { displayFontFamily } from '@/constants/Typography';
import { syncAndroidAutoCatalog } from '@/src/player/androidAutoCatalog';

const NUM_COLUMNS = 3;
const H_PAD = 16;
const GAP = 10;

/** Apple's chart is one request with no paging; 200 is its maximum, so show it all. */
const CHART_LIMIT = 200;

export default function SearchScreen() {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PodcastSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subscribedIds, setSubscribedIds] = useState<Set<number>>(new Set());

  const [genreId, setGenreId] = useState<number | null>(null);
  const [chartItems, setChartItems] = useState<PodcastSearchResult[]>([]);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);
  const chartReqId = useRef(0);
  const searchReqId = useRef(0);
  const subBusy = useRef<Set<number>>(new Set());
  const [subBusyIds, setSubBusyIds] = useState<Set<number>>(new Set());

  const router = useRouter();
  const [rssOpen, setRssOpen] = useState(false);
  const [rssUrl, setRssUrl] = useState('');
  const [rssBusy, setRssBusy] = useState(false);
  const [rssError, setRssError] = useState<string | null>(null);
  const [rssNote, setRssNote] = useState<string | null>(null);

  const showDiscover = !query.trim();

  const screenW = Dimensions.get('window').width;
  const tileSize = (screenW - H_PAD * 2 - GAP * (NUM_COLUMNS - 1)) / NUM_COLUMNS;

  const refreshSubs = useCallback(async () => {
    const subs = await getSubscriptions();
    setSubscribedIds(new Set(subs.map((s) => s.collectionId)));
  }, []);

  const loadCharts = useCallback(async (id: number | null) => {
    const req = ++chartReqId.current;
    setChartLoading(true);
    setChartError(null);
    try {
      const items = await fetchTopPodcasts(id, CHART_LIMIT);
      if (req !== chartReqId.current) return;
      setChartItems(items);
    } catch (e) {
      if (req !== chartReqId.current) return;
      setChartError(e instanceof Error ? e.message : 'Failed to load charts');
      setChartItems([]);
    } finally {
      if (req === chartReqId.current) setChartLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!showDiscover) return;
    void loadCharts(genreId);
  }, [showDiscover, genreId, loadCharts]);

  useEffect(() => {
    if (showDiscover) void refreshSubs().catch((e) => console.warn('refreshSubs failed', e));
  }, [showDiscover, refreshSubs]);

  // Tab screens stay mounted; pick up (un)subscribes made on other screens.
  useFocusEffect(
    useCallback(() => {
      void refreshSubs().catch((e) => console.warn('refreshSubs failed', e));
    }, [refreshSubs]),
  );

  const onChangeQuery = (text: string) => {
    setQuery(text);
    if (!text.trim()) {
      // Invalidate any in-flight search so its results don't land in hidden state.
      searchReqId.current++;
      setResults([]);
      setError(null);
      setLoading(false);
    }
  };

  const onSearch = useCallback(async () => {
    if (!query.trim()) return;
    const req = ++searchReqId.current;
    setLoading(true);
    setError(null);
    try {
      await refreshSubs();
      const items = await searchPodcasts(query.trim());
      if (req !== searchReqId.current) return;
      setResults(items);
    } catch (e) {
      if (req !== searchReqId.current) return;
      setError(e instanceof Error ? e.message : 'Search failed');
    } finally {
      if (req === searchReqId.current) setLoading(false);
    }
  }, [query, refreshSubs]);

  const onSubscribe = async (item: PodcastSearchResult) => {
    if (!item.feedUrl) return;
    const id = item.collectionId;
    if (subBusy.current.has(id)) return;
    subBusy.current.add(id);
    setSubBusyIds(new Set(subBusy.current));
    try {
      await subscribe({
        collectionId: item.collectionId,
        collectionName: item.collectionName,
        artistName: item.artistName,
        feedUrl: item.feedUrl,
        artworkUrl: item.artworkUrl600 || item.artworkUrl100,
        subscribedAt: new Date().toISOString(),
      });
      await syncAndroidAutoCatalog();
      await refreshSubs();
    } catch (e) {
      Alert.alert('Could not subscribe', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      subBusy.current.delete(id);
      setSubBusyIds(new Set(subBusy.current));
    }
  };

  const onAddRss = async () => {
    if (rssBusy) return;
    setRssError(null);
    setRssNote(null);
    if (!cleanFeedUrlInput(rssUrl)) {
      setRssError('Enter a valid feed URL, e.g. https://example.com/feed.xml');
      return;
    }
    setRssBusy(true);
    try {
      const res = await subscribeByFeedUrl(rssUrl);
      await refreshSubs();
      setRssNote(
        res.status === 'already'
          ? `Already subscribed to ${res.title}.`
          : `Subscribed to ${res.title}.`,
      );
      setRssUrl('');
      router.push({ pathname: '/podcast/[id]', params: { id: String(res.collectionId) } });
    } catch (e) {
      setRssError(e instanceof Error ? e.message : 'Could not add that feed.');
    } finally {
      setRssBusy(false);
    }
  };

  const rssSection = (
    <View style={styles.rssBox}>
      <Pressable
        onPress={() => {
          setRssOpen((v) => !v);
          setRssError(null);
          setRssNote(null);
        }}
        accessibilityRole="button"
        accessibilityLabel="Add by RSS URL">
        <Text style={styles.rssToggle}>{rssOpen ? '− Add by RSS URL' : '+ Add by RSS URL'}</Text>
      </Pressable>
      {rssOpen && (
        <>
          <View style={[styles.searchRow, { marginTop: 8, marginBottom: 0 }]}>
            <TextInput
              style={styles.input}
              placeholder="https://example.com/feed.xml"
              placeholderTextColor={theme.textMuted}
              value={rssUrl}
              onChangeText={(t) => {
                setRssUrl(t);
                setRssError(null);
              }}
              onSubmitEditing={() => void onAddRss()}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="go"
              editable={!rssBusy}
            />
            <Pressable
              style={[styles.btn, (!rssUrl.trim() || rssBusy) && styles.btnDisabled]}
              onPress={() => void onAddRss()}
              disabled={!rssUrl.trim() || rssBusy}>
              {rssBusy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.btnText}>Add</Text>
              )}
            </Pressable>
          </View>
          {!!rssError && <Text style={[styles.error, { textAlign: 'left' }]}>{rssError}</Text>}
          {!!rssNote && <Text style={styles.rssNote}>{rssNote}</Text>}
          {!rssError && !rssNote && (
            <Text style={styles.rssHint}>
              Paste a podcast feed link. To import many shows, use Settings → Import OPML.
            </Text>
          )}
        </>
      )}
    </View>
  );

  const renderSearchItem = ({ item }: { item: PodcastSearchResult }) => {
    const isSub = subscribedIds.has(item.collectionId);
    const isBusy = subBusyIds.has(item.collectionId);
    const art = item.artworkUrl600 || item.artworkUrl100;
    return (
      <View style={styles.row}>
        {!!art ? (
          <Image source={{ uri: art }} style={styles.art} />
        ) : (
          <View style={[styles.art, styles.artPlaceholder]} />
        )}
        <View style={styles.meta}>
          <Link
            href={{ pathname: '/podcast/[id]', params: { id: String(item.collectionId) } }}
            asChild>
            <Pressable>
              <Text style={styles.title} numberOfLines={2}>
                {item.collectionName}
              </Text>
              <Text style={styles.artist} numberOfLines={1}>
                {item.artistName}
              </Text>
            </Pressable>
          </Link>
        </View>
        <Pressable
          style={[styles.subBtn, isSub && styles.subBtnDone]}
          onPress={() => onSubscribe(item)}
          disabled={isSub || isBusy || !item.feedUrl}>
          <Text style={[styles.subBtnText, isSub && styles.subBtnTextDone]}>
            {isSub ? 'Added' : 'Subscribe'}
          </Text>
        </Pressable>
      </View>
    );
  };

  const renderChartItem = ({
    item,
    index,
  }: {
    item: PodcastSearchResult;
    index: number;
  }) => {
    const art = item.artworkUrl600 || item.artworkUrl100;
    return (
      <Link
        href={{
          pathname: '/podcast/[id]',
          params: { id: String(item.collectionId) },
        }}
        asChild>
        <Pressable
          style={StyleSheet.flatten([styles.chartTile, { width: tileSize }])}
          accessibilityLabel={`${index + 1}. ${item.collectionName}`}>
          {!!art ? (
            <Image
              source={{ uri: art }}
              style={[styles.chartArt, { width: tileSize, height: tileSize }]}
            />
          ) : (
            <View
              style={[
                styles.chartArt,
                styles.artPlaceholder,
                { width: tileSize, height: tileSize },
              ]}
            />
          )}
          <Text style={styles.chartRank}>{index + 1}</Text>
          <Text style={styles.chartTitle} numberOfLines={2}>
            {item.collectionName}
          </Text>
          <Text style={styles.chartArtist} numberOfLines={1}>
            {item.artistName}
          </Text>
        </Pressable>
      </Link>
    );
  };

  const discoverHeader = (
    <View>
      <Text style={styles.discoverHeading}>Discover</Text>
      <Text style={styles.discoverSub}>Top podcasts on Apple Charts · US</Text>

      <ScrollView
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
        keyboardShouldPersistTaps="handled">
        {PODCAST_CHART_GENRES.map((g) => {
          const selected = genreId === g.id;
          return (
            <Pressable
              key={g.label}
              style={[styles.chip, selected && styles.chipSelected]}
              onPress={() => setGenreId(g.id)}>
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                {g.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {chartLoading && (
        <ActivityIndicator color={theme.accent} style={{ marginTop: 28 }} />
      )}
      {!!chartError && !chartLoading && (
        <View style={styles.chartErrorBox}>
          <Text style={styles.error}>{chartError}</Text>
          <Pressable style={styles.retryBtn} onPress={() => void loadCharts(genreId)}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      )}
    </View>
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top + 8 }]}>
      <Text style={styles.eyebrow}>EXPLORE</Text>
      <Text style={styles.heading}>Search podcasts</Text>
      <View style={styles.searchRow}>
        <TextInput
          style={styles.input}
          placeholder="Shows, topics, hosts…"
          placeholderTextColor={theme.textMuted}
          value={query}
          onChangeText={onChangeQuery}
          onSubmitEditing={onSearch}
          returnKeyType="search"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
        <Pressable
          style={[styles.btn, !query.trim() && styles.btnDisabled]}
          onPress={onSearch}
          disabled={!query.trim() || loading}>
          <Text style={styles.btnText}>Search</Text>
        </Pressable>
      </View>
      {rssSection}

      {showDiscover ? (
        <FlatList
          key={`discover-grid-${NUM_COLUMNS}`}
          data={!chartLoading && !chartError ? chartItems : []}
          keyExtractor={(item) => String(item.collectionId)}
          numColumns={NUM_COLUMNS}
          columnWrapperStyle={
            !chartLoading && !chartError && chartItems.length > 0
              ? styles.gridRow
              : undefined
          }
          contentContainerStyle={{ paddingBottom: 120, paddingTop: 12 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={discoverHeader}
          renderItem={renderChartItem}
          ListEmptyComponent={
            !chartLoading && !chartError ? (
              <Text style={styles.empty}>No chart results right now.</Text>
            ) : null
          }
        />
      ) : (
        <>
          {loading && <ActivityIndicator color={theme.accent} style={{ marginTop: 20 }} />}
          {error && <Text style={styles.error}>{error}</Text>}
          <FlatList
            data={results}
            keyExtractor={(item) => String(item.collectionId)}
            contentContainerStyle={{ paddingBottom: 120, paddingTop: 8 }}
            keyboardShouldPersistTaps="handled"
            renderItem={renderSearchItem}
            ListEmptyComponent={
              !loading ? (
                <Text style={styles.empty}>
                  Search Apple Podcasts to find shows and subscribe.
                </Text>
              ) : null
            }
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.background,
    paddingHorizontal: H_PAD,
  },
  eyebrow: {
    color: theme.accentSoft,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.8,
    marginBottom: 3,
  },
  heading: {
    color: theme.text,
    fontFamily: displayFontFamily,
    fontSize: 32,
    fontWeight: '600',
    letterSpacing: -0.6,
    marginBottom: 15,
  },
  searchRow: { flexDirection: 'row', gap: 10, marginBottom: 8 },
  input: {
    flex: 1,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.border,
    paddingHorizontal: 15,
    paddingVertical: 12,
    color: theme.text,
    backgroundColor: theme.surface,
    fontSize: 15,
  },
  btn: {
    backgroundColor: theme.accent,
    borderRadius: 14,
    paddingHorizontal: 18,
    justifyContent: 'center',
  },
  btnDisabled: { opacity: 0.4 },
  rssBox: { marginBottom: 6 },
  rssToggle: { color: theme.accentSoft, fontSize: 13, fontWeight: '700', paddingVertical: 4 },
  rssHint: { color: theme.textMuted, fontSize: 12, marginTop: 6 },
  rssNote: { color: theme.textSecondary, fontSize: 13, marginTop: 6 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  discoverHeading: {
    color: theme.text,
    fontFamily: displayFontFamily,
    fontSize: 22,
    fontWeight: '600',
  },
  discoverSub: {
    color: theme.textSecondary,
    fontSize: 13,
    marginTop: 4,
    marginBottom: 14,
  },
  chipRow: {
    gap: 8,
    paddingBottom: 18,
    marginBottom: 10,
    paddingRight: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
  },
  chipSelected: {
    backgroundColor: theme.surfaceElevated,
    borderColor: theme.accentSoft,
  },
  chipText: {
    color: theme.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  chipTextSelected: {
    color: theme.accentSoft,
  },
  gridRow: {
    gap: GAP,
    marginBottom: GAP,
  },
  chartTile: {
    marginBottom: 6,
  },
  chartArt: {
    borderRadius: 12,
    backgroundColor: theme.surfaceElevated,
  },
  chartRank: {
    color: theme.accent,
    fontSize: 12,
    fontWeight: '800',
    marginTop: 8,
  },
  chartTitle: {
    color: theme.text,
    fontSize: 13,
    fontWeight: '600',
    marginTop: 2,
    lineHeight: 17,
  },
  chartArtist: {
    color: theme.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  chartErrorBox: {
    marginTop: 24,
    alignItems: 'center',
    gap: 10,
  },
  retryBtn: {
    backgroundColor: theme.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.border,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  retryText: {
    color: theme.text,
    fontWeight: '600',
    fontSize: 13,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 10,
    marginBottom: 9,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
  },
  art: {
    width: 60,
    height: 60,
    borderRadius: 10,
    backgroundColor: theme.surfaceElevated,
  },
  artPlaceholder: { backgroundColor: theme.border },
  meta: { flex: 1, minWidth: 0 },
  title: { color: theme.text, fontSize: 16, fontWeight: '600' },
  artist: { color: theme.textSecondary, fontSize: 13, marginTop: 3 },
  subBtn: {
    backgroundColor: theme.accent,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
  },
  subBtnDone: {
    backgroundColor: theme.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.border,
  },
  subBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  subBtnTextDone: { color: theme.textSecondary },
  error: { color: theme.danger, marginVertical: 8, textAlign: 'center' },
  empty: {
    color: theme.textMuted,
    textAlign: 'center',
    marginTop: 48,
    fontSize: 15,
    lineHeight: 22,
    paddingHorizontal: 24,
  },
});
