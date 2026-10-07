import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePlayback } from '@/src/store/PlaybackContext';
import { formatMs, segmentTypeLabel } from '@/src/player/skipLogic';
import { Scrubber } from '@/components/Scrubber';
import { theme } from '@/constants/Colors';

const { width: SCREEN_W } = Dimensions.get('window');
const ART_SIZE = Math.min(SCREEN_W - 56, 340);
type PlayerTab = 'playing' | 'details';

function formatShowNotes(raw?: string): string {
  return (raw ?? '')
    .replace(/<br\s*\/?>(?=\S)/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Media-style timestamps: m:ss, mm:ss, or h:mm:ss (not bare years / integers). */
const TIMESTAMP_RE = /(?<!\d)(?:\d{1,2}:\d{2}:\d{2}|\d{1,2}:\d{2})(?!\d)/g;

type ShowNotesPart =
  | { type: 'text'; text: string }
  | { type: 'timestamp'; raw: string; ms: number };

function parseTimestampToMs(raw: string): number | null {
  const bits = raw.split(':').map((p) => Number(p));
  if (bits.some((n) => !Number.isFinite(n) || n < 0)) return null;
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (bits.length === 3) {
    [hours, minutes, seconds] = bits;
    if (minutes > 59 || seconds > 59) return null;
  } else if (bits.length === 2) {
    [minutes, seconds] = bits;
    // Allow minutes >= 60 (e.g. 75:30) when hours are omitted.
    if (seconds > 59) return null;
  } else {
    return null;
  }
  const totalSec = hours * 3600 + minutes * 60 + seconds;
  // Reject absurd lengths that are unlikely to be episode cues.
  if (totalSec > 24 * 3600) return null;
  return totalSec * 1000;
}

function parseShowNotesParts(notes: string): ShowNotesPart[] {
  if (!notes) return [];
  const parts: ShowNotesPart[] = [];
  let last = 0;
  TIMESTAMP_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TIMESTAMP_RE.exec(notes)) != null) {
    const raw = match[0];
    const ms = parseTimestampToMs(raw);
    if (ms == null) continue;
    if (match.index > last) {
      parts.push({ type: 'text', text: notes.slice(last, match.index) });
    }
    parts.push({ type: 'timestamp', raw, ms });
    last = match.index + raw.length;
  }
  if (last < notes.length) {
    parts.push({ type: 'text', text: notes.slice(last) });
  }
  return parts;
}


function formatEtaSeconds(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return null;
  if (sec < 60) return `~${Math.max(5, Math.round(sec / 5) * 5)} sec left`;
  const mins = Math.max(1, Math.round(sec / 60));
  return mins === 1 ? '~1 min left' : `~${mins} min left`;
}

export default function PlayerScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    episode,
    isPlaying,
    positionMs,
    durationMs,
    playbackRate,
    autoSkip,
    adDetectionEnabled,
    skipMap,
    analyzeStatus,
    analyzeError,
    audioMismatchWarning,
    uploadProgress,
    togglePlay,
    seek,
    setAutoSkip,
    requestAnalyze,
    cyclePlaybackRate,
  } = usePlayback();
  const [scrubPreview, setScrubPreview] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<PlayerTab>('playing');
  const [skipSheetVisible, setSkipSheetVisible] = useState(false);

  const segs = skipMap?.segments ?? [];
  const displayPos = scrubPreview != null ? scrubPreview : positionMs;
  const remainingMs = Math.max(0, durationMs - displayPos);
  const showNotes = useMemo(() => formatShowNotes(episode?.description), [episode?.description]);
  const showNotesParts = useMemo(() => parseShowNotesParts(showNotes), [showNotes]);

  useEffect(() => {
    if (analyzeError) {
      Alert.alert('Analysis failed', analyzeError);
    }
  }, [analyzeError]);

  const seekToTimestamp = (ms: number) => {
    const max = durationMs > 0 ? durationMs : ms;
    const clamped = Math.max(0, Math.min(ms, max));
    void seek(clamped);
  };

  const isAnalyzing =
    analyzeStatus === 'queued' || analyzeStatus === 'pending' || 
    analyzeStatus === 'downloading' || analyzeStatus === 'uploading';

  const analyzeEtaLabel = useMemo(
    () => formatEtaSeconds(skipMap?.eta_seconds),
    [skipMap?.eta_seconds],
  );

  const analyzeStageLabel =
    skipMap?.stage_label?.trim() ||
    (analyzeStatus === 'downloading' ? 'Downloading audio' : null) ||
    (analyzeStatus === 'uploading' ? 'Uploading for analysis' : null) ||
    (isAnalyzing ? 'Analyzing' : null);

  const analyzeProgressPct =
    uploadProgress
      ? uploadProgress.downloaded + uploadProgress.uploaded
      : typeof skipMap?.progress_pct === 'number' && Number.isFinite(skipMap.progress_pct)
        ? Math.max(0, Math.min(100, skipMap.progress_pct))
        : null;

  const adSkipHint = useMemo(() => {
    // Show current analysis state if in progress or completed
    if (isAnalyzing) {
      if (analyzeEtaLabel) {
        // Compact strip label: "~2m"
        const m = analyzeEtaLabel.match(/~(\d+)\s*min/);
        if (m) return `~${m[1]}m`;
        const s = analyzeEtaLabel.match(/~(\d+)\s*sec/);
        if (s) return `~${s[1]}s`;
      }
      return '…';
    }
    if (analyzeStatus === 'ready') {
      return segs.length ? `${segs.length} ads` : 'Clean';
    }
    if (analyzeStatus === 'offline') return 'Offline';
    if (analyzeStatus === 'error') {
      if (analyzeError && analyzeError.length <= 20) {
        return analyzeError;
      }
      return 'Error';
    }
    
    // Show state when not analyzing
    if (!autoSkip) return 'Manual';
    if (!adDetectionEnabled) {
      // Per-show OFF but global ON: Prepare is still available
      return 'Prep';
    }
    return 'Prep';
  }, [adDetectionEnabled, autoSkip, analyzeStatus, analyzeError, segs.length, isAnalyzing, analyzeEtaLabel]);

  if (!episode) {
    return (
      <View style={[styles.container, styles.emptyWrap, { paddingTop: insets.top + 24 }]}>
        <Text style={styles.emptyTitle}>Nothing playing</Text>
        <Text style={styles.emptySub}>
          Pick an episode from Library or Search to start listening.
        </Text>
      </View>
    );
  }

  const minimize = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  };

  // Open the sheet whenever we have segments cached for this episode, even if
  // auto-skip was briefly turned off (map must not be destroyed on toggle-off).
  const hasCachedSegments = segs.length > 0;

  const toggleAutoSkip = () => {
    // A disabled podcast cannot be toggled from the player, but turning the
    // global switch back on should be possible even after it cleared detection.
    if (autoSkip && !adDetectionEnabled) return;
    if (!autoSkip) {
      // setAutoSkip(true) restores from cache / GET; analyzes only if missing/error.
      void setAutoSkip(true);
      return;
    }
    void setAutoSkip(false);
  };

  const onAdSkipPress = () => {
    if (hasCachedSegments) {
      setSkipSheetVisible(true);
      return;
    }
    toggleAutoSkip();
  };

  const onSegmentPress = (startMs: number) => {
    setSkipSheetVisible(false);
    void seek(startMs);
  };

  const onSheetAutoSkipChange = (enabled: boolean) => {
    if (enabled === autoSkip) return;
    // Keep the sheet open while toggling — closing it on turn-off made rapid
    // toggles feel broken, and a load race could wipe segments before reopen.
    if (enabled) {
      // Restore cached skip map; do not force requestAnalyze(true).
      void setAutoSkip(true);
    } else {
      void setAutoSkip(false);
    }
  };

  const onMorePress = () => {
    Alert.alert(
      'More playback actions',
      'Additional episode actions will appear here in a future update.',
      [{ text: 'Done', style: 'cancel' }],
    );
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <Pressable
          onPress={minimize}
          hitSlop={12}
          style={styles.chevronBtn}
          accessibilityLabel="Minimize player">
          <SymbolView
            name={{ ios: 'chevron.down', android: 'keyboard_arrow_down', web: 'keyboard_arrow_down' }}
            tintColor={theme.textSecondary}
            size={28}
          />
        </Pressable>
        <View style={styles.topTabs} accessibilityRole="tablist">
          <Pressable
            onPress={() => setActiveTab('playing')}
            style={[styles.topTab, activeTab === 'playing' && styles.topTabActive]}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === 'playing' }}>
            <Text style={[styles.topTabLabel, activeTab === 'playing' && styles.topTabLabelActive]}>
              Playing
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setActiveTab('details')}
            style={[styles.topTab, activeTab === 'details' && styles.topTabActive]}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === 'details' }}>
            <Text style={[styles.topTabLabel, activeTab === 'details' && styles.topTabLabelActive]}>
              Details
            </Text>
          </Pressable>
        </View>
        <View style={styles.topBarFiller} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: Math.max(insets.bottom, 12) + 8 },
        ]}
        showsVerticalScrollIndicator={false}
        bounces={false}>
        {activeTab === 'playing' ? (
          <>
            <View style={styles.artWrap}>
              {!!episode.artworkUrl ? (
                <Image source={{ uri: episode.artworkUrl }} style={styles.art} />
              ) : (
                <View style={[styles.art, styles.artPlaceholder]} />
              )}
            </View>

            <Text style={styles.title} numberOfLines={2}>
              {episode.title}
            </Text>
            <Text style={styles.show} numberOfLines={1}>
              {episode.podcastTitle}
            </Text>

            <View style={styles.scrubBlock}>
              <Scrubber
                positionMs={positionMs}
                durationMs={durationMs}
                segments={segs}
                onSeek={(ms) => seek(ms)}
                onScrubbingChange={setScrubPreview}
              />
              <View style={styles.times}>
                <Text style={styles.time}>{formatMs(displayPos)}</Text>
                <Text style={styles.time}>−{formatMs(remainingMs)}</Text>
              </View>
            </View>

            <View style={styles.controls}>
              <Pressable
                onPress={() => seek(Math.max(0, positionMs - 10_000))}
                style={styles.skipBtn}
                hitSlop={8}
                accessibilityLabel="Skip back 10 seconds">
                <SymbolView
                  name={{ ios: 'gobackward.10', android: 'replay_10', web: 'replay_10' }}
                  tintColor={theme.text}
                  size={50}
                />
              </Pressable>

              <Pressable
                onPress={togglePlay}
                style={styles.playBtn}
                accessibilityLabel={isPlaying ? 'Pause' : 'Play'}>
                <SymbolView
                  name={
                    isPlaying
                      ? { ios: 'pause.fill', android: 'pause', web: 'pause' }
                      : { ios: 'play.fill', android: 'play_arrow', web: 'play_arrow' }
                  }
                  tintColor={theme.background}
                  size={32}
                />
              </Pressable>

              <Pressable
                onPress={() => seek(positionMs + 30_000)}
                style={styles.skipBtn}
                hitSlop={8}
                accessibilityLabel="Skip forward 30 seconds">
                <SymbolView
                  name={{ ios: 'goforward.30', android: 'forward_30', web: 'forward_30' }}
                  tintColor={theme.text}
                  size={50}
                />
              </Pressable>
            </View>

            <View style={styles.flexSpacer} />

            {isAnalyzing ? (
              <View
                style={styles.analyzeProgress}
                accessibilityRole="progressbar"
                accessibilityLabel={
                  analyzeEtaLabel
                    ? `${analyzeStageLabel ?? 'Analyzing'}, ${analyzeEtaLabel}`
                    : `${analyzeStageLabel ?? 'Analyzing'} in progress`
                }>
                <View style={styles.analyzeProgressRow}>
                  <ActivityIndicator size="small" color={theme.accentSoft} />
                  <Text style={styles.analyzeProgressText} numberOfLines={1}>
                    {analyzeStageLabel ?? 'Analyzing'}
                    {analyzeEtaLabel ? ` · ${analyzeEtaLabel}` : ''}
                  </Text>
                </View>
                <View style={styles.analyzeBarTrack}>
                  {analyzeProgressPct != null ? (
                    <View
                      style={[
                        styles.analyzeBarFill,
                        { width: `${analyzeProgressPct}%` as unknown as number },
                      ]}
                    />
                  ) : (
                    <View style={[styles.analyzeBarFill, styles.analyzeBarIndeterminate]} />
                  )}
                </View>
              </View>
            ) : null}

            {audioMismatchWarning && segs.length > 0 ? (
              <View style={styles.mismatchWarning}>
                <View style={styles.mismatchWarningRow}>
                  <SymbolView
                    name={{ ios: 'exclamationmark.triangle', android: 'warning', web: 'warning' }}
                    tintColor={theme.accentWarn}
                    size={16}
                  />
                  <Text style={styles.mismatchWarningText} numberOfLines={2}>
                    {audioMismatchWarning}
                  </Text>
                </View>
              </View>
            ) : null}

            <View style={styles.actionStrip}>
              <Pressable
                style={styles.actionItem}
                onPress={cyclePlaybackRate}
                hitSlop={6}
                accessibilityLabel={`Playback speed ${playbackRate} times. Tap to change`}>
                <Text style={styles.actionValue}>{playbackRate}×</Text>
                <Text style={styles.actionCaption}>Speed</Text>
              </Pressable>

              <Pressable
                style={styles.actionItem}
                onPress={onAdSkipPress}
                hitSlop={6}
                accessibilityLabel="Ad skip">
                <Text
                  style={[
                    styles.actionValue,
                    autoSkip && adDetectionEnabled && styles.actionValueActive,
                  ]}>
                  {adSkipHint}
                </Text>
                <Text style={styles.actionCaption}>Ad-skip</Text>
              </Pressable>

              <Pressable
                style={styles.actionItem}
                onPress={() => {
                  // Defensive check: only call if global settings allow
                  if (autoSkip) {
                    requestAnalyze(true);
                  } else {
                    console.log('[player] Prepare blocked: global auto-skip is OFF');
                  }
                }}
                hitSlop={6}
                accessibilityLabel="Prepare ad analysis"
                // Prepare button is ONLY disabled by global Settings kill-switch.
                // When global is ON but per-show detection is OFF, Prepare still works
                // (it enables detection for this user-initiated analysis).
                disabled={!autoSkip}>
                <SymbolView
                  name={{ ios: 'sparkles', android: 'auto_awesome', web: 'auto_awesome' }}
                  tintColor={
                    autoSkip ? theme.textSecondary : theme.textMuted
                  }
                  size={22}
                />
                <Text style={styles.actionCaption}>Prepare</Text>
              </Pressable>

              <Pressable
                style={styles.actionItem}
                onPress={onMorePress}
                hitSlop={6}
                accessibilityLabel="More playback actions">
                <SymbolView
                  name={{ ios: 'ellipsis', android: 'more_horiz', web: 'more_horiz' }}
                  tintColor={theme.textSecondary}
                  size={22}
                />
                <Text style={styles.actionCaption}>More</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <View style={styles.detailsContent}>
            <Text style={styles.detailsEyebrow}>EPISODE DETAILS</Text>
            <Text style={styles.detailsTitle}>{episode.title}</Text>
            <Text style={styles.detailsShow}>{episode.podcastTitle}</Text>
            <View style={styles.detailsDivider} />
            <Text style={styles.detailsHeading}>Show notes</Text>
            {showNotes ? (
              <Text style={styles.detailsText}>
                {showNotesParts.map((part, idx) =>
                  part.type === 'timestamp' ? (
                    <Text
                      key={`ts-${idx}-${part.raw}`}
                      style={styles.timestampLink}
                      onPress={() => seekToTimestamp(part.ms)}
                      accessibilityRole="link"
                      accessibilityLabel={`Seek to ${part.raw}`}>
                      {part.raw}
                    </Text>
                  ) : (
                    part.text
                  ),
                )}
              </Text>
            ) : (
              <Text style={styles.detailsText}>
                No show notes are available for this episode.
              </Text>
            )}
          </View>
        )}
      </ScrollView>

      <Modal
        visible={skipSheetVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setSkipSheetVisible(false)}>
        <Pressable
          style={styles.sheetBackdrop}
          onPress={() => setSkipSheetVisible(false)}
          accessibilityLabel="Dismiss skip segments">
          <Pressable
            style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}
            onPress={(e) => e.stopPropagation()}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <View style={styles.sheetHeaderText}>
                <Text style={styles.sheetTitle}>Skippable segments</Text>
                <Text style={styles.sheetSubtitle}>
                  {segs.length} {segs.length === 1 ? 'segment' : 'segments'} detected
                </Text>
              </View>
              <Pressable
                onPress={() => setSkipSheetVisible(false)}
                hitSlop={10}
                accessibilityLabel="Close">
                <SymbolView
                  name={{ ios: 'xmark', android: 'close', web: 'close' }}
                  tintColor={theme.textMuted}
                  size={22}
                />
              </Pressable>
            </View>

            <View style={styles.sheetAutoRow}>
              <View style={styles.sheetAutoCopy}>
                <Text style={styles.sheetAutoLabel}>Auto-skip</Text>
                <Text style={styles.sheetAutoHint}>
                  {autoSkip && adDetectionEnabled
                    ? 'Jump past ads automatically'
                    : 'Tap a segment below to jump'}
                </Text>
              </View>
              <Switch
                value={!!(autoSkip && adDetectionEnabled)}
                onValueChange={onSheetAutoSkipChange}
                disabled={autoSkip && !adDetectionEnabled}
                trackColor={{ false: theme.border, true: theme.accent }}
                thumbColor={theme.text}
                ios_backgroundColor={theme.border}
                accessibilityLabel="Toggle auto-skip"
              />
            </View>

            <ScrollView
              style={styles.sheetList}
              bounces={false}
              showsVerticalScrollIndicator={false}>
              {segs.map((seg, idx) => {
                const conf =
                  typeof seg.confidence === 'number' && Number.isFinite(seg.confidence)
                    ? Math.round(seg.confidence * 100)
                    : null;
                return (
                  <Pressable
                    key={`${seg.start_ms}-${seg.end_ms}-${idx}`}
                    style={({ pressed }) => [
                      styles.segRow,
                      pressed && styles.segRowPressed,
                      idx < segs.length - 1 && styles.segRowBorder,
                    ]}
                    onPress={() => onSegmentPress(seg.start_ms)}
                    accessibilityLabel={`${segmentTypeLabel(seg.type)}, ${formatMs(seg.start_ms)} to ${formatMs(seg.end_ms)}`}>
                    <View style={styles.segDot} />
                    <View style={styles.segBody}>
                      <Text style={styles.segType}>{segmentTypeLabel(seg.type)}</Text>
                      <Text style={styles.segMeta}>
                        {formatMs(seg.start_ms)}–{formatMs(seg.end_ms)}
                        {conf != null ? ` · ${conf}%` : ''}
                      </Text>
                    </View>
                    <SymbolView
                      name={{
                        ios: 'forward.end.fill',
                        android: 'skip_next',
                        web: 'skip_next',
                      }}
                      tintColor={theme.textMuted}
                      size={18}
                    />
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.background,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 28,
    alignItems: 'center',
    flexGrow: 1,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    height: 44,
  },
  chevronBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topTabs: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
    alignSelf: 'stretch',
    gap: 4,
  },
  topTab: {
    minWidth: 88,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  topTabActive: {
    borderBottomColor: theme.accent,
  },
  topTabLabel: {
    color: theme.textMuted,
    fontSize: 14,
    fontWeight: '600',
  },
  topTabLabelActive: {
    color: theme.text,
  },
  topBarFiller: {
    width: 44,
  },
  emptyWrap: {
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  emptyTitle: {
    color: theme.text,
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 8,
  },
  emptySub: {
    color: theme.textSecondary,
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
  artWrap: {
    marginTop: 4,
    marginBottom: 28,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 14 },
    elevation: 14,
  },
  art: {
    width: ART_SIZE,
    height: ART_SIZE,
    borderRadius: 12,
    backgroundColor: theme.surfaceElevated,
  },
  artPlaceholder: {
    backgroundColor: theme.border,
  },
  title: {
    color: theme.text,
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: -0.2,
    lineHeight: 26,
    paddingHorizontal: 4,
  },
  show: {
    color: theme.accentSoft,
    fontSize: 15,
    fontWeight: '500',
    marginTop: 8,
    marginBottom: 32,
    textAlign: 'center',
  },
  scrubBlock: {
    width: '100%',
    marginBottom: 4,
  },
  times: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  time: {
    color: theme.textMuted,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '500',
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 40,
    marginTop: 20,
    marginBottom: 28,
  },
  skipBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBtn: {
    width: 78,
    height: 78,
    borderRadius: 39,
    backgroundColor: theme.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flexSpacer: {
    flexGrow: 1,
    minHeight: 12,
  },
  detailsContent: {
    width: '100%',
    alignItems: 'flex-start',
    paddingTop: 24,
    paddingBottom: 24,
  },
  detailsEyebrow: {
    color: theme.accentSoft,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginBottom: 12,
  },
  detailsTitle: {
    color: theme.text,
    fontSize: 24,
    fontWeight: '700',
    lineHeight: 30,
  },
  detailsShow: {
    color: theme.textSecondary,
    fontSize: 15,
    marginTop: 8,
  },
  detailsDivider: {
    width: '100%',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
    marginVertical: 24,
  },
  detailsHeading: {
    color: theme.text,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 10,
  },
  detailsText: {
    color: theme.textSecondary,
    fontSize: 16,
    lineHeight: 24,
  },
  timestampLink: {
    color: theme.accentSoft,
    textDecorationLine: 'underline',
    fontVariant: ['tabular-nums'],
  },
  actionStrip: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingTop: 8,
    paddingHorizontal: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
    paddingBottom: 4,
  },
  actionItem: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
    paddingVertical: 10,
  },
  actionValue: {
    color: theme.text,
    fontSize: 16,
    fontWeight: '700',
    minHeight: 22,
    textAlign: 'center',
  },
  actionValueActive: {
    color: theme.accentSoft,
  },
  actionCaption: {
    color: theme.textMuted,
    fontSize: 11,
    fontWeight: '500',
  },
  analyzeProgress: {
    width: '100%',
    marginBottom: 10,
    paddingHorizontal: 2,
  },
  analyzeProgressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  analyzeProgressText: {
    flex: 1,
    color: theme.textSecondary,
    fontSize: 13,
    fontWeight: '500',
  },
  analyzeBarTrack: {
    height: 3,
    borderRadius: 2,
    backgroundColor: theme.progressTrack,
    overflow: 'hidden',
  },
  analyzeBarFill: {
    height: 3,
    borderRadius: 2,
    backgroundColor: theme.progressFill,
  },
  analyzeBarIndeterminate: {
    width: '40%',
    opacity: 0.55,
  },
  mismatchWarning: {
    width: '100%',
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: 'rgba(255, 193, 7, 0.12)',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 193, 7, 0.3)',
  },
  mismatchWarningRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  mismatchWarningText: {
    flex: 1,
    color: theme.accentWarn,
    fontSize: 12,
    fontWeight: '500',
    lineHeight: 17,
  },
  sheetBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
  },
  sheet: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 20,
    paddingTop: 10,
    maxHeight: '72%',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.border,
    marginBottom: 14,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  sheetHeaderText: {
    flex: 1,
    paddingRight: 12,
  },
  sheetTitle: {
    color: theme.text,
    fontSize: 18,
    fontWeight: '700',
  },
  sheetSubtitle: {
    color: theme.textMuted,
    fontSize: 13,
    marginTop: 4,
  },
  sheetAutoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: theme.surfaceElevated,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
  },
  sheetAutoCopy: {
    flex: 1,
    paddingRight: 12,
  },
  sheetAutoLabel: {
    color: theme.text,
    fontSize: 15,
    fontWeight: '600',
  },
  sheetAutoHint: {
    color: theme.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  sheetList: {
    flexGrow: 0,
  },
  segRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    gap: 12,
  },
  segRowPressed: {
    opacity: 0.7,
  },
  segRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  segDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.accent,
  },
  segBody: {
    flex: 1,
  },
  segType: {
    color: theme.text,
    fontSize: 15,
    fontWeight: '600',
  },
  segMeta: {
    color: theme.textSecondary,
    fontSize: 13,
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
});
