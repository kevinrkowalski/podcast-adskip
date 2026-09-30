/** Minimal node smoke for seek helper (no Jest). Run: node src/player/skipLogic.test.mjs */
function seekTargetIfInAd(positionMs, segments) {
  for (const seg of segments) {
    if (positionMs >= seg.start_ms && positionMs < seg.end_ms - 250) {
      return seg.end_ms;
    }
  }
  return null;
}

const segs = [
  { start_ms: 0, end_ms: 15000, type: 'preroll', confidence: 0.9 },
  { start_ms: 600000, end_ms: 660000, type: 'sponsor', confidence: 0.8 },
];

console.assert(seekTargetIfInAd(1000, segs) === 15000, 'preroll seek');
console.assert(seekTargetIfInAd(20000, segs) === null, 'content no seek');
console.assert(seekTargetIfInAd(601000, segs) === 660000, 'midroll seek');
console.assert(seekTargetIfInAd(659900, segs) === null, 'near end no seek');
console.log('skipLogic smoke OK');
