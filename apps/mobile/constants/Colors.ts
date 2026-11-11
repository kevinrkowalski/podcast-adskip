/**
 * Quiet dark palette: near-black with a slight green bias, warm paper text and one
 * soft brass accent. Amber is reserved for ad segments. The app keeps the same palette
 * in both system colour modes.
 */

const accent = '#D9B27C';

export const theme = {
  text: '#F3F1EC',
  textSecondary: '#A9AFAA',
  textMuted: '#737B76',
  background: '#0E1211',
  surface: '#161C1A',
  surfaceElevated: '#1F2725',
  /** Solid hairline / control-track colour. */
  border: '#262E2B',
  accent,
  /** Text and icons drawn on top of `accent`. */
  accentInk: '#1A1408',
  accentSoft: accent,
  accentWarn: '#E7A64B',
  /** Ad segments (scrubber marks, status dots, segment pills). */
  ad: '#E7A64B',
  adSoft: 'rgba(231, 166, 75, 0.16)',
  success: '#8CC3A4',
  danger: '#E08C80',
  adMark: '#E7A64B',
  progressTrack: 'rgba(255, 255, 255, 0.14)',
  progressFill: '#F3F1EC',
  miniBar: '#1F2725',
  tabBar: '#161C1A',
  scrim: 'rgba(0, 0, 0, 0.62)',
};

const palette = {
  ...theme,
  tint: accent,
  tabIconDefault: theme.textMuted,
  tabIconSelected: theme.text,
};

export default {
  light: palette,
  dark: palette,
};
