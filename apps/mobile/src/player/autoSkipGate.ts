/**
 * Whether ad detection (and therefore auto-skip) is active for the current episode.
 *
 * Global Ad-skip must be on. Then either the show has ad detection enabled, or
 * this episode already has a ready skip map (e.g. from a manual Prepare on a
 * show whose auto-detection is off). Without the ready-map branch, turning the
 * sheet's Auto-skip switch off and back on for a manually prepared episode left
 * it stuck off, because turning it on re-checked only the per-show setting.
 */
export function resolveAdDetectionEnabled(opts: {
  globalAutoSkip: boolean;
  podcastEnabled: boolean;
  hasReadyMapForEpisode: boolean;
}): boolean {
  if (!opts.globalAutoSkip) return false;
  return opts.podcastEnabled || opts.hasReadyMapForEpisode;
}

/** Sheet switch state: on only when both global auto-skip and detection are on. */
export function sheetSwitchState(autoSkip: boolean, adDetectionEnabled: boolean) {
  return {
    value: autoSkip && adDetectionEnabled,
    // Never lock the switch: the user must always be able to flip it.
    disabled: false,
  };
}
