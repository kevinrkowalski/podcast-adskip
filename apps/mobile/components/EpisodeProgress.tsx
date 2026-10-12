import { StyleSheet, View } from 'react-native';
import { theme } from '@/constants/Colors';

/** Thin resume-progress bar used in episode rows. Renders nothing at 0. */
export function EpisodeProgress({ positionMs, durationMs }: { positionMs?: number; durationMs?: number }) {
  if (!positionMs || !durationMs || durationMs <= 0) return null;
  const pct = Math.max(0, Math.min(100, (positionMs / durationMs) * 100));
  if (pct <= 0) return null;
  return (
    <View style={styles.track}>
      <View style={[styles.fill, { width: `${pct}%` as unknown as number }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 3,
    borderRadius: 2,
    backgroundColor: theme.progressTrack,
    marginTop: 8,
    overflow: 'hidden',
  },
  fill: { height: 3, borderRadius: 2, backgroundColor: theme.progressFill },
});
