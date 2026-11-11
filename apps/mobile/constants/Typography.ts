/**
 * Bundled faces (loaded in app/_layout.tsx). Custom fonts carry their weight in the
 * family name, so styles pick a family here and never set fontWeight.
 */
export const font = {
  /** Titles and headings. */
  display: 'SchibstedGrotesk_700Bold',
  displaySemi: 'SchibstedGrotesk_600SemiBold',
  /** Running text. */
  body: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semi: 'Inter_600SemiBold',
  /** Times and other figures that should line up. */
  mono: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',
} as const;

/** Kept for older call sites. */
export const displayFontFamily = font.displaySemi;
export const monoFontFamily = font.mono;
