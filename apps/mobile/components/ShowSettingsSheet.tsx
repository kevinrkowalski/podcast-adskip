import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import {
  getCachedEpisodes,
  getPodcastSkipSettings,
  isPodcastAdDetectionEnabled,
  type PodcastSkipSettings,
} from '@/src/db/storage';
import { isAutoQueueEnabled, setAutoQueueEnabled } from '@/src/queue/queueStore';
import { usePlayback } from '@/src/store/PlaybackContext';
import type { Episode } from '@/src/types';
import { Divider, Group, Label, Sheet, ToggleRow, type } from '@/components/ui';

export type ShowTargetInfo = { collectionId?: number; feedUrl?: string; title?: string };

/**
 * Per-show settings: auto-add to the queue, ad detection, and which kinds of segment are
 * skipped. Loads the show's saved settings each time it opens and saves every change.
 */
export function ShowSettingsSheet({
  visible,
  onClose,
  show,
  knownEpisodes,
  onChanged,
}: {
  visible: boolean;
  onClose: () => void;
  show: ShowTargetInfo | null;
  /** Episodes already listed (so turning auto-add on never back-fills them). */
  knownEpisodes?: Episode[];
  onChanged?: () => void;
}) {
  const { setPodcastAdDetection, setPodcastSkipSetting } = usePlayback();
  const [autoQueue, setAutoQueue] = useState(false);
  const [adDetection, setAdDetection] = useState(true);
  const [skip, setSkip] = useState<PodcastSkipSettings | null>(null);
  const collectionId = show?.collectionId;
  const feedUrl = show?.feedUrl;
  const target = { collectionId, feedUrl };

  useEffect(() => {
    if (!visible || (collectionId == null && !feedUrl)) return;
    let cancelled = false;
    void (async () => {
      const t = { collectionId, feedUrl };
      const [aq, ad, sk] = await Promise.all([
        isAutoQueueEnabled(t),
        isPodcastAdDetectionEnabled(t),
        getPodcastSkipSettings(t),
      ]);
      if (cancelled) return;
      setAutoQueue(aq);
      setAdDetection(ad);
      setSkip(sk);
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, collectionId, feedUrl]);

  const onAutoQueue = async (v: boolean) => {
    setAutoQueue(v);
    // Everything already known counts as seen: only later releases are added.
    const known = knownEpisodes ?? (feedUrl ? await getCachedEpisodes(feedUrl).catch(() => []) : []);
    await setAutoQueueEnabled(target, v, known);
    onChanged?.();
  };
  const onAdDetection = async (v: boolean) => {
    setAdDetection(v);
    await setPodcastAdDetection(target, v);
    onChanged?.();
  };
  const onSkip = async (key: keyof PodcastSkipSettings, v: boolean) => {
    if (!skip) return;
    setSkip({ ...skip, [key]: v });
    await setPodcastSkipSetting(target, { [key]: v });
    onChanged?.();
  };
  const skipOn = !!skip?.skipEnabled;

  return (
    <Sheet visible={visible} onClose={onClose} title="Show settings" subtitle={show?.title}>
      <Label>Queue</Label>
      <Group>
        <ToggleRow
          label="Add new episodes to the queue"
          hint="New releases go to the end of Up next"
          value={autoQueue}
          onChange={(v) => void onAutoQueue(v)}
        />
      </Group>
      <Label>Ad skipping</Label>
      <Group>
        <ToggleRow
          label="Check episodes for ads"
          hint={adDetection ? 'Checked when you start an episode or queue it' : 'Off. You can still check one episode by hand'}
          value={adDetection}
          onChange={(v) => void onAdDetection(v)}
        />
        {!!skip && (
          <>
            <Divider />
            <ToggleRow
              label="Skip what is found"
              hint={skipOn ? undefined : 'Off. Segments are shown but not skipped'}
              value={skipOn}
              onChange={(v) => void onSkip('skipEnabled', v)}
            />
            <Divider />
            <ToggleRow indent label="Advertisements" value={skip.skipAdvertisement} disabled={!skipOn} onChange={(v) => void onSkip('skipAdvertisement', v)} />
            <ToggleRow indent label="Intro and outro" value={skip.skipIntroOutro} disabled={!skipOn} onChange={(v) => void onSkip('skipIntroOutro', v)} />
            <ToggleRow indent label="Self promotion" value={skip.skipSelfPromotion} disabled={!skipOn} onChange={(v) => void onSkip('skipSelfPromotion', v)} />
          </>
        )}
      </Group>
      {collectionId == null && !feedUrl && (
        <View>
          <Text style={type.meta}>This episode has no show attached, so there is nothing to set.</Text>
        </View>
      )}
    </Sheet>
  );
}

/** "Skips ads and intros" style summary of a show's rules. */
export function skipRulesSummary(adDetection: boolean, skip: PodcastSkipSettings | null): string {
  if (!adDetection) return 'Not checked for ads';
  if (!skip || !skip.skipEnabled) return 'Found segments are not skipped';
  const kinds = [
    skip.skipAdvertisement ? 'ads' : null,
    skip.skipIntroOutro ? 'intros' : null,
    skip.skipSelfPromotion ? 'self promotion' : null,
  ].filter((k): k is string => !!k);
  if (!kinds.length) return 'Nothing is skipped';
  if (kinds.length === 1) return `Skips ${kinds[0]}`;
  return `Skips ${kinds.slice(0, -1).join(', ')} and ${kinds[kinds.length - 1]}`;
}
