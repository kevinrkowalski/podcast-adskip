/**
 * Player tab renders the full Now Playing UI in-place.
 *
 * Do NOT Redirect to `/now-playing` from this screen: focusing the tab mounts
 * the Redirect, Back returns here, Redirect fires again → loop / crash.
 * MiniPlayer and show-play still push the root `/now-playing` stack screen so
 * Back returns to the show listings. This tab is for discoverability when the
 * user picks Player from the bottom nav (no cross-navigator Redirect).
 */
export { default } from '../now-playing';
