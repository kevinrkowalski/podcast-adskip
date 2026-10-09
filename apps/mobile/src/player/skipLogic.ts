import type { AdSegment, AdSegmentType, LegacyAdSegmentType } from '@/src/types';

export type NormalizedAdSegmentType = AdSegmentType | 'unknown';

/** Map known legacy segment types; unknown values must never become advertisements. */
export function mapLegacySegmentType(type: AdSegmentType | LegacyAdSegmentType | string): NormalizedAdSegmentType {
  const legacyMap: Record<string, NormalizedAdSegmentType> = {
    sponsor: 'advertisement',
    midroll: 'advertisement',
    preroll: 'advertisement',
    postroll: 'advertisement',
    crosspromo: 'self_promotion',
    network: 'self_promotion',
    intro_outro: 'intro_outro',
    unknown: 'unknown',
  };
  
  // If already a new type, return as-is
  if (type === 'advertisement' || type === 'intro_outro' || type === 'self_promotion') {
    return type as AdSegmentType;
  }
  
  return legacyMap[type] || 'unknown';
}

/** Normalize segment to use new type system. */
export function normalizeSegment(seg: AdSegment): AdSegment {
  return {
    ...seg,
    type: mapLegacySegmentType(seg.type),
  };
}

/** Per-show skip settings for filtering segments. */
export type SkipFilter = {
  skipAdvertisement: boolean;
  skipIntroOutro: boolean;
  skipSelfPromotion: boolean;
};

/**
 * Filter segments based on per-show skip settings.
 * Returns only segments that should be skipped according to the settings.
 */
const MIN_AUTO_SKIP_CONFIDENCE = 0.8;
const SHORT_SEGMENT_MS = 10_000;
const SHORT_SEGMENT_CONFIDENCE = 0.9;

/** Low-confidence or brief detections remain visible for manual review, not auto-skip. */
export function isSafeToAutoSkip(seg: AdSegment): boolean {
  if (!Number.isFinite(seg.confidence) || seg.confidence < MIN_AUTO_SKIP_CONFIDENCE) {
    return false;
  }
  const durationMs = seg.end_ms - seg.start_ms;
  return durationMs >= SHORT_SEGMENT_MS || seg.confidence >= SHORT_SEGMENT_CONFIDENCE;
}

export function filterSkippableSegments(
  segments: AdSegment[],
  filter: SkipFilter,
): AdSegment[] {
  return segments.filter((seg) => {
    if (!isSafeToAutoSkip(seg)) return false;
    const normalizedType = mapLegacySegmentType(seg.type);
    switch (normalizedType) {
      case 'advertisement':
        return filter.skipAdvertisement;
      case 'intro_outro':
        return filter.skipIntroOutro;
      case 'self_promotion':
        return filter.skipSelfPromotion;
      default:
        return false;
    }
  });
}

/** If position is inside an ad segment, return seek target (end_ms); else null. */
export function seekTargetIfInAd(positionMs: number, segments: AdSegment[]): number | null {
  for (const seg of segments) {
    if (positionMs >= seg.start_ms && positionMs < seg.end_ms - 250) {
      return seg.end_ms;
    }
  }
  return null;
}

export function formatMs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const SEGMENT_TYPE_LABELS: Record<AdSegmentType, string> = {
  advertisement: 'Advertisement',
  intro_outro: 'Intro/outro',
  self_promotion: 'Self promotion',
};


/** Human-readable label for a skip-map segment type. */
export function segmentTypeLabel(type: AdSegmentType | LegacyAdSegmentType | string): string {
  // Normalize legacy types first, so cached maps show new labels
  const normalizedType = mapLegacySegmentType(type);
  
  if (normalizedType in SEGMENT_TYPE_LABELS) {
    return SEGMENT_TYPE_LABELS[normalizedType as AdSegmentType];
  }
  
  return 'Unclassified segment';
}
