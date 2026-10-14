/**
 * Background feed refresh for auto-add shows (expo-background-task / WorkManager).
 * The task is defined at module scope (imported from the root layout) so it is
 * available when Android wakes the app headless. It only fetches RSS and appends
 * to Up Next: it never starts playback or analysis.
 */
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { logPlaybackEvent } from '@/src/player/androidAuto';
import { refreshAutoQueueFeeds } from './autoQueueRefresh';

export const BACKGROUND_REFRESH_TASK = 'podcast-adskip-feed-refresh';
const ENABLED_KEY = '@podcast-adskip/backgroundRefresh';
/** WorkManager treats this as a minimum; the OS picks the real time. */
const MIN_INTERVAL_MINUTES = 8 * 60; // every ~8 hours (feeds also refresh on app open)
/** Interval the job was last registered with, so a changed interval re-registers. */
const INTERVAL_KEY = '@podcast-adskip/backgroundRefreshInterval';

export async function isBackgroundRefreshEnabled(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(ENABLED_KEY)) !== 'false'; // default ON
  } catch {
    return true;
  }
}

if (!TaskManager.isTaskDefined(BACKGROUND_REFRESH_TASK)) {
  TaskManager.defineTask(BACKGROUND_REFRESH_TASK, async () => {
    try {
      if (!(await isBackgroundRefreshEnabled())) return BackgroundTask.BackgroundTaskResult.Success;
      const r = await refreshAutoQueueFeeds(true, 'background');
      const msg = r
        ? `bg-refresh: ${r.shows} show(s), +${r.added} to queue${r.failed ? `, ${r.failed} failed` : ''}`
        : 'bg-refresh: skipped (already running)';
      logPlaybackEvent(msg);
      console.log('[bg-refresh]', msg);
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch (e) {
      logPlaybackEvent(`bg-refresh: failed ${e instanceof Error ? e.message : String(e)}`);
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

/** Register or unregister the WorkManager job to match the setting (idempotent). */
export async function syncBackgroundRefreshRegistration(): Promise<void> {
  try {
    const enabled = await isBackgroundRefreshEnabled();
    let registered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_REFRESH_TASK);
    if (enabled && registered) {
      const stored = await AsyncStorage.getItem(INTERVAL_KEY);
      if (stored !== String(MIN_INTERVAL_MINUTES)) {
        // Registered by an older build with a different interval: re-register.
        await BackgroundTask.unregisterTaskAsync(BACKGROUND_REFRESH_TASK);
        registered = false;
        logPlaybackEvent(`bg-refresh: interval changed (${stored ?? 'unknown'} -> ${MIN_INTERVAL_MINUTES} min)`);
      }
    }
    if (enabled && !registered) {
      const status = await BackgroundTask.getStatusAsync();
      if (status !== BackgroundTask.BackgroundTaskStatus.Available) {
        console.warn('[bg-refresh] background tasks unavailable:', status);
        return;
      }
      await BackgroundTask.registerTaskAsync(BACKGROUND_REFRESH_TASK, {
        minimumInterval: MIN_INTERVAL_MINUTES,
      });
      await AsyncStorage.setItem(INTERVAL_KEY, String(MIN_INTERVAL_MINUTES));
      logPlaybackEvent(`bg-refresh: scheduled (min ${MIN_INTERVAL_MINUTES} min)`);
    } else if (!enabled && registered) {
      await BackgroundTask.unregisterTaskAsync(BACKGROUND_REFRESH_TASK);
      await AsyncStorage.removeItem(INTERVAL_KEY);
      logPlaybackEvent('bg-refresh: unscheduled');
    }
  } catch (e) {
    console.warn('[bg-refresh] registration failed:', e);
  }
}

export async function setBackgroundRefreshEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(ENABLED_KEY, enabled ? 'true' : 'false');
  await syncBackgroundRefreshRegistration();
}
