import { Alert, FlatList, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ReactElement } from 'react';
import { SymbolView } from 'expo-symbols';
import { clearQueue, moveQueueItem, removeFromQueue, useQueue } from '@/src/queue/queueStore';
import { isPlayingAtTop } from '@/src/queue/queueLogic';
import { useCallback } from 'react';
import { useFocusEffect } from 'expo-router';
import { isPlayed, usePlayedVersion } from '@/src/played/playedStore';
import { usePositions } from '@/src/played/usePositions';
import { EpisodeProgress } from '@/components/EpisodeProgress';
import { usePlayback } from '@/src/store/PlaybackContext';
import type { Episode } from '@/src/types';
import { theme } from '@/constants/Colors';
import { displayFontFamily } from '@/constants/Typography';

/** Confirm, then empty the queue. */
export function confirmClearQueue(count: number) {
  if (!count) return;
  Alert.alert('Clear queue?', `Remove all ${count} episodes from the queue.`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Clear', style: 'destructive', onPress: () => void clearQueue() },
  ]);
}

/**
 * Shared Up Next UI (used by the Up Next tab and the /queue page): now-playing
 * header, ordered list with move up/down + remove. Tapping a row opens the
 * episode in the player without starting it, then calls `onOpened`.
 */
export function QueueList({
  header,
  onOpened,
}: {
  header?: ReactElement | null;
  onOpened: (ep: Episode) => void;
}) {
  const queue = useQueue();
  const { episode: current, openEpisode } = usePlayback();
  // The playing episode lives at index 0: show it once, as the Now Playing
  // header, and list only what comes after it.
  const offset = isPlayingAtTop(queue, current?.guid) ? 1 : 0;
  const upNext = offset ? queue.slice(1) : queue;
  usePlayedVersion();
  const { positions, refresh } = usePositions(upNext.map((e) => e.guid));
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const onOpen = (ep: Episode) => {
    openEpisode(ep);
    onOpened(ep);
  };

  return (
    <View style={styles.container}>
      {header}
      {current ? (
        <View style={styles.nowRow}>
          <Text style={styles.sectionLabel}>NOW PLAYING</Text>
          <Text style={styles.nowTitle} numberOfLines={1}>
            {current.title}
          </Text>
        </View>
      ) : null}
      <FlatList
        data={upNext}
        keyExtractor={(item) => item.guid}
        contentContainerStyle={{ paddingBottom: 120 }}
        ListHeaderComponent={
          upNext.length ? <Text style={styles.sectionLabel}>UP NEXT · {upNext.length}</Text> : null
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Queue is empty</Text>
            <Text style={styles.emptySub}>
              Use “Play next” or “Add to queue” from an episode’s ⋯ menu or the player.
            </Text>
          </View>
        }
        renderItem={({ item, index }) => (
          <View style={styles.row}>
            <Pressable
              style={[styles.rowMain, isPlayed(item.guid) && { opacity: 0.55 }]}
              onPress={() => onOpen(item)}>
              {item.artworkUrl ? (
                <Image source={{ uri: item.artworkUrl }} style={styles.art} />
              ) : (
                <View style={[styles.art, styles.artFallback]} />
              )}
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.title} numberOfLines={2}>
                  {item.title}
                </Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {[isPlayed(item.guid) ? '✓ Played' : null, item.podcastTitle, item.duration]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
                <EpisodeProgress
                  positionMs={positions[item.guid]?.positionMs}
                  durationMs={positions[item.guid]?.durationMs ?? item.durationMs}
                />
              </View>
            </Pressable>
            <View style={styles.actions}>
              <IconBtn
                icon={{ ios: 'chevron.up', android: 'keyboard_arrow_up', web: 'keyboard_arrow_up' }}
                label="Move up"
                disabled={index === 0}
                onPress={() => void moveQueueItem(index + offset, -1)}
              />
              <IconBtn
                icon={{ ios: 'chevron.down', android: 'keyboard_arrow_down', web: 'keyboard_arrow_down' }}
                label="Move down"
                disabled={index === upNext.length - 1}
                onPress={() => void moveQueueItem(index + offset, 1)}
              />
              <IconBtn
                icon={{ ios: 'xmark', android: 'close', web: 'close' }}
                label="Remove from queue"
                onPress={() => void removeFromQueue(item.guid)}
              />
            </View>
          </View>
        )}
      />
    </View>
  );
}

function IconBtn({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: { ios: string; android: string; web: string };
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      style={[styles.iconBtn, disabled && { opacity: 0.3 }]}
      accessibilityLabel={label}>
      <SymbolView name={icon as never} size={20} tintColor={theme.textSecondary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background, paddingHorizontal: 16 },
  sectionLabel: {
    color: theme.accentSoft,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    marginTop: 16,
    marginBottom: 6,
  },
  nowRow: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
    paddingBottom: 12,
  },
  nowTitle: { color: theme.text, fontSize: 15, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
    gap: 8,
  },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minWidth: 0 },
  art: { width: 44, height: 44, borderRadius: 8, backgroundColor: theme.surfaceElevated },
  artFallback: { borderWidth: 1, borderColor: theme.border },
  title: { color: theme.text, fontSize: 14, fontWeight: '600' },
  meta: { color: theme.textMuted, fontSize: 12, marginTop: 3 },
  actions: { flexDirection: 'row', alignItems: 'center' },
  iconBtn: { width: 32, height: 36, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', marginTop: 48, paddingHorizontal: 24 },
  emptyTitle: { color: theme.text, fontFamily: displayFontFamily, fontSize: 20, fontWeight: '600' },
  emptySub: { color: theme.textMuted, fontSize: 13, marginTop: 8, textAlign: 'center', lineHeight: 18 },
});
