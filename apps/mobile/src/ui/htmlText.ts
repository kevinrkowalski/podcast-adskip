/**
 * Readable plain text from feed HTML (show notes, podcast descriptions): paragraphs and
 * list items become line breaks, tags are dropped, common entities are decoded.
 */
export function htmlToPlainText(raw?: string): string {
  return (raw ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    // A tag cut off by truncation (saved copies are shortened) has no closing '>'.
    .replace(/<[a-z/!][^>]*$/i, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (m, n) => (Number(n) > 0 && Number(n) < 0x110000 ? String.fromCodePoint(Number(n)) : m))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => {
      const c = parseInt(h, 16);
      return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : m;
    })
    // Last, so "&amp;lt;" decodes once to the text "&lt;" (not on to "<").
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
