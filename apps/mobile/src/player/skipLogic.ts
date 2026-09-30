import type { AdSegment, AdSegmentType } from '@/src/types';

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
  sponsor: 'Sponsor ad',
  midroll: 'Mid-roll ad',
  preroll: 'Pre-roll',
  postroll: 'Post-roll',
  crosspromo: 'Cross-promo',
  network: 'Network promo',
  unknown: 'Ad segment',
};

/** Human-readable label for a skip-map segment type. */
export function segmentTypeLabel(type: AdSegmentType | string): string {
  if (type in SEGMENT_TYPE_LABELS) {
    return SEGMENT_TYPE_LABELS[type as AdSegmentType];
  }
  return SEGMENT_TYPE_LABELS.unknown;
}
