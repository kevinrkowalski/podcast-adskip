import { Link, Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { type } from '@/components/ui';
import { theme } from '@/constants/Colors';

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Not found' }} />
      <View style={styles.container}>
        <Text style={type.heading}>This screen doesn't exist.</Text>
        <Link href="/" style={styles.link}>
          <Text style={type.link}>Go to Listen</Text>
        </Link>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20, backgroundColor: theme.background },
  link: { marginTop: 15, paddingVertical: 15 },
});
