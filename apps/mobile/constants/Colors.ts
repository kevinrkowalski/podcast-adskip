/**
 * Editorial midnight palette: deep evergreen-charcoal, warm paper text, and
 * restrained brass accents. The app intentionally keeps the same palette in
 * both system color modes for a consistent listening experience.
 */

const accent = '#90663E';
const accentSoft = '#CBA978';
const tint = accentSoft;

const palette = {
  text: '#F2EEE5',
  textSecondary: '#B4B8AE',
  background: '#101714',
  surface: '#18211D',
  surfaceElevated: '#202B26',
  border: '#2B3932',
  tint,
  accent,
  accentSoft,
  tabIconDefault: '#7F8A82',
  tabIconSelected: tint,
  success: '#83B69A',
  danger: '#D9857A',
  adMark: 'rgba(203, 169, 120, 0.58)',
  progressTrack: '#2B3932',
  progressFill: '#CBA978',
};

export default {
  light: palette,
  dark: palette,
};

export const theme = {
  text: '#F2EEE5',
  textSecondary: '#B4B8AE',
  textMuted: '#7F8A82',
  background: '#101714',
  surface: '#18211D',
  surfaceElevated: '#202B26',
  border: '#2B3932',
  accent,
  accentSoft,
  accentWarn: '#E2BA7C',
  success: '#83B69A',
  danger: '#D9857A',
  adMark: 'rgba(203, 169, 120, 0.58)',
  progressTrack: '#2B3932',
  progressFill: '#CBA978',
  miniBar: '#151E1A',
  tabBar: '#131B17',
};
