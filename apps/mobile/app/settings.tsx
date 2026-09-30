import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
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
  setApiBaseUrlOverride,
  setAppKeyOverride,
} from '@/src/api/backend';
import { importOpmlSubscriptions } from '@/src/import/importOpml';
import { usePlayback } from '@/src/store/PlaybackContext';
import { theme } from '@/constants/Colors';

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { setAutoSkip, autoSkip } = usePlayback();
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
      const url = await hydrateApiBaseUrl();
      const key = await hydrateAppKey();
      if (!alive) return;
      setApiUrlState(url);
      setAppKeyState(key);
      setLoaded(true);
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
      'Clear cache?',
      'Removes cached episode lists and skip maps. Subscriptions and settings stay.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            const n = await clearCaches();
            setCacheMsg(`Cleared ${n} cached item${n === 1 ? '' : 's'}`);
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
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          keyboardShouldPersistTaps="handled">
          <Text style={styles.section}>Backend</Text>
          <Text style={styles.label}>API URL</Text>
          <TextInput
            style={styles.input}
            value={apiUrl}
            onChangeText={setApiUrlState}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder={DEFAULT_API_URL}
            placeholderTextColor={theme.textMuted}
          />
          <Text style={styles.hint}>
            Default: EXPO_PUBLIC_API_URL or {DEFAULT_API_URL}. Physical devices need your LAN IP.
          </Text>
          <Text style={[styles.label, { marginTop: 14 }]}>App Key</Text>
          <TextInput
            style={styles.input}
            value={appKey}
            onChangeText={setAppKeyState}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            placeholder="X-App-Key (optional)"
            placeholderTextColor={theme.textMuted}
          />
          <Text style={styles.hint}>
            Must match API APP_KEY. Overrides EXPO_PUBLIC_APP_KEY when set. Reset clears the stored key.
          </Text>
          <View style={styles.rowActions}>
            <Pressable style={styles.btn} onPress={onSaveApi} disabled={saving}>
              {saving ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.btnText}>Save & ping</Text>
              )}
            </Pressable>
            <Pressable style={styles.btnSecondary} onPress={onResetApi}>
              <Text style={styles.btnSecondaryText}>Reset default</Text>
            </Pressable>
          </View>
          {!!health && <Text style={styles.health}>{health}</Text>}

          <Text style={[styles.section, { marginTop: 28 }]}>Ad detection</Text>
          <View style={styles.switchRow}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.switchLabel}>Ad detection & auto-skip</Text>
              <Text style={styles.hint}>Analyze episodes for ads and automatically skip detected segments. Off means no ad-detection API calls.</Text>
            </View>
            <Switch
              value={autoSkip}
              onValueChange={onToggleAutoSkip}
              trackColor={{ false: theme.border, true: theme.accentSoft }}
              thumbColor={autoSkip ? theme.accent : '#ccc'}
            />
          </View>

          <Text style={[styles.section, { marginTop: 28 }]}>Storage</Text>
          <Pressable style={styles.btnDanger} onPress={onClearCache}>
            <Text style={styles.btnText}>Clear episode & skip-map cache</Text>
          </Pressable>
          {!!cacheMsg && <Text style={styles.health}>{cacheMsg}</Text>}

          <Text style={[styles.section, { marginTop: 28 }]}>Library</Text>
          <Pressable
            style={[styles.btn, importing && styles.btnDisabled]}
            onPress={() => void onImportOpml()}
            disabled={importing}>
            {importing ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.btnText}>Import OPML</Text>
            )}
          </Pressable>
          <Text style={styles.hint}>
            Add shows from an .opml or .xml export. Existing subscriptions stay; duplicates are skipped.
          </Text>
          {!!importStatus && <Text style={styles.health}>{importStatus}</Text>}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.background,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  section: {
    color: theme.text,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
  },
  label: {
    color: theme.textSecondary,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
  },
  input: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    color: theme.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  hint: {
    color: theme.textMuted,
    fontSize: 12,
    marginTop: 6,
    lineHeight: 16,
  },
  rowActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  btn: {
    backgroundColor: theme.accent,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    minWidth: 120,
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
  btnDisabled: { opacity: 0.55 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  btnSecondary: {
    backgroundColor: theme.surfaceElevated,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
  },
  btnSecondaryText: { color: theme.textSecondary, fontWeight: '600', fontSize: 14 },
  btnDanger: {
    backgroundColor: theme.surfaceElevated,
    borderWidth: 1,
    borderColor: theme.danger,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: theme.surface,
    borderRadius: 14,
    padding: 14,
  },
  switchLabel: {
    color: theme.text,
    fontSize: 16,
    fontWeight: '600',
  },
  health: {
    color: theme.textSecondary,
    fontSize: 13,
    marginTop: 10,
  },
});
