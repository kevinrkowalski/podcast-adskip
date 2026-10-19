/// <reference types="jest" />
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import { isNearEnd } from './playedStore';

describe('isNearEnd (auto-mark played)', () => {
  it('marks a long episode played at 95%, where the resume position is cleared', () => {
    const threeHours = 3 * 60 * 60_000;
    // 8 minutes left: not within 45s, but past 95%.
    expect(isNearEnd(threeHours - 8 * 60_000, threeHours)).toBe(true);
    expect(isNearEnd(threeHours * 0.9, threeHours)).toBe(false);
  });

  it('still marks played within 45s of the end', () => {
    const tenMin = 10 * 60_000;
    expect(isNearEnd(tenMin - 40_000, tenMin)).toBe(true);
    expect(isNearEnd(tenMin - 60_000, tenMin)).toBe(false);
  });

  it('ignores very short or unknown durations', () => {
    expect(isNearEnd(59_000, 60_000)).toBe(false);
    expect(isNearEnd(0, 3_600_000)).toBe(false);
  });
});
