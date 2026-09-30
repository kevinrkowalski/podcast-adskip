import { useCallback, useState } from 'react';
import {
  Dimensions,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Link, useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getSubscriptions } from '@/src/db/storage';
import type { Subscription } from '@/src/types';
import { theme } from '@/constants/Colors';

const NUM_COLUMNS = 3;
const H_PAD = 16;
const GAP = 10;

export default function LibraryScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [subs, setSubs] = useState<Subscription[]>([]);

  const screenW = Dimensions.get('window').width;
  const tileSize = (screenW - H_PAD * 2 - GAP * (NUM_COLUMNS - 1)) / NUM_COLUMNS;

  useFocusEffect(
    useCallback(() => {
      getSubscriptions().then(setSubs);
    }, []),
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top + 8 }]}>
      <View style={styles.headingRow}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.heading}>Podcasts</Text>
          <Text style={styles.subheading}>
            {subs.length === 0
              ? 'Your subscribed shows'
              : `${subs.length} show${subs.length === 1 ? '' : 's'}`}
          </Text>
        </View>
        <Pressable
          style={styles.gearBtn}
          onPress={() => router.push('/settings')}
          hitSlop={10}
          accessibilityLabel="Settings">
          <Text style={styles.gearIcon}>⚙</Text>
        </Pressable>
      </View>
      <FlatList
        data={subs}
        keyExtractor={(item) => String(item.collectionId)}
        contentContainerStyle={{ paddingBottom: 120, paddingTop: 8 }}
        numColumns={NUM_COLUMNS}
        columnWrapperStyle={subs.length ? styles.gridRow : undefined}
        renderItem={({ item }) => (
          <Link
            href={{
              pathname: '/podcast/[id]',
              params: { id: String(item.collectionId) },
            }}
            asChild>
            <Pressable
              style={StyleSheet.flatten([styles.tile, { width: tileSize }])}
              accessibilityLabel={item.collectionName}>
              {!!item.artworkUrl ? (
                <Image
                  source={{ uri: item.artworkUrl }}
                  style={[styles.art, { width: tileSize, height: tileSize }]}
                />
              ) : (
                <View
                  style={[
                    styles.art,
                    styles.artPlaceholder,
                    { width: tileSize, height: tileSize },
                  ]}
                />
              )}
            </Pressable>
          </Link>
        )}
        ListEmptyComponent={
          <Text style={styles.empty}>
            No subscriptions yet.{'\n'}Find shows in Search.
          </Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.background,
    paddingHorizontal: H_PAD,
  },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 8,
  },
  heading: {
    color: theme.text,
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  subheading: {
    color: theme.textSecondary,
    fontSize: 14,
    marginTop: 4,
  },
  gearBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
    borderWidth: 1,
    borderColor: theme.border,
  },
  gearIcon: {
    fontSize: 20,
    color: theme.textSecondary,
  },
  gridRow: {
    gap: GAP,
    marginBottom: GAP,
  },
  tile: {
    borderRadius: 12,
    overflow: 'hidden',
  },
  art: {
    borderRadius: 12,
    backgroundColor: theme.surfaceElevated,
  },
  artPlaceholder: { backgroundColor: theme.border },
  empty: {
    color: theme.textMuted,
    textAlign: 'center',
    marginTop: 48,
    fontSize: 15,
    lineHeight: 22,
  },
});
