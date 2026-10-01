import { Redirect } from 'expo-router';

/**
 * Player lives on the root stack (`/player`) so Back from an episode
 * returns to the show listings (`/podcast/[id]`) instead of Library.
 * The tab remains for discoverability and forwards here.
 */
export default function PlayerTabRedirect() {
  return <Redirect href="/player" />;
}
