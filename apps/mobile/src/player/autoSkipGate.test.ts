import { resolveAdDetectionEnabled, sheetSwitchState } from './autoSkipGate';

describe('auto-skip gate', () => {
  it('is off when global auto-skip is off', () => {
    expect(resolveAdDetectionEnabled({ globalAutoSkip: false, podcastEnabled: true, hasReadyMapForEpisode: true })).toBe(false);
  });
  it('is on when the show has detection enabled', () => {
    expect(resolveAdDetectionEnabled({ globalAutoSkip: true, podcastEnabled: true, hasReadyMapForEpisode: false })).toBe(true);
  });
  it('stays on for a manually prepared episode when per-show detection is off', () => {
    expect(resolveAdDetectionEnabled({ globalAutoSkip: true, podcastEnabled: false, hasReadyMapForEpisode: true })).toBe(true);
  });
  it('is off with per-show off and no prepared map', () => {
    expect(resolveAdDetectionEnabled({ globalAutoSkip: true, podcastEnabled: false, hasReadyMapForEpisode: false })).toBe(false);
  });
  it('off -> on round trip for a prepared episode turns the switch back on', () => {
    const base = { podcastEnabled: false, hasReadyMapForEpisode: true };
    const off = resolveAdDetectionEnabled({ ...base, globalAutoSkip: false });
    expect(sheetSwitchState(false, off).value).toBe(false);
    const on = resolveAdDetectionEnabled({ ...base, globalAutoSkip: true });
    expect(sheetSwitchState(true, on).value).toBe(true);
  });
  it('switch is never disabled (old stuck state: autoSkip on, detection off)', () => {
    expect(sheetSwitchState(true, false)).toEqual({ value: false, disabled: false });
  });
});
