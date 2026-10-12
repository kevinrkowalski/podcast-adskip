import { Pressable, StyleSheet, Text } from 'react-native';
import { Stack, useRouter, type Href } from 'expo-router';
import { QueueList, confirmClearQueue } from '@/components/QueueList';
import { useQueue } from '@/src/queue/queueStore';
import { theme } from '@/constants/Colors';

/** Up Next page opened from the player's Up Next button (stack screen). */
export default function QueueScreen() {
  const router = useRouter();
  const count = useQueue().length;
  return (
    <>
      <Stack.Screen
        options={{
          title: 'Up Next',
          headerRight: () =>
            count ? (
              <Pressable onPress={() => confirmClearQueue(count)} hitSlop={10} accessibilityLabel="Clear Up Next">
                <Text style={styles.clear}>Clear</Text>
              </Pressable>
            ) : null,
        }}
      />
      <QueueList
        onOpened={() => {
          // Came from the player: return to it showing the opened episode.
          if (router.canGoBack()) router.back();
          else router.replace('/now-playing' as Href);
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  clear: { color: theme.accent, fontWeight: '600', fontSize: 15 },
});
