import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { File } from 'expo-file-system';
import { Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  DEFAULT_API_URL,
  clearCaches,
  setApiUrl,
  setAppKey,
} from '@/src/db/storage';
import {
  getApiBaseUrl,
  getResolvedAppKey,
  healthCheck,
  hydrateApiBaseUrl,
  hydrateAppKey,
  isInsecureRemoteApiUrl,
  setApiBaseUrlOverride,
  setAppKeyOverride,
} from '@/src/api/backend';
import { importOpmlSubscriptions } from '@/src/import/importOpml';
import {
  clearPlaybackEventLog,
  getPlaybackEventLog,
  isIgnoringBatteryOptimizations,
  openAppDetailsSettings,
  requestIgnoreBatteryOptimizations,
} from '@/src/player/androidAuto';
import { clearAudioCache } from '@/src/api/audioUpload';
import { clearCachedRssXml } from '@/src/api/rss';
import { usePlayback } from '@/src/store/PlaybackContext';
import {
  getLastAutoQueueRefresh,
  refreshAutoQueueFeeds,
  type RefreshResult,
} from '@/src/queue/autoQueueRefresh';
import { isBackgroundRefreshEnabled, setBackgroundRefreshEnabled } from '@/src/queue/backgroundRefresh';
import { theme } from '@/constants/Colors';
import { font } from '@/constants/Typography';
import { Button, Divider, Group, Icon, Label, ToggleRow, type } from '@/components/ui';

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { setAutoSkip, autoSkip, clearCachedPlaybackData, episode, openedEpisode } = usePlayback();
  const [apiUrl, setApiUrlState] = useState(DEFAULT_API_URL);
  const [appKey, setAppKeyState] = useState('');
  const [saving, setSaving] = useState(false);
  const [health, setHealth] = useState<string | null>(null);
  const [cacheMsg, setCacheMsg] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const url = await hydrateApiBaseUrl();
        if (alive) setApiUrlState(url);
        const key = await hydrateAppKey();
        if (alive) setAppKeyState(key);
      } catch (e) {
        // Keep defaults; don't leave the form stuck unloaded.
        console.warn('[settings] Failed to load saved API settings:', e);
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const onToggleAutoSkip = useCallback(
    async (v: boolean) => {
      await setAutoSkip(v);
    },
    [setAutoSkip],
  );

  const onSaveApi = async () => {
    setSaving(true);
    setHealth(null);
    try {
      const cleaned = apiUrl.trim().replace(/\/$/, '') || DEFAULT_API_URL;
      await setApiUrl(cleaned);
      setApiBaseUrlOverride(cleaned);
      setApiUrlState(cleaned);
      const cleanedKey = appKey.trim();
      await setAppKey(cleanedKey);
      setAppKeyOverride(cleanedKey || null);
      setAppKeyState(getResolvedAppKey());
      try {
        const h = await healthCheck();
        setHealth(`OK · ${h.status}${h.mock_mode ? ' (mock)' : ''}`);
      } catch (e) {
        setHealth(e instanceof Error ? e.message : 'Unreachable');
      }
    } finally {
      setSaving(false);
    }
  };

  const onResetApi = async () => {
    await setApiUrl('');
    await setAppKey('');
    const url = await hydrateApiBaseUrl();
    setApiBaseUrlOverride(url);
    setApiUrlState(getApiBaseUrl());
    const key = await hydrateAppKey();
    setAppKeyOverride(null);
    setAppKeyState(key);
    setHealth(null);
  };

  const onImportOpml = async () => {
    if (importing) return;
    setImportStatus(null);
    try {
      const picked = await File.pickFileAsync({
        mimeTypes: [
          'text/xml',
          'application/xml',
          'text/x-opml',
          'application/octet-stream',
          '*/*',
        ],
      });
      if (picked.canceled || !picked.result) return;
      const file = picked.result;
      const name = (file.name || '').toLowerCase();
      const xml = await file.text();
      if (!xml.trim()) {
        setImportStatus('That file is empty.');
        return;
      }
      const looksLikeOpml = /<(opml|outline)\b/i.test(xml);
      const allowedName = !name || name.endsWith('.opml') || name.endsWith('.xml');
      if (!allowedName && !looksLikeOpml) {
        setImportStatus('Pick an .opml or .xml file.');
        return;
      }
      setImporting(true);
      const result = await importOpmlSubscriptions(xml, (done, total) => {
        setImportStatus(total > 0 ? `Importing ${done} / ${total}…` : 'Importing…');
      });
      if (result.total === 0) {
        setImportStatus('No podcast feeds found in that file.');
        return;
      }
      const artNote =
        result.artworkBackfilled > 0
          ? ` · filled ${result.artworkBackfilled} cover${result.artworkBackfilled === 1 ? '' : 's'}`
          : '';
      setImportStatus(
        `Imported ${result.imported} · skipped ${result.skipped} · failed ${result.failed}${artNote}`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Import failed';
      if (/cancel/i.test(msg)) return;
      setImportStatus(msg);
    } finally {
      setImporting(false);
    }
  };

  const onClearCache = () => {
    Alert.alert(
      'Clear on-device cache?',
      'Removes cached episode lists, skip maps, and downloaded audio from this device. Subscriptions, settings and play positions stay, and so does the download of the episode that is loaded (or still downloading). Episode lists refresh from RSS, and skip maps come back from the API when you play an episode.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            try {
              if (!clearCachedPlaybackData()) {
                setCacheMsg('Wait for the current analysis to finish, then clear the cache.');
                return;
              }
              clearCachedRssXml();
              // The player reopens its file on every seek (an ad skip is a seek).
              const keep = [episode, openedEpisode?.episode]
                .filter((ep): ep is NonNullable<typeof ep> => !!ep)
                .map((ep) => ({ episodeGuid: ep.guid, audioUrl: ep.enclosureUrl }));
              const files = await clearAudioCache(keep);
              const n = await clearCaches();
              setCacheMsg(
                `Cleared ${n} cached records and ${files} downloaded file${files === 1 ? '' : 's'}. Play positions were kept. Episode lists and skip maps come back when reopened.`,
              );
            } catch (error) {
              console.warn('[settings] Failed to clear cache:', error);
              setCacheMsg('Could not clear all cached data. Please try again.');
            }
          },
        },
      ],
    );
  };

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: 'Settings',
          headerStyle: { backgroundColor: theme.background },
          headerTintColor: theme.text,
          headerShadowVisible: false,
        }}
      />
      {!loaded ? (
        <ActivityIndicator color={theme.accent} style={{ marginTop: 32 }} />
      ) : (
        <ScrollView
          style={styles.flex}
          contentContainerStyle={{ paddingBottom: insets.bottom + 32, paddingHorizontal: 20, gap: 10 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled">
          <Label style={styles.first}>Ad skipping</Label>
          <Group>
            <ToggleRow
              label="Skip ads automatically"
              hint="Checks episodes for ads and skips them. Per-show choices are on each show's page. When off, you can still check a single episode by hand."
              value={autoSkip}
              onChange={(v) => void onToggleAutoSkip(v)}
            />
          </Group>

          <Label style={styles.section}>Server</Label>
          <Group style={styles.pad}>
            <Text style={styles.fieldLabel}>Address</Text>
            <TextInput
              style={styles.input}
              value={apiUrl}
              onChangeText={setApiUrlState}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder={DEFAULT_API_URL}
              placeholderTextColor={theme.textMuted}
              accessibilityLabel="Server address"
            />
            {isInsecureRemoteApiUrl(apiUrl) && (
              <Text style={styles.warning}>
                This server is reached over plain http, so your app key travels unencrypted across the internet. Use
                https:// for a server outside your home network.
              </Text>
            )}
            <Text style={[styles.fieldLabel, { marginTop: 12 }]}>App key</Text>
            <TextInput
              style={styles.input}
              value={appKey}
              onChangeText={setAppKeyState}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              placeholder="Optional"
              placeholderTextColor={theme.textMuted}
              accessibilityLabel="App key"
            />
            <Text style={styles.hint}>Must match the server's APP_KEY. Reset clears the saved address and key.</Text>
            <View style={styles.actions}>
              {saving ? (
                <ActivityIndicator color={theme.accent} style={{ width: 110, height: 40 }} />
              ) : (
                <Button kind="accent" label="Save and test" onPress={() => void onSaveApi()} style={styles.smallBtn} />
              )}
              <Button kind="secondary" label="Reset" onPress={() => void onResetApi()} style={styles.smallBtn} />
            </View>
            {!!health && (
              <Text style={[styles.status, { color: health.startsWith('OK') ? theme.success : theme.danger }]}>
                {health.startsWith('OK') ? `Connected · ${health.replace(/^OK · /, '')}` : health}
              </Text>
            )}
          </Group>

          <Label style={styles.section}>Library</Label>
          <Group>
            <BackgroundRefreshSettings />
            <Divider />
            <Pressable
              onPress={() => void onImportOpml()}
              disabled={importing}
              accessibilityRole="button"
              style={({ pressed }) => [styles.navRow, (pressed || importing) && { opacity: 0.6 }]}>
              <View style={styles.flex}>
                <Text style={type.rowTitle}>Import subscriptions (OPML)</Text>
                <Text style={type.rowHint}>
                  {importStatus ?? 'From an .opml or .xml export. Shows you already have are skipped.'}
                </Text>
              </View>
              {importing ? <ActivityIndicator color={theme.accent} size="small" /> : <Icon name="right" size={18} color={theme.textMuted} />}
            </Pressable>
          </Group>

          {Platform.OS === 'android' && <PlaybackDiagnostics />}

          <Label style={styles.section}>Storage</Label>
          <Group>
            <Pressable
              onPress={onClearCache}
              accessibilityRole="button"
              style={({ pressed }) => [styles.navRow, pressed && { opacity: 0.6 }]}>
              <View style={styles.flex}>
                <Text style={[type.rowTitle, { color: theme.danger }]}>Clear cache and downloads</Text>
                <Text style={type.rowHint}>
                  {cacheMsg ??
                    'Downloads and their saved skips are removed after 14 days anyway. The server keeps its results for up to 90 days.'}
                </Text>
              </View>
            </Pressable>
          </Group>
        </ScrollView>
      )}
    </View>
  );
}

function BackgroundRefreshSettings() {
  const [enabled, setEnabled] = useState(true);
  const [last, setLast] = useState<RefreshResult | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setEnabled(await isBackgroundRefreshEnabled());
    setLast(await getLastAutoQueueRefresh());
  }, []);

  useEffect(() => {
    void reload();
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') void reload();
    });
    return () => sub.remove();
  }, [reload]);

  const onToggle = async (v: boolean) => {
    setEnabled(v);
    await setBackgroundRefreshEnabled(v);
  };

  const onRefreshNow = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      await refreshAutoQueueFeeds(true);
      await reload();
    } catch (e) {
      console.warn('[settings] Refresh now failed:', e);
      setRefreshMsg(e instanceof Error ? `Refresh failed: ${e.message}` : 'Refresh failed. Please try again.');
    } finally {
      setRefreshing(false);
    }
  };

  const lastText = last
    ? `${new Date(last.at).toLocaleString()} (${last.source}) · ${last.shows} show${last.shows === 1 ? '' : 's'}, +${last.added} to the queue${last.failed ? `, ${last.failed} failed` : ''}`
    : 'Never';

  return (
    <>
      <ToggleRow
        label="Check for new episodes in the background"
        hint="About every 8 hours, for shows that add new episodes to the queue. Android picks the exact time. Nothing is played or checked for ads."
        value={enabled}
        onChange={(v) => void onToggle(v)}
      />
      <Divider />
      <Pressable
        onPress={() => void onRefreshNow()}
        disabled={refreshing}
        accessibilityRole="button"
        style={({ pressed }) => [styles.navRow, (pressed || refreshing) && { opacity: 0.6 }]}>
        <View style={styles.flex}>
          <Text style={type.rowTitle}>{refreshing ? 'Checking…' : 'Check now'}</Text>
          <Text style={type.rowHint}>{refreshMsg ?? `Last checked: ${lastText}`}</Text>
        </View>
        {refreshing && <ActivityIndicator color={theme.accent} size="small" />}
      </Pressable>
    </>
  );
}

function PlaybackDiagnostics() {
  const [unrestricted, setUnrestricted] = useState<boolean | null>(() =>
    isIgnoringBatteryOptimizations(),
  );
  const [log, setLog] = useState<string | null>(null);

  useEffect(() => {
    // Re-check after returning from the system battery dialog.
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') setUnrestricted(isIgnoringBatteryOptimizations());
    });
    return () => sub.remove();
  }, []);

  const showLog = () => setLog(getPlaybackEventLog() || '(no events yet)');
  const shareLog = async () => {
    const text = getPlaybackEventLog() || '(no events yet)';
    try {
      await Share.share({ title: 'Podcast AdSkip playback log', message: text });
    } catch {
      /* user cancelled */
    }
  };

  return (
    <>
      <Label style={styles.section}>Background playback</Label>
      <Group>
        <Pressable
          onPress={unrestricted === false ? requestIgnoreBatteryOptimizations : undefined}
          disabled={unrestricted !== false}
          accessibilityRole="button"
          style={({ pressed }) => [styles.navRow, pressed && { opacity: 0.6 }]}>
          <View style={styles.flex}>
            <Text style={type.rowTitle}>Allow background playback</Text>
            <Text style={type.rowHint}>
              {unrestricted == null
                ? 'Battery optimisation: unknown'
                : unrestricted
                  ? 'Battery optimisation is off for this app'
                  : 'Battery optimisation is on and may stop audio with the screen off. Tap to allow.'}
            </Text>
          </View>
          {unrestricted != null && (
            <Text style={[styles.state, { color: unrestricted ? theme.success : theme.danger }]}>
              {unrestricted ? 'Allowed' : 'Restricted'}
            </Text>
          )}
        </Pressable>
        <Divider />
        <Pressable
          onPress={openAppDetailsSettings}
          accessibilityRole="button"
          style={({ pressed }) => [styles.navRow, pressed && { opacity: 0.6 }]}>
          <View style={styles.flex}>
            <Text style={type.rowTitle}>Open app info</Text>
            <Text style={type.rowHint}>On OnePlus / OxygenOS also set Battery to Unrestricted there.</Text>
          </View>
          <Icon name="right" size={18} color={theme.textMuted} />
        </Pressable>
        <Divider />
        <View style={styles.navRow}>
          <Text style={[type.rowTitle, styles.flex]}>Playback log</Text>
          <Pressable onPress={showLog} hitSlop={8} accessibilityRole="button">
            <Text style={styles.logAction}>{log ? 'Refresh' : 'Show'}</Text>
          </Pressable>
          <Pressable onPress={() => void shareLog()} hitSlop={8} accessibilityRole="button">
            <Text style={styles.logAction}>Share</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              clearPlaybackEventLog();
              setLog(null);
            }}
            hitSlop={8}
            accessibilityRole="button">
            <Text style={styles.logAction}>Clear</Text>
          </Pressable>
        </View>
        {!!log && (
          <Text selectable style={styles.log}>
            {log.split('\n').reverse().join('\n')}
          </Text>
        )}
      </Group>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background },
  flex: { flex: 1, minWidth: 0 },
  first: { marginTop: 8 },
  section: { marginTop: 18 },
  pad: { paddingVertical: 14 },
  fieldLabel: { fontFamily: font.medium, fontSize: 13, color: theme.textSecondary, marginBottom: 6 },
  input: {
    backgroundColor: theme.background,
    borderRadius: 10,
    paddingHorizontal: 12,
    height: 44,
    fontFamily: font.mono,
    fontSize: 13.5,
    color: theme.text,
  },
  hint: { fontFamily: font.body, fontSize: 12.5, lineHeight: 17, color: theme.textMuted, marginTop: 8 },
  warning: { fontFamily: font.body, fontSize: 12.5, lineHeight: 17, color: theme.danger, marginTop: 8 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 },
  smallBtn: { minHeight: 40, paddingHorizontal: 16 },
  status: { fontFamily: font.medium, fontSize: 13, marginTop: 12 },
  navRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 13 },
  state: { fontFamily: font.medium, fontSize: 13 },
  logAction: { fontFamily: font.medium, fontSize: 13.5, color: theme.accent },
  log: { fontFamily: font.mono, fontSize: 11, lineHeight: 16, color: theme.textSecondary, paddingBottom: 14 },
});
