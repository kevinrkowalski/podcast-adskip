import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
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
import { Link } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  fetchTopPodcasts,
  PODCAST_CHART_GENRES,
  searchPodcasts,
} from '@/src/api/itunes';
import { subscribe, getSubscriptions } from '@/src/db/storage';
import type { PodcastSearchResult } from '@/src/types';
import { theme } from '@/constants/Colors';

const NUM_COLUMNS = 3;
const H_PAD = 16;
const GAP = 10;

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

  const showDiscover = !query.trim();

  const screenW = Dimensions.get('window').width;
  const tileSize = (screenW - H_PAD * 2 - GAP * (NUM_COLUMNS - 1)) / NUM_COLUMNS;

  const refreshSubs = useCallback(async () => {
    const subs = await getSubscriptions();
    setSubscribedIds(new Set(subs.map((s) => s.collectionId)));
  }, []);

  const loadCharts = useCallback(async (id: number | null) => {
    setChartLoading(true);
    setChartError(null);
    try {
      const items = await fetchTopPodcasts(id, 25);
      setChartItems(items);
    } catch (e) {
      setChartError(e instanceof Error ? e.message : 'Failed to load charts');
      setChartItems([]);
    } finally {
      setChartLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!showDiscover) return;
    void loadCharts(genreId);
  }, [showDiscover, genreId, loadCharts]);

  useEffect(() => {
    if (showDiscover) void refreshSubs();
  }, [showDiscover, refreshSubs]);

  const onChangeQuery = (text: string) => {
    setQuery(text);
    if (!text.trim()) {
      setResults([]);
      setError(null);
      setLoading(false);
    }
  };

  const onSearch = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await refreshSubs();
      const items = await searchPodcasts(query.trim());
      setResults(items);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  }, [query, refreshSubs]);

  const onSubscribe = async (item: PodcastSearchResult) => {
    if (!item.feedUrl) return;
    await subscribe({
      collectionId: item.collectionId,
      collectionName: item.collectionName,
      artistName: item.artistName,
      feedUrl: item.feedUrl,
      artworkUrl: item.artworkUrl600 || item.artworkUrl100,
      subscribedAt: new Date().toISOString(),
    });
    await refreshSubs();
  };

  const renderSearchItem = ({ item }: { item: PodcastSearchResult }) => {
    const isSub = subscribedIds.has(item.collectionId);
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
          disabled={isSub || !item.feedUrl}>
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
      <Text style={styles.heading}>Search</Text>
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
          <Text style={styles.btnText}>Go</Text>
        </Pressable>
      </View>

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
  heading: {
    color: theme.text,
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: -0.5,
    marginBottom: 14,
  },
  searchRow: { flexDirection: 'row', gap: 10, marginBottom: 4 },
  input: {
    flex: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: theme.text,
    backgroundColor: theme.surface,
    fontSize: 16,
  },
  btn: {
    backgroundColor: theme.accent,
    borderRadius: 12,
    paddingHorizontal: 18,
    justifyContent: 'center',
  },
  btnDisabled: { opacity: 0.4 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  discoverHeading: {
    color: theme.text,
    fontSize: 18,
    fontWeight: '700',
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
    backgroundColor: theme.accent,
    borderColor: theme.accent,
  },
  chipText: {
    color: theme.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  chipTextSelected: {
    color: '#fff',
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
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
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
