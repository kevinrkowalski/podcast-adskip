import { useFonts } from 'expo-font';
import { SchibstedGrotesk_600SemiBold, SchibstedGrotesk_700Bold } from '@expo-google-fonts/schibsted-grotesk';
import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold } from '@expo-google-fonts/inter';
import { JetBrainsMono_400Regular, JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono';
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import 'react-native-reanimated';

// Defines the background feed-refresh task at module scope (needed for headless runs).
import '@/src/queue/backgroundRefresh';
import { PlaybackProvider } from '@/src/store/PlaybackContext';
import { OverlayHost } from '@/components/OverlayHost';
import { EpisodeSheetHost } from '@/components/EpisodeSheet';
import { hydrateApiBaseUrl, hydrateAppKey } from '@/src/api/backend';
import { pruneExpiredAudioCache } from '@/src/api/audioUpload';
import { theme } from '@/constants/Colors';
import { displayFontFamily } from '@/constants/Typography';

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
    SchibstedGrotesk_600SemiBold,
    SchibstedGrotesk_700Bold,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
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
              headerTitleStyle: { fontFamily: displayFontFamily, fontSize: 18 },
              headerShadowVisible: false,
            }}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="podcast/[id]" options={{ title: 'Podcast' }} />
            <Stack.Screen
              name="now-playing"
              options={{ headerShown: false, animation: 'slide_from_bottom' }}
            />
            <Stack.Screen name="settings" options={{ title: 'Settings' }} />
          </Stack>
          <OverlayHost />
          <EpisodeSheetHost />
        </PlaybackProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
