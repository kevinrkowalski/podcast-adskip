import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { usePathname, useRootNavigationState, useRouter, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePlayback } from '@/src/store/PlaybackContext';
import { Cover, Icon } from '@/components/ui';
import { theme } from '@/constants/Colors';
import { font } from '@/constants/Typography';

/**
 * Compact now-playing card: part of the floating dock on tab screens, and floating on
 * its own on show pages. Hidden on Listen (the episode is already at the top there) and
 * on the player.
 */
export function MiniPlayer() {
  const { episode, isPlaying, positionMs, durationMs, togglePlay, seek, restoreCurrentSkipMap, playbackDownload } =
    usePlayback();
  const router = useRouter();
  const rootNavigationState = useRootNavigationState();
  const navigationReady = rootNavigationState?.key != null;
  const pathname = usePathname();

  if (!episode) return null;
  if (pathname === '/' || pathname.startsWith('/now-playing')) return null;

  const download = playbackDownload?.guid === episode.guid ? playbackDownload : null;
  const progress = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <Pressable
          style={styles.openArea}
          accessibilityRole="button"
          accessibilityLabel={`Open player: ${episode.title}`}
          onPress={() => {
            if (!navigationReady) return;
            router.push('/now-playing' as Href);
            void restoreCurrentSkipMap().catch((error) => {
              console.warn('[mini-player] Failed to restore skip map:', error);
            });
          }}>
          <Cover uri={episode.artworkUrl} size={40} radius={5} />
          <View style={styles.meta}>
            <Text style={styles.title} numberOfLines={1}>
              {episode.title}
            </Text>
            <Text style={styles.show} numberOfLines={1}>
              {download?.state === 'downloading'
                ? `Downloading…${download.progressPct != null ? ` ${download.progressPct}%` : ''}`
                : download?.state === 'error'
                  ? 'Download failed · tap for options'
                  : (episode.podcastTitle ?? 'Podcast')}
            </Text>
          </View>
        </Pressable>
        <Pressable
          onPress={() => void seek(Math.max(0, positionMs - 15_000))}
          hitSlop={8}
          style={styles.skipBtn}
          accessibilityLabel="Skip back 15 seconds">
          <Text style={styles.skipLabel}>−15</Text>
        </Pressable>
        <Pressable
          onPress={() => void togglePlay()}
          hitSlop={8}
          style={styles.playBtn}
          accessibilityLabel={
            download?.state === 'downloading' ? 'Downloading, plays when ready' : isPlaying ? 'Pause' : 'Play'
          }>
          {download?.state === 'downloading' ? (
            <ActivityIndicator size="small" color={theme.background} />
          ) : (
            <Icon name={isPlaying ? 'pause' : 'play'} size={20} color={theme.background} />
          )}
        </Pressable>
        <Pressable
          onPress={() => void seek(positionMs + 30_000)}
          hitSlop={8}
          style={styles.skipBtn}
          accessibilityLabel="Skip forward 30 seconds">
          <Text style={styles.skipLabel}>+30</Text>
        </Pressable>
      </View>
      <View style={[styles.progress, { width: `${progress * 100}%` as unknown as number }]} />
    </View>
  );
}

/**
 * Solid ground under a floating dock: the screen's background from the bottom edge up to
 * `height`, then a short stepped fade, so list content never shows below the dock or
 * behind the system navigation bar.
 */
export function DockBackdrop({ height }: { height: number }) {
  return (
    <View pointerEvents="none" style={styles.backdrop}>
      {[0.25, 0.5, 0.75, 0.9].map((opacity) => (
        <View key={opacity} style={{ height: 10, backgroundColor: theme.background, opacity }} />
      ))}
      <View style={{ height, backgroundColor: theme.background }} />
    </View>
  );
}

/** The mini player floating by itself at the bottom of a screen that has no tab bar. */
export function FloatingMiniPlayer() {
  const insets = useSafeAreaInsets();
  return (
    <>
      <DockBackdrop height={insets.bottom + 10} />
      <View pointerEvents="box-none" style={[styles.floating, { bottom: insets.bottom + 10 }]}>
        <MiniPlayer />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: theme.miniBar,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    overflow: 'hidden',
  },
  floating: { position: 'absolute', left: 10, right: 10 },
  backdrop: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  row: { flexDirection: 'row', alignItems: 'center', paddingLeft: 10, paddingRight: 6, paddingVertical: 9, gap: 4 },
  openArea: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0 },
  meta: { flex: 1, minWidth: 0 },
  title: { fontFamily: font.semi, fontSize: 14, color: theme.text },
  show: { fontFamily: font.body, fontSize: 12.5, color: theme.textSecondary, marginTop: 1 },
  skipBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  skipLabel: { fontFamily: font.monoMedium, fontSize: 12.5, color: theme.textSecondary },
  playBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: theme.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  progress: { height: 2, backgroundColor: theme.text },
});
