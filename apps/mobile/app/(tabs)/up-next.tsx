import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { QueueList, confirmClearQueue } from '@/components/QueueList';
import { useUpNextCount } from '@/src/queue/queueStore';
import { theme } from '@/constants/Colors';
import { displayFontFamily } from '@/constants/Typography';

/** Up Next tab: same queue UI as /queue, with a Library-style heading. */
export default function UpNextTab() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const count = useUpNextCount();
  return (
    <View style={[styles.container, { paddingTop: insets.top + 8 }]}>
      <View style={styles.headingRow}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.eyebrow}>QUEUE</Text>
          <Text style={styles.heading}>Queue</Text>
          <Text style={styles.subheading}>
            {count === 0 ? 'Nothing queued' : `${count} episode${count === 1 ? '' : 's'}`}
          </Text>
        </View>
        {count > 0 && (
          <Pressable
            onPress={() => confirmClearQueue(count)}
            hitSlop={10}
            style={styles.clearBtn}
            accessibilityLabel="Clear queue">
            <Text style={styles.clear}>Clear</Text>
          </Pressable>
        )}
      </View>
      {/* Same single root-level navigation as episode rows (PR #16–17 route fixes). */}
      <QueueList onOpened={() => router.push('/now-playing' as Href)} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  headingRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 16 },
  eyebrow: { color: theme.accentSoft, fontSize: 10, fontWeight: '700', letterSpacing: 1.8, marginBottom: 3 },
  heading: {
    color: theme.text,
    fontFamily: displayFontFamily,
    fontSize: 34,
    fontWeight: '600',
    letterSpacing: -0.8,
  },
  subheading: { color: theme.textSecondary, fontSize: 14, marginTop: 4 },
  clearBtn: { paddingVertical: 10, paddingHorizontal: 4 },
  clear: { color: theme.accent, fontWeight: '600', fontSize: 15 },
});
