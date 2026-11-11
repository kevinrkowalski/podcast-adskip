import type { ReactNode } from 'react';
import {
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { theme } from '@/constants/Colors';
import { font } from '@/constants/Typography';

/** Space the floating dock (mini player + tabs) covers at the bottom of a tab screen. */
export const DOCK_SPACE = 168;

const ICONS = {
  listen: { ios: 'headphones', android: 'headphones', web: 'headphones' },
  shows: { ios: 'square.grid.2x2', android: 'grid_view', web: 'grid_view' },
  search: { ios: 'magnifyingglass', android: 'search', web: 'search' },
  settings: { ios: 'gearshape', android: 'settings', web: 'settings' },
  tune: { ios: 'slider.horizontal.3', android: 'tune', web: 'tune' },
  play: { ios: 'play.fill', android: 'play_arrow', web: 'play_arrow' },
  pause: { ios: 'pause.fill', android: 'pause', web: 'pause' },
  more: { ios: 'ellipsis', android: 'more_horiz', web: 'more_horiz' },
  down: { ios: 'chevron.down', android: 'keyboard_arrow_down', web: 'keyboard_arrow_down' },
  right: { ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' },
  close: { ios: 'xmark', android: 'close', web: 'close' },
  check: { ios: 'checkmark', android: 'check', web: 'check' },
  plus: { ios: 'plus', android: 'add', web: 'add' },
  queue: { ios: 'list.bullet', android: 'queue_music', web: 'queue_music' },
  grip: { ios: 'line.3.horizontal', android: 'drag_handle', web: 'drag_handle' },
  warning: { ios: 'exclamationmark.triangle', android: 'warning', web: 'warning' },
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 22, color = theme.textSecondary }: { name: IconName; size?: number; color?: string }) {
  return <SymbolView name={ICONS[name]} size={size} tintColor={color} />;
}

/** Flat cover art: square, small radius, no shadow. */
export function Cover({
  uri,
  size,
  radius = 6,
  style,
}: {
  uri?: string | null;
  /** Width and height; omit to size with `style` (e.g. width: '100%', aspectRatio: 1). */
  size?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const box: ViewStyle = { borderRadius: radius, backgroundColor: theme.surfaceElevated, overflow: 'hidden' };
  if (size != null) {
    box.width = size;
    box.height = size;
  }
  return (
    <View style={[box, style]}>
      {!!uri && <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />}
    </View>
  );
}

/** Small uppercase section label. */
export function Label({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[type.label, style]}>{children}</Text>;
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[{ height: StyleSheet.hairlineWidth, backgroundColor: theme.border }, style]} />;
}

export function Button({
  label,
  onPress,
  kind = 'primary',
  icon,
  disabled,
  style,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  /** primary: light fill; accent: brass fill; secondary: quiet fill; danger: quiet fill, red text. */
  kind?: 'primary' | 'accent' | 'secondary' | 'danger';
  icon?: IconName;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const fg =
    kind === 'primary' ? theme.background : kind === 'accent' ? theme.accentInk : kind === 'danger' ? theme.danger : theme.text;
  const bg = kind === 'primary' ? theme.text : kind === 'accent' ? theme.accent : theme.surfaceElevated;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg },
        (pressed || disabled) && { opacity: 0.6 },
        style,
      ]}>
      {!!icon && <Icon name={icon} size={16} color={fg} />}
      <Text style={[styles.buttonText, { color: fg }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Outlined pill; filled when `on`. */
export function Chip({
  label,
  on,
  onPress,
  trailing,
  accessibilityLabel,
}: {
  label: string;
  on?: boolean;
  onPress?: () => void;
  trailing?: IconName;
  accessibilityLabel?: string;
}) {
  const fg = on ? theme.accentInk : theme.textSecondary;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={on != null ? { selected: on } : undefined}
      style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && { opacity: 0.7 }]}>
      <Text style={[styles.chipText, { color: fg }]} numberOfLines={1}>
        {label}
      </Text>
      {!!trailing && <Icon name={trailing} size={14} color={fg} />}
    </Pressable>
  );
}

/** A labelled switch row for sheets and settings. */
export function ToggleRow({
  label,
  hint,
  value,
  onChange,
  disabled,
  indent,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  indent?: boolean;
}) {
  return (
    <View style={[styles.toggleRow, indent && { paddingLeft: 14 }, disabled && { opacity: 0.45 }]}>
      <View style={styles.flex}>
        <Text style={type.rowTitle}>{label}</Text>
        {!!hint && <Text style={type.rowHint}>{hint}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: theme.border, true: theme.accent }}
        thumbColor={theme.text}
        ios_backgroundColor={theme.border}
        accessibilityLabel={label}
      />
    </View>
  );
}

/** Rounded group that holds rows (settings cards, sheet groups). */
export function Group({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.group, style]}>{children}</View>;
}

/**
 * Bottom sheet: dimmed backdrop, grab handle, optional title. Content scrolls when it is
 * taller than the space available.
 */
export function Sheet({
  visible,
  onClose,
  title,
  subtitle,
  children,
  footer,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: ReactNode;
  /** Pinned under the scrolling content. */
  footer?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.sheetRoot}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16), marginTop: insets.top + 40 }]}>
          <View style={styles.grab} />
          {!!title && (
            <View style={styles.sheetHeader}>
              <View style={styles.flex}>
                <Text style={type.sheetTitle} numberOfLines={2}>
                  {title}
                </Text>
                {!!subtitle && <Text style={type.rowHint}>{subtitle}</Text>}
              </View>
              <Pressable onPress={onClose} hitSlop={12} accessibilityLabel="Close" style={styles.sheetClose}>
                <Icon name="close" size={18} />
              </Pressable>
            </View>
          )}
          <ScrollView
            style={styles.sheetScroll}
            contentContainerStyle={styles.sheetContent}
            bounces={false}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
          {footer}
        </View>
      </View>
    </Modal>
  );
}

/** Shared text styles. Custom fonts carry their weight, so none of these set fontWeight. */
export const type = StyleSheet.create({
  screenTitle: { fontFamily: font.display, fontSize: 32, letterSpacing: -0.6, color: theme.text },
  heading: { fontFamily: font.displaySemi, fontSize: 18, color: theme.text },
  sheetTitle: { fontFamily: font.displaySemi, fontSize: 19, color: theme.text },
  title: { fontFamily: font.semi, fontSize: 15, lineHeight: 20, color: theme.text },
  body: { fontFamily: font.body, fontSize: 15, lineHeight: 23, color: theme.textSecondary },
  meta: { fontFamily: font.body, fontSize: 13, lineHeight: 18, color: theme.textSecondary },
  metaMuted: { fontFamily: font.body, fontSize: 12.5, lineHeight: 17, color: theme.textMuted },
  label: {
    fontFamily: font.semi,
    fontSize: 11,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: theme.textMuted,
  },
  mono: { fontFamily: font.mono, fontSize: 12.5, color: theme.textMuted, fontVariant: ['tabular-nums'] },
  rowTitle: { fontFamily: font.medium, fontSize: 15, color: theme.text },
  rowHint: { fontFamily: font.body, fontSize: 13, lineHeight: 18, color: theme.textSecondary, marginTop: 2 },
  link: { fontFamily: font.medium, color: theme.accent, textDecorationLine: 'underline' },
});

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 18,
    minHeight: 44,
  },
  buttonText: { fontFamily: font.semi, fontSize: 14 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 7,
  },
  chipOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  chipText: { fontFamily: font.medium, fontSize: 13 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  group: { backgroundColor: theme.surfaceElevated, borderRadius: 14, paddingHorizontal: 14 },
  sheetRoot: { flex: 1, justifyContent: 'flex-end', backgroundColor: theme.scrim },
  sheet: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingTop: 10,
    flexShrink: 1,
  },
  grab: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: theme.border, marginBottom: 10 },
  sheetHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 18, paddingBottom: 12 },
  sheetClose: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: theme.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetScroll: { flexGrow: 0 },
  sheetContent: { paddingHorizontal: 18, paddingBottom: 8, gap: 14 },
});
