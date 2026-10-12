import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Episode, SkipMap } from '@/src/types';
import { submitFeedback, toFeedbackSegment, type FeedbackKind } from '@/src/api/feedback';
import { formatMs, segmentTypeLabel } from '@/src/player/skipLogic';
import { showToast } from '@/src/ui/overlayBus';
import { theme } from '@/constants/Colors';

type Props = {
  visible: boolean;
  onClose: () => void;
  episode: Episode | null;
  positionMs: number;
  skipMap: SkipMap | null;
};

/** "Report bad skip": kind, optional segment, optional note → POST /v1/feedback (queued offline). */
export function ReportSkipSheet({ visible, onClose, episode, positionMs, skipMap }: Props) {
  const insets = useSafeAreaInsets();
  const [kind, setKind] = useState<FeedbackKind | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const segs = skipMap?.segments ?? [];
  // Position when the sheet opened, so it doesn't drift while typing.
  const [capturedPos, setCapturedPos] = useState(positionMs);

  useEffect(() => {
    if (!visible) return;
    setKind(null);
    setNote('');
    setCapturedPos(positionMs);
    // Preselect the segment under the playhead, if any.
    const idx = segs.findIndex((s) => positionMs >= s.start_ms - 5_000 && positionMs <= s.end_ms + 5_000);
    setSelected(idx >= 0 ? idx : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const submit = async () => {
    if (!episode || !kind) return;
    setSending(true);
    try {
      const result = await submitFeedback({
        kind,
        episode_guid: episode.guid,
        title: episode.title,
        feed_url: episode.feedUrl,
        position_ms: Math.max(0, Math.round(capturedPos)),
        selected_segment: selected != null && segs[selected] ? toFeedbackSegment(segs[selected]) : null,
        segments: segs.map(toFeedbackSegment),
        model: skipMap?.model ?? null,
        analyzed_at: skipMap?.analyzed_at ?? null,
        note: note.trim() || null,
        client_created_at: new Date().toISOString(),
      });
      showToast(result === 'sent' ? 'Thanks — report sent' : 'Offline — report saved, will retry');
      onClose();
    } catch (e) {
      showToast(`Report rejected: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Dismiss report">
          <Pressable
            style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}
            onPress={(e) => e.stopPropagation()}>
            <View style={styles.handle} />
            <Text style={styles.title}>Report bad skip</Text>
            <Text style={styles.sub} numberOfLines={1}>
              {episode?.title} · at {formatMs(capturedPos)}
            </Text>

            <View style={styles.kindRow}>
              {(
                [
                  ['skipped_content', 'Skipped real content'],
                  ['missed_ad', 'Missed an ad'],
                ] as const
              ).map(([k, label]) => (
                <Pressable
                  key={k}
                  style={[styles.kindBtn, kind === k && styles.kindBtnOn]}
                  onPress={() => setKind(k)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: kind === k }}>
                  <Text style={[styles.kindText, kind === k && styles.kindTextOn]}>{label}</Text>
                </Pressable>
              ))}
            </View>

            {segs.length > 0 && (
              <>
                <Text style={styles.label}>Segment (optional)</Text>
                <ScrollView style={{ maxHeight: 150 }} bounces={false}>
                  {segs.map((s, i) => (
                    <Pressable
                      key={`${s.start_ms}-${i}`}
                      style={[styles.seg, selected === i && styles.segOn]}
                      onPress={() => setSelected(selected === i ? null : i)}>
                      <Text style={styles.segText}>
                        {selected === i ? '● ' : '○ '}
                        {segmentTypeLabel(s.type)} · {formatMs(s.start_ms)}–{formatMs(s.end_ms)}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </>
            )}

            <Text style={styles.label}>Note (optional)</Text>
            <TextInput
              style={styles.input}
              value={note}
              onChangeText={setNote}
              placeholder="What was wrong?"
              placeholderTextColor={theme.textMuted}
              multiline
              maxLength={2000}
            />

            <Pressable
              style={[styles.submit, (!kind || sending) && { opacity: 0.45 }]}
              disabled={!kind || sending}
              onPress={() => void submit()}
              accessibilityRole="button">
              {sending ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Send report</Text>}
            </Pressable>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 20,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.border,
    marginBottom: 12,
  },
  title: { color: theme.text, fontSize: 18, fontWeight: '700' },
  sub: { color: theme.textMuted, fontSize: 13, marginTop: 4, marginBottom: 14 },
  kindRow: { flexDirection: 'row', gap: 8 },
  kindBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surfaceElevated,
    alignItems: 'center',
  },
  kindBtnOn: { borderColor: theme.accent },
  kindText: { color: theme.textSecondary, fontSize: 13, fontWeight: '600' },
  kindTextOn: { color: theme.text },
  label: {
    color: theme.accentSoft,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.6,
    marginTop: 16,
    marginBottom: 6,
    textTransform: 'uppercase',
  },
  seg: { paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8 },
  segOn: { backgroundColor: theme.surfaceElevated },
  segText: { color: theme.text, fontSize: 13 },
  input: {
    minHeight: 64,
    color: theme.text,
    backgroundColor: theme.surfaceElevated,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 10,
    textAlignVertical: 'top',
    fontSize: 14,
  },
  submit: {
    marginTop: 16,
    backgroundColor: theme.accent,
    borderRadius: 22,
    paddingVertical: 12,
    alignItems: 'center',
  },
  submitText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
