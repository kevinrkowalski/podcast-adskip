import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePositions } from '@/src/played/usePositions';
import { adSkipLine, formatDurationWords } from '@/src/player/adSkipLine';
import { formatMs } from '@/src/player/skipLogic';
import { isPlayingAtTop } from '@/src/queue/queueLogic';
import { clearQueue, moveQueueItemTo, removeFromQueue, useQueue } from '@/src/queue/queueStore';
import { useQueueAdStatus } from '@/src/queue/useQueueAdStatus';
import { usePlayback } from '@/src/store/PlaybackContext';
import type { Episode } from '@/src/types';
import { showEpisodeSheet, showToast } from '@/src/ui/overlayBus';
import { DraggableRows } from '@/components/DraggableRows';
import { Button, Cover, DOCK_SPACE, Divider, Icon, Label, type } from '@/components/ui';
import { theme } from '@/constants/Colors';
import { font } from '@/constants/Typography';

const ROW_H = 76;
const DOT = { on: theme.ad, ok: theme.success, idle: theme.textMuted, bad: theme.danger, busy: theme.ad } as const;

/** Home: the episode you're on and what's up next, on one screen. */
export default function ListenScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const playback = usePlayback();
  const { episode: current, isPlaying, positionMs, durationMs, playbackDownload } = playback;
  const queue = useQueue();
  const offset = isPlayingAtTop(queue, current?.guid) ? 1 : 0;
  const upNext = offset ? queue.slice(1) : queue;
  const { positions, refresh } = usePositions(upNext.map((e) => e.guid));
  const adStatus = useQueueAdStatus(upNext);
  const [scrollEnabled, setScrollEnabled] = useState(true);
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const line = useMemo(
    () =>
      adSkipLine({
        hasAudio: !!current?.enclosureUrl,
        autoSkip: playback.autoSkip,
        adDetectionEnabled: playback.adDetectionEnabled,
        skipSettings: playback.skipSettings,
        skipMap: playback.skipMap,
        analyzeStatus: playback.analyzeStatus,
        analyzeError: playback.analyzeError,
        uploadProgress: playback.uploadProgress,
        playbackDownload: playbackDownload?.guid === current?.guid ? playbackDownload : null,
        audioMismatchWarning: playback.audioMismatchWarning,
      }),
    [current?.enclosureUrl, current?.guid, playback.autoSkip, playback.adDetectionEnabled, playback.skipSettings, playback.skipMap, playback.analyzeStatus, playback.analyzeError, playback.uploadProgress, playbackDownload, playback.audioMismatchWarning],
  );

  const openPlayer = () => {
    router.push('/now-playing' as Href);
    void playback.restoreCurrentSkipMap().catch(() => {});
  };

  const totalMs = upNext.reduce((sum, e) => {
    const pos = positions[e.guid];
    const dur = pos?.durationMs ?? e.durationMs ?? 0;
    return sum + Math.max(0, dur - (pos?.positionMs ?? 0));
  }, 0);
  const allTimed = upNext.length > 0 && upNext.every((e) => (positions[e.guid]?.durationMs ?? e.durationMs ?? 0) > 0);
  const upNextSummary = [
    `${upNext.length} episode${upNext.length === 1 ? '' : 's'}`,
    allTimed ? formatDurationWords(totalMs) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const confirmClear = () => {
    Alert.alert('Clear the queue?', `Remove all ${upNext.length} episodes from Up next.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => void clearQueue() },
    ]);
  };

  const downloading = playbackDownload?.guid === current?.guid && playbackDownload?.state === 'downloading';
  const progress = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;
  const remainingMs = Math.max(0, durationMs - positionMs);

  return (
    <ScrollView
      style={styles.screen}
      scrollEnabled={scrollEnabled}
      contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + DOCK_SPACE }}
      showsVerticalScrollIndicator={false}>
      <View style={styles.header}>
        <Text style={[type.screenTitle, styles.flex]}>Listen</Text>
        <Pressable onPress={() => router.push('/settings')} hitSlop={10} accessibilityLabel="Settings" style={styles.gear}>
          <Icon name="settings" size={22} />
        </Pressable>
      </View>

      {current ? (
        <View style={styles.now}>
          <View style={styles.nowRow}>
            <Pressable
              onPress={openPlayer}
              accessibilityRole="button"
              accessibilityLabel={`Open player: ${current.title}`}
              style={({ pressed }) => [styles.nowMain, pressed && { opacity: 0.7 }]}>
              <Cover uri={current.artworkUrl} size={84} />
              <View style={styles.flex}>
                <Text style={styles.nowTitle} numberOfLines={2}>
                  {current.title}
                </Text>
                <Text style={type.meta} numberOfLines={1}>
                  {current.podcastTitle ?? 'Podcast'}
                </Text>
                <Text style={[type.mono, { marginTop: 8 }]}>
                  {formatMs(positionMs)}
                  {durationMs > 0 ? ` · ${formatDurationWords(remainingMs)} left` : ''}
                </Text>
              </View>
            </Pressable>
            <Pressable
              onPress={() => void playback.togglePlay()}
              hitSlop={8}
              accessibilityLabel={downloading ? 'Downloading, plays when ready' : isPlaying ? 'Pause' : 'Play'}
              style={({ pressed }) => [styles.playBtn, pressed && { opacity: 0.7 }]}>
              {downloading ? (
                <ActivityIndicator size="small" color={theme.background} />
              ) : (
                <Icon name={isPlaying ? 'pause' : 'play'} size={26} color={theme.background} />
              )}
            </Pressable>
          </View>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${progress * 100}%` as unknown as number }]} />
          </View>
          <Pressable onPress={openPlayer} hitSlop={8} accessibilityRole="button" style={styles.adRow}>
            <View style={[styles.dot, { backgroundColor: DOT[line.tone] }]} />
            <Text style={type.meta} numberOfLines={1}>
              {line.text}
            </Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.now}>
          <Text style={type.heading}>Nothing playing</Text>
          <Text style={[type.meta, { marginTop: 4 }]}>
            {upNext.length ? 'Start your queue, or pick any episode below.' : 'Find a show in Shows or Search, then play or queue an episode.'}
          </Text>
          {upNext.length > 0 && !!upNext[0].enclosureUrl && (
            <Button
              label="Play the queue"
              icon="play"
              onPress={() => void playback.playEpisode(upNext[0])}
              style={{ alignSelf: 'flex-start', marginTop: 14 }}
            />
          )}
        </View>
      )}

      <Divider style={styles.divider} />

      <View style={styles.upNextHead}>
        <Label style={styles.flex}>{upNext.length ? `Up next · ${upNextSummary}` : 'Up next'}</Label>
        {upNext.length > 0 && (
          <Pressable onPress={confirmClear} hitSlop={10} accessibilityRole="button" accessibilityLabel="Clear queue">
            <Text style={styles.clear}>Clear</Text>
          </Pressable>
        )}
      </View>

      {upNext.length === 0 ? (
        <Text style={[type.meta, styles.empty]}>
          Your queue is empty. Tap an episode and choose Play next or Queue, or turn on “Add new episodes to the queue” for a
          show.
        </Text>
      ) : (
        <DraggableRows
          items={upNext}
          keyOf={(e: Episode) => e.guid}
          rowHeight={ROW_H}
          onDragActive={(active) => setScrollEnabled(!active)}
          onMove={(from, to) => void moveQueueItemTo(from + offset, to + offset)}
          onRemove={(e) => {
            void removeFromQueue(e.guid);
            showToast('Removed from queue');
          }}
          renderRow={(item) => {
            const pos = positions[item.guid];
            const dur = pos?.durationMs ?? item.durationMs;
            const left = pos?.positionMs && dur && dur > pos.positionMs ? `${formatDurationWords(dur - pos.positionMs)} left` : null;
            const ad = adStatus[item.guid];
            return (
              <Pressable
                onPress={() => showEpisodeSheet(item)}
                accessibilityRole="button"
                accessibilityLabel={`${item.title}, ${item.podcastTitle ?? ''}`}
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}>
                <Cover uri={item.artworkUrl} size={48} radius={5} />
                <View style={styles.flex}>
                  <Text style={type.title} numberOfLines={2}>
                    {item.title}
                  </Text>
                  <Text style={type.metaMuted} numberOfLines={1}>
                    {[item.podcastTitle, left ?? item.duration].filter(Boolean).join(' · ')}
                    {ad?.kind === 'ready' ? (
                      <Text style={ad.count ? styles.adTag : undefined}>
                        {ad.count ? ` · ${ad.count} ad${ad.count === 1 ? '' : 's'}` : ' · no ads'}
                      </Text>
                    ) : ad?.kind === 'checking' ? (
                      ' · checking for ads'
                    ) : null}
                  </Text>
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.background },
  flex: { flex: 1, minWidth: 0 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, marginBottom: 18 },
  gear: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', marginRight: -8 },
  now: { paddingHorizontal: 20 },
  nowRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  nowMain: { flex: 1, flexDirection: 'row', gap: 14, minWidth: 0 },
  nowTitle: { fontFamily: font.displaySemi, fontSize: 17, lineHeight: 22, color: theme.text, marginBottom: 2 },
  playBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: theme.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  track: { height: 3, borderRadius: 2, backgroundColor: theme.progressTrack, marginTop: 14, overflow: 'hidden' },
  fill: { height: 3, backgroundColor: theme.text },
  adRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  divider: { marginHorizontal: 20, marginTop: 20 },
  upNextHead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, marginTop: 18, marginBottom: 4 },
  clear: { fontFamily: font.medium, fontSize: 13.5, color: theme.textSecondary },
  empty: { paddingHorizontal: 20, marginTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 20, height: ROW_H },
  adTag: { color: theme.ad },
});
