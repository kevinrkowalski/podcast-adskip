/** Minimal OPML 2.0 parser for podcast subscription outlines. */

export type OpmlFeed = {
  title: string;
  xmlUrl: string;
};

export type ParsedOpml = {
  feeds: OpmlFeed[];
  /** type="rss" (or atom) outlines that had no usable xmlUrl. */
  missingFeedUrl: number;
  /** Repeated xmlUrl values after the first one in the file. */
  duplicates: number;
};

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, num: string) => {
      const code = parseInt(num, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attr(source: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i');
  const match = source.match(re);
  if (!match?.[2]) return undefined;
  const value = decodeXml(match[2]).trim();
  return value || undefined;
}

/** Compare feed URLs ignoring scheme case, host case, hash, and a trailing slash. */
export function normalizeFeedUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol.toLowerCase()}//${parsed.hostname.toLowerCase()}${path}${parsed.search}`;
  } catch {
    return trimmed.toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * Collect podcast feeds from OPML outlines.
 * Folder outlines (no xmlUrl and no rss/atom type) are ignored.
 * Duplicate xmlUrl values inside the file are returned once.
 */
export function parseOpml(xml: string): ParsedOpml {
  const source = xml.replace(/^\uFEFF/, '');
  const feeds: OpmlFeed[] = [];
  const seen = new Set<string>();
  let missingFeedUrl = 0;
  let duplicates = 0;
  const outlineRe = /<outline\b([^>]*?)\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = outlineRe.exec(source))) {
    const attrs = match[1] ?? '';
    const type = (attr(attrs, 'type') || '').toLowerCase();
    const xmlUrl = attr(attrs, 'xmlUrl');
    const isFeedType = type === 'rss' || type === 'atom';
    if (!xmlUrl && !isFeedType) continue;
    if (!xmlUrl || !/^https?:\/\//i.test(xmlUrl)) {
      missingFeedUrl += 1;
      continue;
    }
    const key = normalizeFeedUrl(xmlUrl);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    const title = attr(attrs, 'title') || attr(attrs, 'text') || xmlUrl;
    feeds.push({ title, xmlUrl });
  }
  return { feeds, missingFeedUrl, duplicates };
}
