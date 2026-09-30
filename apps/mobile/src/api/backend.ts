import type { SkipMap } from '@/src/types';
import Constants from 'expo-constants';
import { DEFAULT_API_URL, getApiUrl, getAppKey } from '@/src/db/storage';

/**
 * Backend base URL.
 * Priority: in-memory override (Settings) → AsyncStorage → EXPO_PUBLIC_API_URL /
 * DEFAULT_API_URL (192.168.0.124:8000) → Expo hostUri:8000 → 10.0.2.2:8000.
 */
let overrideBaseUrl: string | null = null;
let hydrated = false;

/**
 * App Key for X-App-Key header.
 * Priority: in-memory override → AsyncStorage (via hydrate) → EXPO_PUBLIC_APP_KEY → empty.
 */
let overrideAppKey: string | null = null;

function fallbackResolve(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  if (DEFAULT_API_URL) return DEFAULT_API_URL;
  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri) {
    const host = hostUri.split(':')[0];
    if (host && host !== 'localhost' && host !== '127.0.0.1') {
      return `http://${host}:8000`;
    }
  }
  return 'http://10.0.2.2:8000';
}

function envAppKey(): string {
  return (process.env.EXPO_PUBLIC_APP_KEY ?? '').trim();
}

/** Hydrate override from AsyncStorage once (call early from Settings / app start). */
export async function hydrateApiBaseUrl(): Promise<string> {
  const stored = await getApiUrl();
  overrideBaseUrl = stored;
  hydrated = true;
  return stored;
}

export function setApiBaseUrlOverride(url: string | null): void {
  overrideBaseUrl = url ? url.replace(/\/$/, '') : null;
  hydrated = true;
}

function resolveBaseUrl(): string {
  if (overrideBaseUrl) return overrideBaseUrl;
  if (!hydrated) return fallbackResolve();
  return fallbackResolve();
}

/** Hydrate App Key from AsyncStorage (call early from Settings / app start). */
export async function hydrateAppKey(): Promise<string> {
  const stored = await getAppKey();
  overrideAppKey = stored.trim() ? stored.trim() : null;
  return resolveAppKey();
}

export function setAppKeyOverride(key: string | null): void {
  const cleaned = key != null ? key.trim() : '';
  overrideAppKey = cleaned ? cleaned : null;
}

function resolveAppKey(): string {
  if (overrideAppKey) return overrideAppKey;
  return envAppKey();
}

export function getResolvedAppKey(): string {
  return resolveAppKey();
}

function headers(): HeadersInit {
  const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  const key = resolveAppKey();
  if (key) h['X-App-Key'] = key;
  return h;
}

export function getApiBaseUrl(): string {
  return resolveBaseUrl();
}

export async function healthCheck(): Promise<{ status: string; mock_mode: boolean }> {
  const res = await fetch(`${resolveBaseUrl()}/v1/health`);
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return res.json();
}

export async function getSkipMap(episodeGuid: string): Promise<SkipMap> {
  const res = await fetch(`${resolveBaseUrl()}/v1/skip-map/${encodeURIComponent(episodeGuid)}`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`skip-map failed: ${res.status}`);
  return res.json();
}

export async function analyzeEpisode(input: {
  episode_guid: string;
  audio_url: string;
  title?: string;
  duration_ms?: number;
  feed_url?: string;
  force?: boolean;
  sync?: boolean;
}): Promise<SkipMap> {
  const qs = input.sync ? '?sync=true' : '';
  const { sync: _s, ...body } = input;
  const res = await fetch(`${resolveBaseUrl()}/v1/analyze-episode${qs}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`analyze failed: ${res.status}`);
  return res.json();
}
