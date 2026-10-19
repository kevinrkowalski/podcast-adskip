import { useEffect, useRef, useState } from 'react';
import { Animated, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  subscribeActionSheet,
  subscribeToast,
  type SheetRequest,
} from '@/src/ui/overlayBus';
import { theme } from '@/constants/Colors';

/**
 * App-wide action sheet (no 3-button limit like Android's Alert) and toast.
 * Mounted once in the root layout; opened via showActionSheet / showToast.
 */
export function OverlayHost() {
  const insets = useSafeAreaInsets();
  const [sheet, setSheet] = useState<SheetRequest | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => subscribeActionSheet(setSheet), []);
  useEffect(
    () =>
      subscribeToast((msg) => {
        setToast(msg);
        if (hideTimer.current) clearTimeout(hideTimer.current);
        Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }).start();
        hideTimer.current = setTimeout(() => {
          // A newer toast's fade-in interrupts this (finished=false); don't wipe it.
          Animated.timing(opacity, { toValue: 0, duration: 250, useNativeDriver: true }).start(
            ({ finished }) => {
              if (finished) setToast(null);
            },
          );
        }, 2600);
      }),
    [opacity],
  );

  const close = () => setSheet(null);

  return (
    <>
      <Modal visible={!!sheet} transparent animationType="slide" onRequestClose={close}>
        <Pressable style={styles.backdrop} onPress={close} accessibilityLabel="Dismiss menu">
          <Pressable
            style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}
            onPress={(e) => e.stopPropagation()}>
            <View style={styles.handle} />
            {!!sheet?.title && (
              <Text style={styles.title} numberOfLines={2}>
                {sheet.title}
              </Text>
            )}
            {!!sheet?.message && <Text style={styles.message}>{sheet.message}</Text>}
            {sheet?.actions.map((a, i) => (
              <Pressable
                key={`${a.label}-${i}`}
                style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
                onPress={() => {
                  close();
                  // Let the sheet close before the action opens anything else.
                  setTimeout(a.onPress, 50);
                }}
                accessibilityRole="button">
                <Text style={[styles.actionText, a.destructive && { color: theme.danger }]}>{a.label}</Text>
              </Pressable>
            ))}
            <Pressable style={[styles.action, styles.cancel]} onPress={close} accessibilityRole="button">
              <Text style={[styles.actionText, { color: theme.textMuted }]}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
      {toast != null && (
        <Animated.View
          pointerEvents="none"
          style={[styles.toast, { opacity, bottom: insets.bottom + 140 }]}
          accessibilityLiveRegion="polite">
          <Text style={styles.toastText}>{toast}</Text>
        </Animated.View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
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
  title: { color: theme.text, fontSize: 16, fontWeight: '700', marginBottom: 2 },
  message: { color: theme.textMuted, fontSize: 13, marginBottom: 4 },
  action: {
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  actionPressed: { backgroundColor: theme.surfaceElevated },
  actionText: { color: theme.text, fontSize: 15, fontWeight: '500' },
  cancel: { borderBottomWidth: 0, marginTop: 4 },
  toast: {
    position: 'absolute',
    alignSelf: 'center',
    maxWidth: '86%',
    backgroundColor: theme.surfaceElevated,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  toastText: { color: theme.text, fontSize: 13, fontWeight: '500', textAlign: 'center' },
});
