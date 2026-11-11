import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useNavigation, useRouter, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { openShowForEpisode } from '@/src/navigation/openShow';
import { isPlayed } from '@/src/played/playedStore';
import { adSkipLine, isAnalyzing, type AdLineActionKind } from '@/src/player/adSkipLine';
import { currentChapterIndex, useChapters } from '@/src/player/chapters';
import { formatMs } from '@/src/player/skipLogic';
import { useUpNextCount } from '@/src/queue/queueStore';
import { usePlayback } from '@/src/store/PlaybackContext';
import { htmlToPlainText } from '@/src/ui/htmlText';
import { showActionSheet } from '@/src/ui/overlayBus';
import { parseShowNotesParts } from '@/src/ui/showNotesParts';
import { AdSkipLine } from '@/components/AdSkipLine';
import { AdSkipSheet } from '@/components/AdSkipSheet';
import { ReportSkipSheet } from '@/components/ReportSkipSheet';
import { Scrubber } from '@/components/Scrubber';
import { ShowSettingsSheet } from '@/components/ShowSettingsSheet';
import { Cover, Divider, Icon, Label, type } from '@/components/ui';
import { theme } from '@/constants/Colors';
import { font } from '@/constants/Typography';

/**
 * The player: one scrolling page. Cover, scrubber, five controls and the ad-skip line on
 * top; chapters, show notes and about the show underneath. A slim bar with play/pause
 * stays pinned once the controls scroll away.
 */
export default function PlayerScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const navigation = useNavigation();
  const { width, height } = useWindowDimensions();
  const playback = usePlayback();
  const queueLength = useUpNextCount();
  const { episode, isPlaying, positionMs, durationMs, playbackRate, skipMap, seek } = playback;

  const playbackDownload = playback.playbackDownload?.guid === episode?.guid ? playback.playbackDownload : null;
  const [scrubPreview, setScrubPreview] = useState<number | null>(null);
  const [adSheet, setAdSheet] = useState(false);
  const [settingsSheet, setSettingsSheet] = useState(false);
  const [reportVisible, setReportVisible] = useState(false);
  const [aboutExpanded, setAboutExpanded] = useState(false);
  const [pinned, setPinned] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const controlsBottom = useRef(0);
  const chaptersTop = useRef(0);

  const segs = skipMap?.segments ?? [];
  const displayPos = scrubPreview != null ? scrubPreview : positionMs;
  const remainingMs = Math.max(0, durationMs - displayPos);
  const { chapters } = useChapters(episode ?? null);
  const chapterIdx = currentChapterIndex(chapters, displayPos);
  const chapterStarts = useMemo(() => chapters.map((c) => c.startMs), [chapters]);
  const showNotes = useMemo(() => htmlToPlainText(episode?.description), [episode?.description]);
  const showNotesParts = useMemo(() => parseShowNotesParts(showNotes), [showNotes]);
  const aboutShow = useMemo(() => htmlToPlainText(episode?.podcastDescription), [episode?.podcastDescription]);
  const aboutIsLong = aboutShow.length > 240 || aboutShow.split('\n').length > 4;
  const guid = episode?.guid;
  useEffect(() => {
    setAboutExpanded(false);
    setPinned(false);
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [guid]);

  const line = useMemo(
    () =>
      adSkipLine({
        hasAudio: !!episode?.enclosureUrl,
        autoSkip: playback.autoSkip,
        adDetectionEnabled: playback.adDetectionEnabled,
        skipSettings: playback.skipSettings,
        skipMap,
        analyzeStatus: playback.analyzeStatus,
        analyzeError: playback.analyzeError,
        uploadProgress: playback.uploadProgress,
        playbackDownload,
        audioMismatchWarning: playback.audioMismatchWarning,
      }),
    [episode?.enclosureUrl, playback.autoSkip, playback.adDetectionEnabled, playback.skipSettings, skipMap, playback.analyzeStatus, playback.analyzeError, playback.uploadProgress, playbackDownload, playback.audioMismatchWarning],
  );

  const minimize = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/' as Href);
  };

  if (!episode) {
    return (
      <View style={[styles.container, styles.emptyWrap, { paddingTop: insets.top + 24 }]}>
        <Text style={type.heading}>Nothing playing</Text>
        <Text style={[type.meta, { textAlign: 'center', marginTop: 8 }]}>
          Pick an episode from Shows or Search to start listening.
        </Text>
        <Pressable onPress={minimize} hitSlop={10} accessibilityRole="button" style={{ marginTop: 20 }}>
          <Text style={type.link}>Close</Text>
        </Pressable>
      </View>
    );
  }

  const onAction = (kind: AdLineActionKind) => {
    if (kind === 'check') void playback.requestAnalyze(true);
    else if (kind === 'turnOn') void playback.setAutoSkip(true);
    else if (kind === 'showSettings') setSettingsSheet(true);
    else if (kind === 'retryDownload') void playback.retryPlaybackDownload();
    else if (kind === 'streamWithoutSkipping') void playback.streamWithoutSkipping();
  };

  const seekTo = (ms: number) => {
    const max = durationMs > 0 ? durationMs : ms;
    void seek(Math.max(0, Math.min(ms, max)));
  };

  const openShow = () => {
    void openShowForEpisode(router, episode, { fromPlayer: true, navigation: navigation as never }).catch((e) =>
      console.warn('[player] open show failed:', e),
    );
  };

  const openQueue = () => {
    // The queue lives on Listen (the first tab).
    router.dismissTo('/' as Href);
  };

  const onMore = () => {
    const played = isPlayed(episode.guid);
    showActionSheet({
      title: episode.title,
      message: episode.podcastTitle,
      actions: [
        {
          label: played ? 'Mark as unplayed' : 'Mark as played',
          onPress: () => {
            void playback.setEpisodePlayed(episode, !played);
            // Marking the playing episode played unloads it: leave the (now empty) player.
            if (!played) minimize();
          },
        },
        { label: 'Report a bad skip', onPress: () => setReportVisible(true) },
        { label: `Go to ${episode.podcastTitle ?? 'the show'}`, onPress: openShow },
      ],
    });
  };

  const downloading = playbackDownload?.state === 'downloading';
  const coverSize = Math.round(Math.min(width - 48, height * 0.36, 380));
  const notesStatus = playback.showNotesStatus?.guid === episode.guid ? playback.showNotesStatus.status : null;
  const playLabel = downloading
    ? 'Downloading, plays when ready'
    : playbackDownload?.state === 'error'
      ? 'Retry download'
      : isPlaying
        ? 'Pause'
        : 'Play';

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <Pressable onPress={minimize} hitSlop={12} style={styles.topBtn} accessibilityLabel="Close player">
          <Icon name="down" size={26} />
        </Pressable>
        {pinned ? (
          <View style={styles.pinned}>
            <Cover uri={episode.artworkUrl} size={34} radius={4} />
            <View style={styles.flex}>
              <Text style={styles.pinnedTitle} numberOfLines={1}>
                {episode.title}
              </Text>
              <Text style={type.mono}>
                {formatMs(positionMs)} · −{formatMs(Math.max(0, durationMs - positionMs))}
              </Text>
            </View>
            <Pressable
              onPress={() => void playback.togglePlay()}
              hitSlop={8}
              accessibilityLabel={playLabel}
              style={styles.pinnedPlay}>
              {downloading ? (
                <ActivityIndicator size="small" color={theme.background} />
              ) : (
                <Icon name={isPlaying ? 'pause' : 'play'} size={20} color={theme.background} />
              )}
            </Pressable>
          </View>
        ) : (
          <>
            <View style={styles.flex} />
            <Pressable onPress={onMore} hitSlop={12} style={styles.topBtn} accessibilityLabel="More actions">
              <Icon name="more" size={24} />
            </Pressable>
          </>
        )}
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.flex}
        contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: Math.max(insets.bottom, 16) + 24 }}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={32}
        onScroll={(e) => {
          const next = controlsBottom.current > 0 && e.nativeEvent.contentOffset.y > controlsBottom.current - 56;
          if (next !== pinned) setPinned(next);
        }}>
        <Cover uri={episode.artworkUrl} size={coverSize} radius={8} style={styles.cover} />

        <Text style={styles.title} numberOfLines={3}>
          {episode.title}
        </Text>
        <View style={styles.subline}>
          <Pressable
            onPress={openShow}
            hitSlop={8}
            accessibilityRole="link"
            accessibilityLabel={`Open ${episode.podcastTitle ?? 'show'}`}
            style={({ pressed }) => [{ flexShrink: 1 }, pressed && { opacity: 0.55 }]}>
            <Text style={styles.showName} numberOfLines={1}>
              {episode.podcastTitle ?? 'Podcast'}
            </Text>
          </Pressable>
          {chapterIdx >= 0 && (
            <Pressable
              onPress={() => scrollRef.current?.scrollTo({ y: Math.max(0, chaptersTop.current - 60), animated: true })}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Chapter ${chapterIdx + 1} of ${chapters.length}: ${chapters[chapterIdx].title}. Show chapters`}
              style={styles.flex}>
              <Text style={type.meta} numberOfLines={1}>
                {' · '}
                {chapters[chapterIdx].title}
              </Text>
            </Pressable>
          )}
        </View>

        <View style={styles.scrubBlock}>
          <Scrubber
            positionMs={positionMs}
            durationMs={durationMs}
            segments={segs}
            chapterStartsMs={chapterStarts}
            onSeek={(ms) => seek(ms)}
            onScrubbingChange={setScrubPreview}
          />
          <View style={styles.times}>
            <Text style={type.mono}>{formatMs(displayPos)}</Text>
            <Text style={type.mono}>−{formatMs(remainingMs)}</Text>
          </View>
        </View>

        <View
          style={styles.transport}
          onLayout={(e) => {
            // Once the play button has scrolled away, the slim bar takes over.
            controlsBottom.current = e.nativeEvent.layout.y + e.nativeEvent.layout.height;
          }}>
          <Pressable
            onPress={playback.cyclePlaybackRate}
            hitSlop={6}
            style={styles.side}
            accessibilityLabel={`Playback speed ${playbackRate} times. Tap to change`}>
            <Text style={styles.sideValue}>{playbackRate}×</Text>
            <Text style={styles.sideCaption}>Speed</Text>
          </Pressable>
          <Pressable
            onPress={() => seek(Math.max(0, positionMs - 15_000))}
            hitSlop={8}
            style={styles.skip}
            accessibilityLabel="Skip back 15 seconds">
            <Text style={styles.skipText}>−15</Text>
          </Pressable>
          <Pressable
            onPress={() => void playback.togglePlay()}
            style={({ pressed }) => [styles.play, pressed && { opacity: 0.8 }]}
            accessibilityLabel={playLabel}>
            {downloading ? (
              <ActivityIndicator size="large" color={theme.background} />
            ) : (
              <Icon name={isPlaying ? 'pause' : 'play'} size={34} color={theme.background} />
            )}
          </Pressable>
          <Pressable
            onPress={() => seek(positionMs + 30_000)}
            hitSlop={8}
            style={styles.skip}
            accessibilityLabel="Skip forward 30 seconds">
            <Text style={styles.skipText}>+30</Text>
          </Pressable>
          <Pressable
            onPress={openQueue}
            hitSlop={6}
            style={styles.side}
            accessibilityLabel={`Queue, ${queueLength} up next`}>
            <View style={styles.sideIcon}>
              <Icon name="queue" size={22} color={theme.text} />
            </View>
            <Text style={styles.sideCaption}>{queueLength > 0 ? `Queue · ${queueLength}` : 'Queue'}</Text>
          </Pressable>
        </View>

        <AdSkipLine line={line} onPress={() => setAdSheet(true)} onAction={onAction} />

        {chapters.length > 0 && (
          <View
            style={styles.section}
            onLayout={(e) => {
              chaptersTop.current = e.nativeEvent.layout.y;
            }}>
            <Label style={styles.sectionLabel}>Chapters</Label>
            {chapters.map((chapter, idx) => (
              <Pressable
                key={`${chapter.startMs}-${idx}`}
                onPress={() => seekTo(chapter.startMs)}
                accessibilityRole="button"
                accessibilityLabel={`Play chapter ${idx + 1}: ${chapter.title}, at ${formatMs(chapter.startMs)}`}
                accessibilityState={{ selected: idx === chapterIdx }}
                style={({ pressed }) => [styles.chapter, idx === chapterIdx && styles.chapterOn, pressed && { opacity: 0.55 }]}>
                <Text style={[styles.chapterTime, idx === chapterIdx && { color: theme.text }]}>
                  {formatMs(chapter.startMs)}
                </Text>
                <Text style={[styles.chapterTitle, idx === chapterIdx && styles.chapterTitleOn]} numberOfLines={2}>
                  {chapter.title}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        <View style={styles.section}>
          {chapters.length > 0 && <Divider style={styles.sectionRule} />}
          <Label style={styles.sectionLabel}>Show notes</Label>
          {showNotes ? (
            <Text style={type.body}>
              {showNotesParts.map((part, idx) =>
                part.type === 'timestamp' ? (
                  <Text
                    key={`ts-${idx}-${part.raw}`}
                    style={styles.timestamp}
                    onPress={() => seekTo(part.ms)}
                    accessibilityRole="link"
                    accessibilityLabel={`Seek to ${part.raw}`}>
                    {part.raw}
                  </Text>
                ) : (
                  part.text
                ),
              )}
            </Text>
          ) : notesStatus === 'loading' ? (
            <Text style={type.body}>Loading show notes…</Text>
          ) : notesStatus === 'failed' ? (
            <View>
              <Text style={type.body}>Couldn’t load show notes. The podcast’s feed didn’t respond.</Text>
              <Pressable onPress={playback.retryShowNotes} hitSlop={8} accessibilityRole="button" style={styles.inlineLink}>
                <Text style={type.link}>Try again</Text>
              </Pressable>
            </View>
          ) : (
            <Text style={type.body}>No show notes are available for this episode.</Text>
          )}
        </View>

        {!!aboutShow && (
          <View style={styles.section}>
            <Divider style={styles.sectionRule} />
            <Label style={styles.sectionLabel}>About the show</Label>
            <Text style={type.body} numberOfLines={aboutExpanded || !aboutIsLong ? undefined : 4}>
              {aboutShow}
            </Text>
            {aboutIsLong && (
              <Pressable
                onPress={() => setAboutExpanded((v) => !v)}
                hitSlop={8}
                accessibilityRole="button"
                style={styles.inlineLink}>
                <Text style={type.link}>{aboutExpanded ? 'Less' : 'More'}</Text>
              </Pressable>
            )}
          </View>
        )}
      </ScrollView>

      <AdSkipSheet
        visible={adSheet}
        onClose={() => setAdSheet(false)}
        line={line}
        segments={segs}
        autoSkip={playback.autoSkip}
        onAutoSkipChange={(v) => void playback.setAutoSkip(v)}
        adDetectionEnabled={playback.adDetectionEnabled}
        skipSettings={playback.skipSettings}
        showTitle={episode.podcastTitle}
        onOpenShowSettings={() => setSettingsSheet(true)}
        onSegmentPress={(startMs) => {
          setAdSheet(false);
          void seek(startMs);
        }}
        onAction={onAction}
        busy={isAnalyzing(playback.analyzeStatus) || downloading}
        onReport={() => {
          setAdSheet(false);
          setReportVisible(true);
        }}
      />
      <ShowSettingsSheet
        visible={settingsSheet}
        onClose={() => setSettingsSheet(false)}
        show={{ collectionId: episode.collectionId, feedUrl: episode.feedUrl, title: episode.podcastTitle }}
      />
      <ReportSkipSheet
        visible={reportVisible}
        onClose={() => setReportVisible(false)}
        episode={episode}
        positionMs={positionMs}
        skipMap={skipMap}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  flex: { flex: 1, minWidth: 0 },
  emptyWrap: { paddingHorizontal: 32, alignItems: 'center', justifyContent: 'center' },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, height: 52, gap: 4 },
  topBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  pinned: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0, paddingRight: 4 },
  pinnedTitle: { fontFamily: font.semi, fontSize: 14, color: theme.text },
  pinnedPlay: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: theme.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cover: { alignSelf: 'center', marginTop: 4 },
  title: { fontFamily: font.display, fontSize: 22, lineHeight: 28, letterSpacing: -0.2, color: theme.text, marginTop: 22 },
  subline: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  showName: { fontFamily: font.medium, fontSize: 14.5, color: theme.text, textDecorationLine: 'underline' },
  scrubBlock: { marginTop: 14 },
  times: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -2 },
  transport: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, marginBottom: 20 },
  side: { width: 64, alignItems: 'center', gap: 3 },
  sideValue: { fontFamily: font.monoMedium, fontSize: 15, color: theme.text, height: 24, textAlignVertical: 'center', lineHeight: 24 },
  sideIcon: { height: 24, justifyContent: 'center' },
  sideCaption: { fontFamily: font.body, fontSize: 11.5, color: theme.textSecondary },
  skip: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center' },
  skipText: { fontFamily: font.monoMedium, fontSize: 16, color: theme.text },
  play: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: theme.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  section: { marginTop: 28 },
  sectionRule: { marginBottom: 24 },
  sectionLabel: { marginBottom: 10 },
  chapter: { flexDirection: 'row', alignItems: 'baseline', gap: 12, paddingVertical: 10, paddingHorizontal: 10, marginHorizontal: -10, borderRadius: 10 },
  chapterOn: { backgroundColor: 'rgba(255,255,255,0.07)' },
  chapterTime: { fontFamily: font.mono, fontSize: 13, color: theme.textSecondary, minWidth: 54, fontVariant: ['tabular-nums'] },
  chapterTitle: { flex: 1, fontFamily: font.body, fontSize: 15, lineHeight: 21, color: theme.textSecondary },
  chapterTitleOn: { fontFamily: font.semi, color: theme.text },
  timestamp: { fontFamily: font.mono, color: theme.accent, textDecorationLine: 'underline' },
  inlineLink: { alignSelf: 'flex-start', marginTop: 8 },
});
