import { useCallback, useMemo, useRef, useState } from 'react';
import { LayoutChangeEvent, PanResponder, StyleSheet, View } from 'react-native';
import type { AdSegment } from '@/src/types';
import { theme } from '@/constants/Colors';

type Props = {
  positionMs: number;
  durationMs: number;
  segments?: AdSegment[];
  onSeek: (ms: number) => void;
  onScrubbingChange?: (ms: number | null) => void;
};

/**
 * Tappable + draggable timeline. Ad segments show as rose overlays.
 */
export function Scrubber({
  positionMs,
  durationMs,
  segments = [],
  onSeek,
  onScrubbingChange,
}: Props) {
  const widthRef = useRef(1);
  const durationRef = useRef(durationMs);
  durationRef.current = durationMs;
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  const onScrubRef = useRef(onScrubbingChange);
  onScrubRef.current = onScrubbingChange;

  const [trackW, setTrackW] = useState(1);
  const [previewMs, setPreviewMs] = useState<number | null>(null);

  const msFromX = useCallback((x: number) => {
    const w = widthRef.current || 1;
    const dur = durationRef.current || 0;
    const ratio = Math.max(0, Math.min(1, x / w));
    return Math.floor(ratio * dur);
  }, []);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
          const ms = msFromX(e.nativeEvent.locationX);
          setPreviewMs(ms);
          onScrubRef.current?.(ms);
        },
        onPanResponderMove: (e) => {
          const ms = msFromX(e.nativeEvent.locationX);
          setPreviewMs(ms);
          onScrubRef.current?.(ms);
        },
        onPanResponderRelease: (e) => {
          const ms = msFromX(e.nativeEvent.locationX);
          setPreviewMs(null);
          onScrubRef.current?.(null);
          onSeekRef.current(ms);
        },
        onPanResponderTerminate: () => {
          setPreviewMs(null);
          onScrubRef.current?.(null);
        },
      }),
    [msFromX],
  );

  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    widthRef.current = w;
    setTrackW(w);
  };

  const displayMs = previewMs != null ? previewMs : positionMs;
  const progress = durationMs > 0 ? Math.min(1, displayMs / durationMs) : 0;

  return (
    <View
      style={styles.hit}
      onLayout={onLayout}
      {...pan.panHandlers}
      accessibilityRole="adjustable"
      accessibilityLabel="Playback position">
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${progress * 100}%` as unknown as number }]} />
        {segments.map((s, i) => {
          if (!durationMs) return null;
          const left = (s.start_ms / durationMs) * 100;
          const width = Math.max(0.4, ((s.end_ms - s.start_ms) / durationMs) * 100);
          return (
            <View
              key={`${s.start_ms}-${i}`}
              pointerEvents="none"
              style={[styles.adMark, { left: `${left}%`, width: `${width}%` } as object]}
            />
          );
        })}
      </View>
      <View
        pointerEvents="none"
        style={[styles.thumb, { left: Math.max(0, progress * trackW - 7) }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hit: {
    width: '100%',
    height: 32,
    justifyContent: 'center',
  },
  track: {
    width: '100%',
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.progressTrack,
    overflow: 'hidden',
    position: 'relative',
  },
  fill: {
    height: '100%',
    backgroundColor: theme.progressFill,
  },
  adMark: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: theme.adMark,
  },
  thumb: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: theme.text,
    top: 9,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 3,
    elevation: 3,
  },
});
