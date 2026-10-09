import { Platform } from 'react-native';

/** Native serif faces give display copy an editorial character without bundling fonts. */
export const displayFontFamily = Platform.select({
  ios: 'Georgia',
  android: 'serif',
  web: 'Georgia, serif',
  default: 'serif',
});

/** Bundled mono face reserved for compact playback data and timestamps. */
export const monoFontFamily = 'SpaceMono';
