import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getSubscriptions } from '@/src/db/storage';
import type { Subscription } from '@/src/types';
import { Button, Cover, DOCK_SPACE, type } from '@/components/ui';
import { theme } from '@/constants/Colors';
import { font } from '@/constants/Typography';

const NUM_COLUMNS = 3;
const H_PAD = 20;
const GAP = 12;

/** Your subscriptions as a grid of flat covers. */
export default function ShowsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [subs, setSubs] = useState<Subscription[]>([]);
  const tileSize = Math.floor((width - H_PAD * 2 - GAP * (NUM_COLUMNS - 1)) / NUM_COLUMNS);

  useFocusEffect(
    useCallback(() => {
      getSubscriptions()
        .then(setSubs)
        .catch((e) => console.warn('[shows] Failed to load subscriptions:', e));
    }, []),
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top + 12 }]}>
      <FlatList
        data={subs}
        keyExtractor={(item) => String(item.collectionId)}
        numColumns={NUM_COLUMNS}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + DOCK_SPACE, paddingHorizontal: H_PAD }}
        columnWrapperStyle={subs.length ? styles.gridRow : undefined}
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={[type.screenTitle, styles.flex]}>Shows</Text>
            {subs.length > 0 && <Text style={type.meta}>{subs.length}</Text>}
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push({ pathname: '/podcast/[id]', params: { id: String(item.collectionId) } })}
            style={{ width: tileSize }}
            accessibilityRole="button"
            accessibilityLabel={item.collectionName}>
            <Cover uri={item.artworkUrl} size={tileSize} />
            <Text style={styles.tileTitle} numberOfLines={2}>
              {item.collectionName}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={type.heading}>No shows yet</Text>
            <Text style={[type.meta, { marginTop: 6, marginBottom: 16 }]}>
              Find one in Search, or import your subscriptions in Settings.
            </Text>
            <Button label="Search for shows" kind="secondary" onPress={() => router.navigate('/search')} style={{ alignSelf: 'flex-start' }} />
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  flex: { flex: 1, minWidth: 0 },
  header: { flexDirection: 'row', alignItems: 'baseline', marginBottom: 18 },
  gridRow: { gap: GAP, marginBottom: 16 },
  tileTitle: { fontFamily: font.medium, fontSize: 12.5, lineHeight: 16, color: theme.text, marginTop: 7 },
  empty: { marginTop: 24 },
});
