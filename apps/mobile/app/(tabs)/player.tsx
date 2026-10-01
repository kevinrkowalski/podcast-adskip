import { Redirect } from 'expo-router';

/**
 * Full Now Playing lives on the root stack at `/now-playing` (not `/player`).
 *
 * Expo Router route groups are not URL segments, so `app/(tabs)/player.tsx` and
 * a root `app/player.tsx` would BOTH map to `/player`. Navigating to `/player`
 * from inside tabs then stays on this tab screen; a Redirect to `/player` would
 * loop forever and crash. `/now-playing` is unambiguous and keeps Back -> show
 * listings (`podcast/[id]` -> now-playing) working.
 */
export default function PlayerTabRedirect() {
  return <Redirect href="/now-playing" />;
}
