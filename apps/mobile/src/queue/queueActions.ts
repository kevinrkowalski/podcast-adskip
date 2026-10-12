import { Alert, type AlertButton } from 'react-native';
import type { Episode } from '@/src/types';
import { addToQueue, getQueue, playNext, removeFromQueue } from './queueStore';

/**
 * Up Next actions for one episode as a native action dialog (Android shows up
 * to three buttons; tapping outside dismisses).
 */
export function showQueueActions(
  ep: Episode,
  opts?: { isCurrent?: boolean; onOpenQueue?: () => void },
) {
  const queued = getQueue().some((e) => e.guid === ep.guid);
  const buttons: AlertButton[] = [];
  if (opts?.onOpenQueue) {
    buttons.push({ text: `Up Next (${getQueue().length})`, onPress: opts.onOpenQueue });
  }
  if (!opts?.isCurrent) {
    if (queued) {
      buttons.push({ text: 'Remove from Up Next', style: 'destructive', onPress: () => void removeFromQueue(ep.guid) });
      if (buttons.length < 2) buttons.push({ text: 'Play next', onPress: () => void playNext(ep) });
    } else {
      buttons.push({ text: 'Play next', onPress: () => void playNext(ep) });
      buttons.push({ text: 'Add to Up Next', onPress: () => void addToQueue(ep) });
    }
  }
  if (buttons.length < 3) buttons.push({ text: 'Cancel', style: 'cancel' });
  Alert.alert(
    ep.title,
    opts?.isCurrent ? 'Now playing' : queued ? 'In Up Next' : undefined,
    buttons,
    { cancelable: true },
  );
}
