/** Media-style timestamps: m:ss, mm:ss, or h:mm:ss (not bare years / integers). */
const TIMESTAMP_RE = /(?<!\d)(?:\d{1,2}:\d{2}:\d{2}|\d{1,2}:\d{2})(?!\d)/g;

export type ShowNotesPart =
  | { type: 'text'; text: string }
  | { type: 'timestamp'; raw: string; ms: number };

export function parseTimestampToMs(raw: string): number | null {
  const bits = raw.split(':').map((p) => Number(p));
  if (bits.some((n) => !Number.isFinite(n) || n < 0)) return null;
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (bits.length === 3) {
    [hours, minutes, seconds] = bits;
    if (minutes > 59 || seconds > 59) return null;
  } else if (bits.length === 2) {
    [minutes, seconds] = bits;
    // Allow minutes >= 60 (e.g. 75:30) when hours are omitted.
    if (seconds > 59) return null;
  } else {
    return null;
  }
  const totalSec = hours * 3600 + minutes * 60 + seconds;
  // Reject absurd lengths that are unlikely to be episode cues.
  if (totalSec > 24 * 3600) return null;
  return totalSec * 1000;
}

/** Split show notes into plain text and tappable timestamps. */
export function parseShowNotesParts(notes: string): ShowNotesPart[] {
  if (!notes) return [];
  const parts: ShowNotesPart[] = [];
  let last = 0;
  TIMESTAMP_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TIMESTAMP_RE.exec(notes)) != null) {
    const raw = match[0];
    const ms = parseTimestampToMs(raw);
    if (ms == null) continue;
    if (match.index > last) parts.push({ type: 'text', text: notes.slice(last, match.index) });
    parts.push({ type: 'timestamp', raw, ms });
    last = match.index + raw.length;
  }
  if (last < notes.length) parts.push({ type: 'text', text: notes.slice(last) });
  return parts;
}
