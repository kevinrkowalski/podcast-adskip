import { useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import type { PodcastSkipSettings } from '@/src/db/storage';
import { theme } from '@/constants/Colors';

type Props = {
  autoQueue: boolean;
  onAutoQueueChange: (v: boolean) => void;
  adDetectionEnabled: boolean;
  onAdDetectionChange: (v: boolean) => void;
  skipSettings: PodcastSkipSettings | null;
  onSkipSettingChange: (key: keyof PodcastSkipSettings, v: boolean) => void;
};

/**
 * One collapsible per-show settings card with two sections:
 * "Playback & queue" and "Ad skipping". Segment-kind toggles are dimmed and
 * disabled when the "Skip segments" master is off.
 */
export function ShowSettingsCard(props: Props) {
  const { autoQueue, adDetectionEnabled, skipSettings } = props;
  const [expanded, setExpanded] = useState(false);
  const skipOn = !!skipSettings?.skipEnabled;

  const summary = [
    adDetectionEnabled ? 'Ad detection on' : 'Ad detection off',
    skipOn ? 'skipping on' : 'skipping off',
    autoQueue ? 'auto-add on' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <View style={styles.card}>
      <Pressable
        style={styles.header}
        onPress={() => setExpanded((e) => !e)}
        accessibilityRole="button"
        accessibilityLabel="Show settings"
        accessibilityState={{ expanded }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.heading}>Show settings</Text>
          <Text style={styles.summary}>{summary}</Text>
        </View>
        <SymbolView
          name={{
            ios: expanded ? 'chevron.up' : 'chevron.down',
            android: expanded ? 'keyboard_arrow_up' : 'keyboard_arrow_down',
            web: expanded ? 'keyboard_arrow_up' : 'keyboard_arrow_down',
          }}
          size={18}
          tintColor={theme.textMuted}
        />
      </Pressable>

      {expanded && (
        <View style={styles.body}>
          <Text style={styles.section}>PLAYBACK & QUEUE</Text>
          <Row
            label="Auto-add new episodes"
            hint="New releases go to the end of the queue"
            value={autoQueue}
            onChange={props.onAutoQueueChange}
            last
          />

          <Text style={[styles.section, { marginTop: 14 }]}>AD SKIPPING</Text>
          <Row
            label="Ad detection"
            hint={adDetectionEnabled ? 'Auto-analyze when you start an episode' : 'Off · Prepare still works in the player'}
            value={adDetectionEnabled}
            onChange={props.onAdDetectionChange}
          />
          {skipSettings && (
            <>
              <Row
                label="Skip segments"
                hint={skipOn ? 'Jump over detected segments' : 'Off · segments are shown but not skipped'}
                value={skipOn}
                onChange={(v) => props.onSkipSettingChange('skipEnabled', v)}
              />
              <View style={[styles.subGroup, !skipOn && styles.dimmed]}>
                <Row
                  sub
                  label="Advertisements"
                  value={skipSettings.skipAdvertisement}
                  disabled={!skipOn}
                  onChange={(v) => props.onSkipSettingChange('skipAdvertisement', v)}
                />
                <Row
                  sub
                  label="Intro / outro"
                  value={skipSettings.skipIntroOutro}
                  disabled={!skipOn}
                  onChange={(v) => props.onSkipSettingChange('skipIntroOutro', v)}
                />
                <Row
                  sub
                  last
                  label="Self promotion"
                  value={skipSettings.skipSelfPromotion}
                  disabled={!skipOn}
                  onChange={(v) => props.onSkipSettingChange('skipSelfPromotion', v)}
                />
              </View>
            </>
          )}
        </View>
      )}
    </View>
  );
}

function Row({
  label,
  hint,
  value,
  onChange,
  disabled,
  sub,
  last,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  sub?: boolean;
  last?: boolean;
}) {
  return (
    <View style={[styles.row, sub && styles.subRow, last && { borderBottomWidth: 0 }]}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={sub ? styles.subLabel : styles.label}>{label}</Text>
        {!!hint && <Text style={styles.hint}>{hint}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: theme.border, true: theme.accentSoft }}
        thumbColor={value ? theme.accent : '#ccc'}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
    marginTop: 14,
    overflow: 'hidden',
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, minHeight: 60 },
  heading: { color: theme.text, fontSize: 14, fontWeight: '600' },
  summary: { color: theme.textMuted, fontSize: 12, marginTop: 4 },
  body: {
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  section: { color: theme.accentSoft, fontSize: 10, fontWeight: '700', letterSpacing: 2, marginBottom: 2 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  subGroup: { marginLeft: 14, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: theme.border },
  subRow: { paddingVertical: 4 },
  dimmed: { opacity: 0.4 },
  label: { color: theme.text, fontSize: 14, fontWeight: '500' },
  subLabel: { color: theme.textSecondary, fontSize: 13 },
  hint: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
});
