import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import {
  getPodcastSkipSettings,
  isPodcastAdDetectionEnabled,
  type PodcastSkipSettings,
} from '@/src/db/storage';
import { openShowForEpisode } from '@/src/navigation/openShow';
import { isPlayed, usePlayedVersion } from '@/src/played/playedStore';
import { adSkipLine, isAnalyzing, type AdLineActionKind } from '@/src/player/adSkipLine';
import { formatMs } from '@/src/player/skipLogic';
import { addToQueue, playNext, removeFromQueue, useQueue } from '@/src/queue/queueStore';
import { usePlayback } from '@/src/store/PlaybackContext';
import type { Episode } from '@/src/types';
import { htmlToPlainText } from '@/src/ui/htmlText';
import { showToast, subscribeEpisodeSheet } from '@/src/ui/overlayBus';
import { AdSkipLine } from '@/components/AdSkipLine';
import { AdSkipSheet } from '@/components/AdSkipSheet';
import { ShowSettingsSheet } from '@/components/ShowSettingsSheet';
import { Button, Divider, Icon, Sheet, type } from '@/components/ui';
import { theme } from '@/constants/Colors';
import { font } from '@/constants/Typography';

function formatDate(raw?: string): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * The episode sheet: notes and every action for one episode (play, queue, check for ads,
 * mark played), opened from any list with showEpisodeSheet(). Mounted once in the root
 * layout. The episode that is already loaded opens the player instead.
 */
export function EpisodeSheetHost() {
  const router = useRouter();
  const playback = usePlayback();
  const { openEpisode, closeOpenedEpisode, openedEpisode } = playback;
  const queue = useQueue();
  usePlayedVersion();
  const [ep, setEp] = useState<Episode | null>(null);
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [adSheet, setAdSheet] = useState(false);
  const [settingsSheet, setSettingsSheet] = useState(false);
  const [adDetection, setAdDetection] = useState(true);
  const [skipSettings, setSkipSettings] = useState<PodcastSkipSettings | null>(null);
  const currentGuid = playback.episode?.guid;

  useEffect(
    () =>
      subscribeEpisodeSheet((next) => {
        if (next.guid === currentGuid) {
          router.push('/now-playing' as Href);
          return;
        }
        setNotesExpanded(false);
        setEp(next);
        // Looks up a prepared skip map, the saved position and the show notes.
        openEpisode(next);
      }),
    [currentGuid, openEpisode, router],
  );

  const loadShowRules = async (target: Episode) => {
    const t = { collectionId: target.collectionId, feedUrl: target.feedUrl };
    const [ad, skip] = await Promise.all([isPodcastAdDetectionEnabled(t), getPodcastSkipSettings(t)]);
    setAdDetection(ad);
    setSkipSettings(skip);
  };
  const guid = ep?.guid;
  useEffect(() => {
    if (ep) void loadShowRules(ep).catch(() => {});
    // Per episode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guid]);

  const close = () => {
    setEp(null);
    setAdSheet(false);
    setSettingsSheet(false);
    closeOpenedEpisode();
  };

  const opened = ep && openedEpisode?.episode.guid === ep.guid ? openedEpisode : null;
  const episode = opened?.episode ?? ep;
  const skipMap = opened?.skipMap ?? null;
  const analyzeStatus = opened?.analyzeStatus ?? (skipMap?.status === 'ready' ? 'ready' : null);
  const line = useMemo(
    () =>
      adSkipLine({
        hasAudio: !!episode?.enclosureUrl,
        autoSkip: playback.autoSkip,
        adDetectionEnabled: adDetection,
        skipSettings,
        skipMap,
        analyzeStatus,
        analyzeError: opened?.analyzeError,
        uploadProgress: opened?.uploadProgress,
      }),
    [episode?.enclosureUrl, playback.autoSkip, adDetection, skipSettings, skipMap, analyzeStatus, opened?.analyzeError, opened?.uploadProgress],
  );
  const notes = useMemo(() => htmlToPlainText(episode?.description), [episode?.description]);

  if (!ep || !episode) return null;

  const queued = queue.some((e) => e.guid === ep.guid);
  const played = isPlayed(ep.guid);
  const notesStatus = playback.showNotesStatus?.guid === ep.guid ? playback.showNotesStatus.status : null;
  const meta = [episode.podcastTitle, formatDate(episode.pubDate), episode.duration].filter(Boolean).join(' · ');
  const resumeAt = opened && opened.positionMs > 5_000 ? opened.positionMs : 0;

  const onAction = (kind: AdLineActionKind) => {
    if (kind === 'check') void playback.prepareOpenedEpisode(true);
    else if (kind === 'turnOn') void playback.setAutoSkip(true);
    else if (kind === 'showSettings') setSettingsSheet(true);
  };

  const play = () => {
    const target = ep;
    close();
    void playback.playEpisode(target);
  };

  return (
    <>
      <Sheet visible onClose={close}>
        <View>
          {!!meta && <Text style={type.metaMuted}>{meta}</Text>}
          <Text style={styles.title}>{episode.title}</Text>
        </View>
        <View style={styles.buttons}>
          <Button
            label={resumeAt ? `Resume ${formatMs(resumeAt)}` : 'Play'}
            icon="play"
            onPress={play}
            disabled={!episode.enclosureUrl}
            style={styles.playBtn}
          />
          <Button
            kind="secondary"
            label="Play next"
            onPress={() => {
              void playNext(ep);
              showToast('Playing next');
              close();
            }}
          />
          {queued ? (
            <Button
              kind="secondary"
              label="Remove"
              accessibilityLabel="Remove from queue"
              onPress={() => {
                void removeFromQueue(ep.guid);
                showToast('Removed from queue');
                close();
              }}
            />
          ) : (
            <Button
              kind="secondary"
              label="Queue"
              accessibilityLabel="Add to queue"
              onPress={() => {
                void addToQueue(ep);
                showToast('Added to queue');
                close();
              }}
            />
          )}
        </View>
        {!episode.enclosureUrl ? (
          <Text style={type.meta}>This episode has no audio file in its feed.</Text>
        ) : (
          <AdSkipLine
            line={line}
            onPress={() => setAdSheet(true)}
            onAction={onAction}
            style={{ backgroundColor: theme.surfaceElevated }}
          />
        )}
        {notes ? (
          <View>
            <Text style={type.body} numberOfLines={notesExpanded ? undefined : 5}>
              {notes}
            </Text>
            {(notes.length > 260 || notes.split('\n').length > 5) && (
              <Pressable onPress={() => setNotesExpanded((v) => !v)} hitSlop={8} accessibilityRole="button" style={styles.more}>
                <Text style={type.link}>{notesExpanded ? 'Less' : 'More'}</Text>
              </Pressable>
            )}
          </View>
        ) : notesStatus === 'loading' ? (
          <Text style={type.meta}>Loading show notes…</Text>
        ) : notesStatus === 'failed' ? (
          <View style={styles.rowBetween}>
            <Text style={[type.meta, styles.flex]}>Couldn’t load show notes.</Text>
            <Pressable onPress={playback.retryShowNotes} hitSlop={8} accessibilityRole="button">
              <Text style={type.link}>Try again</Text>
            </Pressable>
          </View>
        ) : null}
        <View>
          <Divider />
          <Pressable
            onPress={() => void playback.setEpisodePlayed(ep, !played)}
            accessibilityRole="button"
            style={({ pressed }) => [styles.action, pressed && { opacity: 0.6 }]}>
            <Text style={[type.rowTitle, styles.flex]}>{played ? 'Mark as unplayed' : 'Mark as played'}</Text>
            {played && <Icon name="check" size={18} color={theme.success} />}
          </Pressable>
          <Divider />
          <Pressable
            onPress={() => {
              const target = ep;
              close();
              void openShowForEpisode(router, target).catch((e) => console.warn('[episode-sheet] open show failed:', e));
            }}
            accessibilityRole="button"
            style={({ pressed }) => [styles.action, pressed && { opacity: 0.6 }]}>
            <Text style={[type.rowTitle, styles.flex]} numberOfLines={1}>
              Go to {episode.podcastTitle ?? 'the show'}
            </Text>
            <Icon name="right" size={18} color={theme.textMuted} />
          </Pressable>
        </View>
      </Sheet>
      <AdSkipSheet
        visible={adSheet}
        onClose={() => setAdSheet(false)}
        line={line}
        segments={skipMap?.segments ?? []}
        autoSkip={playback.autoSkip}
        onAutoSkipChange={(v) => void playback.setAutoSkip(v)}
        adDetectionEnabled={adDetection}
        skipSettings={skipSettings}
        showTitle={episode.podcastTitle}
        onOpenShowSettings={() => setSettingsSheet(true)}
        onAction={onAction}
        busy={isAnalyzing(analyzeStatus)}
      />
      <ShowSettingsSheet
        visible={settingsSheet}
        onClose={() => setSettingsSheet(false)}
        show={{ collectionId: ep.collectionId, feedUrl: ep.feedUrl, title: episode.podcastTitle }}
        onChanged={() => void loadShowRules(ep).catch(() => {})}
      />
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  title: { fontFamily: font.displaySemi, fontSize: 20, lineHeight: 26, color: theme.text, marginTop: 4 },
  buttons: { flexDirection: 'row', gap: 8 },
  playBtn: { flex: 1 },
  more: { alignSelf: 'flex-start', marginTop: 6 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
});
