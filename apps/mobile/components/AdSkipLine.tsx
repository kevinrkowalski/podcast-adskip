import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { AdLine, AdLineAction, AdLineActionKind } from '@/src/player/adSkipLine';
import { Icon } from '@/components/ui';
import { theme } from '@/constants/Colors';
import { font } from '@/constants/Typography';

const DOT = { on: theme.ad, ok: theme.success, idle: theme.textMuted, bad: theme.danger, busy: theme.ad } as const;

/**
 * The ad-skipping status line. Tapping the line opens the Ad skipping sheet (`onPress`);
 * its buttons run the one thing there is to do (`onAction`).
 */
export function AdSkipLine({
  line,
  onPress,
  onAction,
  style,
}: {
  line: AdLine;
  onPress?: () => void;
  onAction: (kind: AdLineActionKind) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const actions = [line.action, line.secondAction].filter((a): a is AdLineAction => !!a);
  // Two buttons, or a long label, go on their own row under the text.
  const stacked = actions.length > 1;
  const button = (a: AdLineAction, primary: boolean) => (
    <Pressable
      key={a.kind}
      onPress={() => onAction(a.kind)}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={a.label}
      style={({ pressed }) => [styles.action, !primary && styles.actionSecondary, pressed && { opacity: 0.6 }]}>
      <Text style={[styles.actionText, !primary && { color: theme.text }]}>{a.label}</Text>
    </Pressable>
  );
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityLabel={`Ad skipping: ${line.text}${line.detail ? `. ${line.detail}` : ''}`}
      accessibilityHint={onPress ? 'Opens ad skipping details' : undefined}
      style={({ pressed }) => [styles.wrap, pressed && { opacity: 0.8 }, style]}>
      <View style={styles.row}>
        {line.tone === 'busy' ? (
          <ActivityIndicator size="small" color={theme.ad} style={styles.spinner} />
        ) : (
          <View style={[styles.dot, { backgroundColor: DOT[line.tone] }]} />
        )}
        <View style={styles.text}>
          <Text style={styles.title}>{line.text}</Text>
          {!!line.detail && (
            <Text style={styles.detail} numberOfLines={3}>
              {line.detail}
            </Text>
          )}
        </View>
        {!stacked && actions.map((a) => button(a, true))}
        {actions.length === 0 && !!onPress && <Icon name="right" size={18} color={theme.textMuted} />}
      </View>
      {stacked && <View style={styles.actions}>{actions.map((a, i) => button(a, i === 0))}</View>}
      {line.progressPct !== undefined && (
        <View style={styles.track}>
          {line.progressPct != null && (
            <View style={[styles.fill, { width: `${line.progressPct}%` as unknown as number }]} />
          )}
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { backgroundColor: theme.surface, borderRadius: 14, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 13 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  spinner: { width: 9, transform: [{ scale: 0.7 }] },
  text: { flex: 1, minWidth: 0 },
  title: { fontFamily: font.medium, fontSize: 14.5, color: theme.text },
  detail: { fontFamily: font.body, fontSize: 12.5, lineHeight: 17, color: theme.textSecondary, marginTop: 2 },
  action: { backgroundColor: theme.accent, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 },
  actionSecondary: { backgroundColor: theme.surfaceElevated },
  actionText: { fontFamily: font.semi, fontSize: 13, color: theme.accentInk },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingLeft: 35, paddingRight: 14, paddingBottom: 13 },
  track: { height: 2, backgroundColor: 'transparent' },
  fill: { height: 2, backgroundColor: theme.ad },
});
