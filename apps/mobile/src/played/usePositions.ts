import { useCallback, useEffect, useState } from 'react';
import { getPlaybackPositions, type PlaybackPosition } from '@/src/db/storage';

/** Saved resume positions for a set of guids; `refresh` re-reads them. */
export function usePositions(guids: string[]) {
  const key = guids.join('|');
  const [positions, setPositions] = useState<Record<string, PlaybackPosition>>({});
  const refresh = useCallback(async () => {
    const list = key ? key.split('|') : [];
    if (!list.length) {
      setPositions({});
      return;
    }
    setPositions(await getPlaybackPositions(list));
  }, [key]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { positions, refresh };
}
