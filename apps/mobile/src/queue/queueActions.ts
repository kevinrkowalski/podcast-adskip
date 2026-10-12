import type { Episode } from '@/src/types';
import { isPlayed } from '@/src/played/playedStore';
import { showActionSheet, type SheetAction } from '@/src/ui/overlayBus';
import { addToQueue, getCurrentQueueGuid, getQueue, playNext, removeFromQueue } from './queueStore';
import { upNextCount } from './queueLogic';

/**
 * Episode actions (Up Next, played state, report) in the app's action sheet.
 * Used by episode rows (⋯), Up Next rows and the player.
 */
export function showQueueActions(
  ep: Episode,
  opts?: {
    isCurrent?: boolean;
    onOpenQueue?: () => void;
    onSetPlayed?: (ep: Episode, played: boolean) => void;
    onReportSkip?: () => void;
  },
) {
  const queued = getQueue().some((e) => e.guid === ep.guid);
  const actions: SheetAction[] = [];
  if (opts?.onOpenQueue) {
    actions.push({
      label: `Open Up Next (${upNextCount(getQueue(), getCurrentQueueGuid())})`,
      onPress: opts.onOpenQueue,
    });
  }
  if (!opts?.isCurrent) {
    actions.push({ label: 'Play next', onPress: () => void playNext(ep) });
    if (!queued) actions.push({ label: 'Add to Up Next', onPress: () => void addToQueue(ep) });
  }
  if (opts?.onSetPlayed) {
    const played = isPlayed(ep.guid);
    actions.push({
      label: played ? 'Mark as unplayed' : 'Mark as played',
      onPress: () => opts.onSetPlayed?.(ep, !played),
    });
  }
  if (opts?.onReportSkip) actions.push({ label: 'Report bad skip', onPress: opts.onReportSkip });
  if (queued && !opts?.isCurrent) {
    actions.push({ label: 'Remove from Up Next', destructive: true, onPress: () => void removeFromQueue(ep.guid) });
  }
  const status = [
    opts?.isCurrent ? 'Now playing' : queued ? 'In Up Next' : null,
    isPlayed(ep.guid) ? 'Played' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  showActionSheet({ title: ep.title, message: status || undefined, actions });
}
