import { useFonts } from 'expo-font';
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import 'react-native-reanimated';

import { PlaybackProvider } from '@/src/store/PlaybackContext';
import { hydrateApiBaseUrl, hydrateAppKey } from '@/src/api/backend';
import { pruneExpiredAudioCache } from '@/src/api/audioUpload';
import { theme } from '@/constants/Colors';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

SplashScreen.preventAutoHideAsync();

const AppDarkTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: theme.accent,
    background: theme.background,
    card: theme.surface,
    text: theme.text,
    border: theme.border,
    notification: theme.accent,
  },
};

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
  });

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) SplashScreen.hideAsync();
  }, [loaded]);

  useEffect(() => {
    hydrateApiBaseUrl().catch(() => {
      /* ignore — fallback URL still works */
    });
    hydrateAppKey().catch(() => {
      /* ignore — auth key may be entered in Settings */
    });
  }, []);

  useEffect(() => {
    void pruneExpiredAudioCache();
  }, []);

  // Keep the navigator mounted from the first render. The splash screen
  // remains visible until fonts are ready, but returning null here can leave
  // Expo Router without a mounted root navigator during startup.
  return <RootLayoutNav />;
}

function RootLayoutNav() {
  return (
    <SafeAreaProvider>
      <ThemeProvider value={AppDarkTheme}>
        <StatusBar style="light" />
        <PlaybackProvider>
          <Stack
            screenOptions={{
              contentStyle: { backgroundColor: theme.background },
              headerStyle: { backgroundColor: theme.background },
              headerTintColor: theme.text,
              headerShadowVisible: false,
            }}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="podcast/[id]" options={{ title: 'Podcast' }} />
            <Stack.Screen
              name="now-playing"
              options={{ headerShown: false, animation: 'slide_from_right' }}
            />
            <Stack.Screen name="settings" options={{ title: 'Settings' }} />
          </Stack>
        </PlaybackProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
