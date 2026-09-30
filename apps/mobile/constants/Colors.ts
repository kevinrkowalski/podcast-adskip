/** Pocket Casts–inspired dark palette. App forces dark UI. */

const accent = '#F43E5C'; // warm rose / Pocket-like accent
const accentSoft = '#FF6B81';
const tint = accent;

export default {
  light: {
    text: '#F5F5F7',
    textSecondary: '#A1A1AA',
    background: '#0B0B0F',
    surface: '#16161C',
    surfaceElevated: '#1E1E26',
    border: '#2A2A33',
    tint,
    accent,
    accentSoft,
    tabIconDefault: '#6B6B76',
    tabIconSelected: tint,
    success: '#30D158',
    danger: '#FF453A',
    adMark: 'rgba(244, 62, 92, 0.55)',
    progressTrack: '#2A2A33',
    progressFill: accent,
  },
  dark: {
    text: '#F5F5F7',
    textSecondary: '#A1A1AA',
    background: '#0B0B0F',
    surface: '#16161C',
    surfaceElevated: '#1E1E26',
    border: '#2A2A33',
    tint,
    accent,
    accentSoft,
    tabIconDefault: '#6B6B76',
    tabIconSelected: tint,
    success: '#30D158',
    danger: '#FF453A',
    adMark: 'rgba(244, 62, 92, 0.55)',
    progressTrack: '#2A2A33',
    progressFill: accent,
  },
};

export const theme = {
  text: '#F5F5F7',
  textSecondary: '#A1A1AA',
  textMuted: '#6B6B76',
  background: '#0B0B0F',
  surface: '#16161C',
  surfaceElevated: '#1E1E26',
  border: '#2A2A33',
  accent: '#F43E5C',
  accentSoft: '#FF6B81',
  accentWarn: '#FFC107',
  success: '#30D158',
  danger: '#FF453A',
  adMark: 'rgba(244, 62, 92, 0.55)',
  progressTrack: '#2A2A33',
  progressFill: '#F43E5C',
  miniBar: '#141418',
  tabBar: '#0F0F14',
};
