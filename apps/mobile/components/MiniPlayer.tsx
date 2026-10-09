import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { useRootNavigationState, useRouter, useSegments, type Href } from 'expo-router';
import { usePlayback } from '@/src/store/PlaybackContext';
import { theme } from '@/constants/Colors';

/**
 * Compact now-playing bar above the tab bar (Pocket Casts style).
 * Hidden on the full Now Playing screen so it does not stack.
 */
export function MiniPlayer() {
  const {
    episode,
    isPlaying,
    positionMs,
    durationMs,
    togglePlay,
    seek,
    restoreCurrentSkipMap,
  } = usePlayback();
  const router = useRouter();
  const rootNavigationState = useRootNavigationState();
  const navigationReady = rootNavigationState?.key != null;
  const segments = useSegments() as string[];

  if (!episode) return null;
  // Hide on the full Now Playing screen.
  const onFullPlayer = segments.some((s) => s === 'now-playing');
  if (onFullPlayer) return null;

  const progress = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;

  return (
    <View style={styles.wrap}>
      <View style={[styles.progress, { width: `${progress * 100}%` as unknown as number }]} />
      <View style={styles.row}>
        <Pressable
          style={styles.openArea}
          onPress={() => {
            if (!navigationReady) return;
            router.push('/now-playing' as Href);
            void restoreCurrentSkipMap().catch((error) => {
              console.warn('[mini-player] Failed to restore skip map:', error);
            });
          }}>
          {!!episode.artworkUrl ? (
            <Image source={{ uri: episode.artworkUrl }} style={styles.art} />
          ) : (
            <View style={[styles.art, styles.artPlaceholder]} />
          )}
          <View style={styles.meta}>
            <Text style={styles.title} numberOfLines={1}>
              {episode.title}
            </Text>
            <Text style={styles.show} numberOfLines={1}>
              {episode.podcastTitle ?? 'Podcast'}
            </Text>
          </View>
        </Pressable>
        <View style={styles.controls}>
          <Pressable
            onPress={() => {
              void seek(Math.max(0, positionMs - 15_000));
            }}
            hitSlop={10}
            style={styles.skipBtn}
            accessibilityLabel="Skip back 15 seconds">
            <Text style={styles.skipLabel}>−15</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              void togglePlay();
            }}
            hitSlop={10}
            style={styles.playBtn}
            accessibilityLabel={isPlaying ? 'Pause' : 'Play'}>
            <SymbolView
              name={isPlaying
                ? { ios: 'pause.fill', android: 'pause', web: 'pause' }
                : { ios: 'play.fill', android: 'play_arrow', web: 'play_arrow' }}
              tintColor={theme.text}
              size={19}
            />
          </Pressable>
          <Pressable
            onPress={() => {
              void seek(positionMs + 30_000);
            }}
            hitSlop={10}
            style={styles.skipBtn}
            accessibilityLabel="Skip forward 30 seconds">
            <Text style={styles.skipLabel}>+30</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: theme.miniBar,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
    overflow: 'hidden',
  },
  progress: {
    height: 3,
    backgroundColor: theme.accent,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  openArea: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minWidth: 0,
  },
  art: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: theme.surfaceElevated,
  },
  artPlaceholder: {
    backgroundColor: theme.border,
  },
  meta: { flex: 1, minWidth: 0 },
  title: {
    color: theme.text,
    fontSize: 14,
    fontWeight: '600',
  },
  show: {
    color: theme.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  skipBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skipLabel: {
    color: theme.textSecondary,
    fontSize: 12,
    fontWeight: '700',
  },
  playBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
