import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
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
import { font } from '@/constants/Typography';
import { Button, Chip, Cover, DOCK_SPACE, Icon, Label, type } from '@/components/ui';
import { syncAndroidAutoCatalog } from '@/src/player/androidAutoCatalog';

const NUM_COLUMNS = 3;
const H_PAD = 20;
const GAP = 12;

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
  const tileSize = Math.floor((screenW - H_PAD * 2 - GAP * (NUM_COLUMNS - 1)) / NUM_COLUMNS);

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
        hitSlop={8}
        accessibilityRole="button"
        accessibilityState={{ expanded: rssOpen }}
        accessibilityLabel="Add a show by RSS link"
        style={styles.rssToggle}>
        <Icon name={rssOpen ? 'down' : 'plus'} size={18} color={theme.accent} />
        <Text style={type.meta}>Add a show by RSS link</Text>
      </Pressable>
      {rssOpen && (
        <>
          <View style={styles.rssRow}>
            <TextInput
              style={[styles.input, styles.flex]}
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
            {rssBusy ? (
              <ActivityIndicator color={theme.accent} style={{ width: 64 }} />
            ) : (
              <Button kind="accent" label="Add" onPress={() => void onAddRss()} disabled={!rssUrl.trim()} />
            )}
          </View>
          {!!rssError && <Text style={styles.error}>{rssError}</Text>}
          {!!rssNote && <Text style={styles.rssNote}>{rssNote}</Text>}
          {!rssError && !rssNote && (
            <Text style={styles.rssHint}>
              Paste a podcast feed link. To bring in many shows at once, use Settings → Import subscriptions.
            </Text>
          )}
        </>
      )}
    </View>
  );

  const renderSearchItem = ({ item }: { item: PodcastSearchResult }) => {
    const isSub = subscribedIds.has(item.collectionId);
    const isBusy = subBusyIds.has(item.collectionId);
    return (
      <View style={styles.row}>
        <Link href={{ pathname: '/podcast/[id]', params: { id: String(item.collectionId) } }} asChild>
          <Pressable style={({ pressed }) => [styles.rowMain, pressed && { opacity: 0.6 }]} accessibilityRole="button">
            <Cover uri={item.artworkUrl600 || item.artworkUrl100} size={56} />
            <View style={styles.flex}>
              <Text style={type.title} numberOfLines={2}>
                {item.collectionName}
              </Text>
              <Text style={type.metaMuted} numberOfLines={1}>
                {item.artistName}
              </Text>
            </View>
          </Pressable>
        </Link>
        {isSub ? (
          <Chip label="Subscribed" trailing="check" />
        ) : (
          <Button
            kind="secondary"
            label="Subscribe"
            onPress={() => onSubscribe(item)}
            disabled={isBusy || !item.feedUrl}
            style={styles.subBtn}
          />
        )}
      </View>
    );
  };

  const renderChartItem = ({ item, index }: { item: PodcastSearchResult; index: number }) => (
    <Link href={{ pathname: '/podcast/[id]', params: { id: String(item.collectionId) } }} asChild>
      <Pressable
        style={({ pressed }) => [{ width: tileSize }, pressed && { opacity: 0.6 }]}
        accessibilityRole="button"
        accessibilityLabel={`${index + 1}. ${item.collectionName}`}>
        <Cover uri={item.artworkUrl600 || item.artworkUrl100} size={tileSize} />
        <Text style={styles.chartTitle} numberOfLines={2}>
          <Text style={styles.chartRank}>{index + 1} </Text>
          {item.collectionName}
        </Text>
      </Pressable>
    </Link>
  );

  const discoverHeader = (
    <View>
      <ScrollView
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator={false}
        style={styles.chipScroll}
        contentContainerStyle={styles.chipRow}
        keyboardShouldPersistTaps="handled">
        {PODCAST_CHART_GENRES.map((g) => (
          <Chip key={g.label} label={g.label} on={genreId === g.id} onPress={() => setGenreId(g.id)} />
        ))}
      </ScrollView>
      <Label style={styles.chartLabel}>
        Apple charts · US{chartItems.length && !chartLoading ? ` · ${chartItems.length} shows` : ''}
      </Label>
      {chartLoading && <ActivityIndicator color={theme.accent} style={{ marginTop: 28 }} />}
      {!!chartError && !chartLoading && (
        <View style={styles.chartErrorBox}>
          <Text style={styles.error}>{chartError}</Text>
          <Button kind="secondary" label="Try again" onPress={() => void loadCharts(genreId)} style={{ alignSelf: 'flex-start' }} />
        </View>
      )}
    </View>
  );

  const listBottom = insets.bottom + DOCK_SPACE;

  return (
    <View style={[styles.container, { paddingTop: insets.top + 12 }]}>
      <Text style={[type.screenTitle, styles.heading]}>Search</Text>
      <View style={styles.searchField}>
        <Icon name="search" size={20} color={theme.textMuted} />
        <TextInput
          style={styles.searchInput}
          placeholder="Shows, hosts, topics"
          placeholderTextColor={theme.textMuted}
          value={query}
          onChangeText={onChangeQuery}
          onSubmitEditing={onSearch}
          returnKeyType="search"
          autoCorrect={false}
          accessibilityLabel="Search podcasts"
        />
        {!!query && (
          <Pressable onPress={() => onChangeQuery('')} hitSlop={10} accessibilityLabel="Clear search">
            <Icon name="close" size={18} color={theme.textMuted} />
          </Pressable>
        )}
      </View>
      {rssSection}

      {showDiscover ? (
        <FlatList
          key={`discover-grid-${NUM_COLUMNS}`}
          data={!chartLoading && !chartError ? chartItems : []}
          keyExtractor={(item) => String(item.collectionId)}
          numColumns={NUM_COLUMNS}
          columnWrapperStyle={!chartLoading && !chartError && chartItems.length > 0 ? styles.gridRow : undefined}
          contentContainerStyle={{ paddingBottom: listBottom }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={discoverHeader}
          renderItem={renderChartItem}
          ListEmptyComponent={
            !chartLoading && !chartError ? <Text style={styles.empty}>No chart results right now.</Text> : null
          }
        />
      ) : (
        <>
          {loading && <ActivityIndicator color={theme.accent} style={{ marginTop: 20 }} />}
          {error && <Text style={styles.error}>{error}</Text>}
          <FlatList
            data={results}
            keyExtractor={(item) => String(item.collectionId)}
            contentContainerStyle={{ paddingBottom: listBottom, paddingTop: 4 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            renderItem={renderSearchItem}
            ListEmptyComponent={
              !loading && !error ? (
                <Text style={styles.empty}>Press search on the keyboard to look through Apple Podcasts.</Text>
              ) : null
            }
          />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background, paddingHorizontal: H_PAD },
  flex: { flex: 1, minWidth: 0 },
  heading: { marginBottom: 14 },
  searchField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: theme.surface,
    borderRadius: 14,
    paddingHorizontal: 14,
    height: 48,
  },
  searchInput: { flex: 1, fontFamily: font.body, fontSize: 15.5, color: theme.text, paddingVertical: 0, height: 48 },
  input: {
    backgroundColor: theme.surface,
    borderRadius: 12,
    paddingHorizontal: 14,
    height: 44,
    fontFamily: font.body,
    fontSize: 14.5,
    color: theme.text,
  },
  rssBox: { marginTop: 12, marginBottom: 4 },
  rssToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
  rssRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  rssHint: { fontFamily: font.body, fontSize: 12.5, lineHeight: 17, color: theme.textMuted, marginTop: 8 },
  rssNote: { fontFamily: font.body, fontSize: 13, color: theme.success, marginTop: 8 },
  error: { fontFamily: font.body, fontSize: 13.5, color: theme.danger, marginTop: 10, marginBottom: 8 },
  chipScroll: { marginHorizontal: -H_PAD, marginTop: 12 },
  chipRow: { gap: 8, paddingHorizontal: H_PAD },
  chartLabel: { marginTop: 18, marginBottom: 12 },
  chartErrorBox: { marginTop: 4 },
  gridRow: { gap: GAP, marginBottom: 16 },
  chartTitle: { fontFamily: font.medium, fontSize: 12.5, lineHeight: 16, color: theme.text, marginTop: 7 },
  chartRank: { fontFamily: font.mono, fontSize: 11.5, color: theme.textMuted },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minWidth: 0 },
  subBtn: { minHeight: 36, paddingHorizontal: 14 },
  empty: { fontFamily: font.body, fontSize: 14, lineHeight: 20, color: theme.textMuted, marginTop: 24 },
});
