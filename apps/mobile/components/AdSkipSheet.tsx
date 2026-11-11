import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { PodcastSkipSettings } from '@/src/db/storage';
import { skippableSegments, type AdLine, type AdLineActionKind } from '@/src/player/adSkipLine';
import { formatMs, segmentTypeLabel } from '@/src/player/skipLogic';
import type { AdSegment } from '@/src/types';
import { AdSkipLine } from '@/components/AdSkipLine';
import { skipRulesSummary } from '@/components/ShowSettingsSheet';
import { Button, Divider, Group, Sheet, ToggleRow, type } from '@/components/ui';
import { theme } from '@/constants/Colors';
import { font } from '@/constants/Typography';

/**
 * Everything about ad skipping for one episode: the app-wide switch, this show's rules,
 * the segments that were found, and the ways to re-check or report a bad skip.
 */
export function AdSkipSheet({
  visible,
  onClose,
  line,
  segments,
  autoSkip,
  onAutoSkipChange,
  adDetectionEnabled,
  skipSettings,
  showTitle,
  onOpenShowSettings,
  onSegmentPress,
  onAction,
  busy,
  onReport,
}: {
  visible: boolean;
  onClose: () => void;
  line: AdLine;
  segments: AdSegment[];
  autoSkip: boolean;
  onAutoSkipChange: (v: boolean) => void;
  adDetectionEnabled: boolean;
  skipSettings: PodcastSkipSettings | null;
  showTitle?: string;
  onOpenShowSettings?: () => void;
  /** Jump to a segment (omit where there is nothing playing to jump in). */
  onSegmentPress?: (startMs: number) => void;
  onAction: (kind: AdLineActionKind) => void;
  /** A check is running: hide "Check again". */
  busy: boolean;
  onReport?: () => void;
}) {
  const willSkip = new Set(skippableSegments(segments, skipSettings).map((s) => `${s.start_ms}-${s.end_ms}`));
  const skipping = autoSkip && adDetectionEnabled;
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Ad skipping"
      footer={
        <View style={styles.footer}>
          {!busy && (
            <Button
              kind="secondary"
              label={segments.length || line.tone === 'ok' ? 'Check again' : 'Check now'}
              onPress={() => onAction('check')}
              style={styles.footerBtn}
            />
          )}
          {!!onReport && <Button kind="secondary" label="Report a bad skip" onPress={onReport} style={styles.footerBtn} />}
        </View>
      }>
      <AdSkipLine line={line} onAction={onAction} style={{ backgroundColor: theme.surfaceElevated }} />
      <Group>
        <ToggleRow
          label="Skip ads automatically"
          hint="For every show"
          value={autoSkip}
          onChange={onAutoSkipChange}
        />
        {!!onOpenShowSettings && (
          <>
            <Divider />
            <Pressable
              onPress={onOpenShowSettings}
              accessibilityRole="button"
              accessibilityLabel={`Change settings for ${showTitle ?? 'this show'}`}
              style={({ pressed }) => [styles.showRow, pressed && { opacity: 0.6 }]}>
              <View style={styles.flex}>
                <Text style={type.rowTitle} numberOfLines={1}>
                  {showTitle ?? 'This show'}
                </Text>
                <Text style={type.rowHint}>{skipRulesSummary(adDetectionEnabled, skipSettings)}</Text>
              </View>
              <Text style={styles.change}>Change</Text>
            </Pressable>
          </>
        )}
      </Group>
      {segments.length > 0 && (
        <View>
          {segments.map((seg, idx) => {
            const skipped = skipping && willSkip.has(`${seg.start_ms}-${seg.end_ms}`);
            const label = segmentTypeLabel(seg.type);
            const why = !skipping
              ? 'not skipped'
              : skipped
                ? null
                : label === 'Unclassified segment' || seg.confidence < 0.8
                  ? 'unsure, not skipped'
                  : 'not skipped';
            return (
              <Pressable
                key={`${seg.start_ms}-${seg.end_ms}-${idx}`}
                onPress={onSegmentPress ? () => onSegmentPress(seg.start_ms) : undefined}
                disabled={!onSegmentPress}
                accessibilityRole={onSegmentPress ? 'button' : undefined}
                accessibilityLabel={`${label}, ${formatMs(seg.start_ms)} to ${formatMs(seg.end_ms)}${why ? `, ${why}` : ''}${seg.sample_text ? `. ${seg.sample_text}` : ''}`}
                style={({ pressed }) => [styles.seg, idx > 0 && styles.segBorder, pressed && { opacity: 0.6 }]}>
                <View style={styles.segTop}>
                  <Text style={[styles.segTime, !skipped && { color: theme.textMuted }]}>
                    {formatMs(seg.start_ms)} – {formatMs(seg.end_ms)}
                  </Text>
                  <View style={[styles.pill, !skipped && styles.pillQuiet]}>
                    <Text style={[styles.pillText, !skipped && { color: theme.textMuted }]}>
                      {why ? `${label} · ${why}` : label}
                    </Text>
                  </View>
                </View>
                {!!seg.sample_text && (
                  <Text style={styles.sample} numberOfLines={2}>
                    {seg.sample_text}
                  </Text>
                )}
              </Pressable>
            );
          })}
        </View>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  showRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  change: { fontFamily: font.medium, fontSize: 13.5, color: theme.accent },
  seg: { paddingVertical: 11 },
  segBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
  segTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  segTime: { flex: 1, fontFamily: font.mono, fontSize: 13, color: theme.text, fontVariant: ['tabular-nums'] },
  pill: { backgroundColor: theme.adSoft, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3, flexShrink: 1 },
  pillQuiet: { backgroundColor: theme.surfaceElevated },
  pillText: { fontFamily: font.semi, fontSize: 11.5, color: theme.ad },
  sample: { fontFamily: font.body, fontSize: 12.5, lineHeight: 17, color: theme.textMuted, marginTop: 4 },
  footer: { flexDirection: 'row', gap: 10, paddingHorizontal: 18, paddingTop: 10 },
  footerBtn: { flex: 1, paddingHorizontal: 10 },
});
