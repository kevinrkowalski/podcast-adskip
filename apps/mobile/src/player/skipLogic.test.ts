/// <reference types="jest" />

import {
  filterSkippableSegments,
  mapLegacySegmentType,
  segmentTypeLabel,
} from './skipLogic';
import type { AdSegment } from '@/src/types';

const skipAll = {
  skipAdvertisement: true,
  skipIntroOutro: true,
  skipSelfPromotion: true,
};

function segment(
  type: string,
  start_ms: number,
  end_ms: number,
  confidence: number,
): AdSegment {
  return { type, start_ms, end_ms, confidence };
}

describe('skip-map classification and auto-skip safety', () => {
  it('preserves intro/outro and never promotes unknown types to advertisements', () => {
    expect(mapLegacySegmentType('intro_outro')).toBe('intro_outro');
    expect(mapLegacySegmentType('unknown')).toBe('unknown');
    expect(mapLegacySegmentType('unexpected')).toBe('unknown');
    expect(segmentTypeLabel('intro_outro')).toBe('Intro/outro');
    expect(
      filterSkippableSegments(
        [segment('unknown', 1_000, 20_000, 0.99), segment('unexpected', 2_000, 20_000, 0.99)],
        skipAll,
      ),
    ).toHaveLength(0);
  });

  it('requires stronger confidence for brief segments without rejecting them outright', () => {
    const segments = [
      segment('sponsor', 0, 9_999, 0.89),
      segment('sponsor', 10_000, 19_999, 0.9),
      segment('sponsor', 20_000, 29_999, 0.74),
      segment('sponsor', 30_000, 40_000, 0.8),
    ];

    expect(filterSkippableSegments(segments, skipAll)).toEqual([segments[1], segments[3]]);
  });

  it('uses per-type skip preferences after applying the quality gate', () => {
    const intro = segment('intro_outro', 0, 20_000, 0.95);
    const ad = segment('sponsor', 30_000, 50_000, 0.95);
    expect(
      filterSkippableSegments([intro, ad], {
        skipAdvertisement: true,
        skipIntroOutro: false,
        skipSelfPromotion: false,
      }),
    ).toEqual([ad]);
  });
});
