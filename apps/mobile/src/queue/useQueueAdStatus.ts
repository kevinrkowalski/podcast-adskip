import { useEffect, useState } from 'react';
import { getCachedSkipMap } from '@/src/db/storage';
import { skippableSegments } from '@/src/player/adSkipLine';
import type { Episode } from '@/src/types';
import { getQueueAnalysisBusyGuids, subscribeQueueAnalysis } from './queueAnalyzer';

/** What the queue knows about an episode's ads before it plays. */
export type QueueAdStatus = { kind: 'ready'; count: number } | { kind: 'checking' };

/**
 * Ad status for queued episodes: how many segments a saved analysis found, or that the
 * background analyzer is working on it. Episodes with neither are left out.
 */
export function useQueueAdStatus(episodes: Episode[]): Record<string, QueueAdStatus> {
  const key = episodes.map((e) => e.guid).join('|');
  const [status, setStatus] = useState<Record<string, QueueAdStatus>>({});

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      const busy = new Set(getQueueAnalysisBusyGuids());
      const next: Record<string, QueueAdStatus> = {};
      for (const ep of episodes) {
        try {
          const map = await getCachedSkipMap(ep.guid, ep.enclosureUrl);
          if (map?.status === 'ready') {
            next[ep.guid] = { kind: 'ready', count: skippableSegments(map.segments ?? [], null).length };
            continue;
          }
        } catch {
          // No saved map: fall through.
        }
        if (busy.has(ep.guid)) next[ep.guid] = { kind: 'checking' };
      }
      if (!cancelled) setStatus(next);
    };
    void read();
    const unsubscribe = subscribeQueueAnalysis(() => void read());
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // Keyed by the queue's guids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return status;
}
