// Central SEO helpers: canonical URL construction and meta-description
// sanitization. Pure functions only - no DOM access here (see
// client/src/hooks/useDocumentHead.ts for the hook that writes to
// document.head using these).

export const SITE_NAME = "IpeNovel";
// Single source of truth for the canonical domain - never hardcode
// ipenovelz.manus.space or any other alias anywhere in metadata.
export const CANONICAL_BASE_URL = "https://ipenovel.com";

/**
 * Build an absolute canonical URL under CANONICAL_BASE_URL for the given
 * app-relative path. Always strips query string/hash (a canonical URL
 * points at the "clean" version of a page), always produces exactly one
 * leading slash before the path and no double slashes, and always returns
 * "https://ipenovel.com/" (with trailing slash) for the root path.
 */
export function buildCanonicalUrl(path: string): string {
  const raw = String(path ?? "/");
  const pathOnly = raw.split("?")[0].split("#")[0];
  const withLeadingSlash = pathOnly.startsWith("/") ? pathOnly : `/${pathOnly}`;
  const collapsedSlashes = withLeadingSlash.replace(/\/{2,}/g, "/");

  if (collapsedSlashes === "/") return `${CANONICAL_BASE_URL}/`;

  const withoutTrailingSlash = collapsedSlashes.replace(/\/+$/, "");
  return `${CANONICAL_BASE_URL}${withoutTrailingSlash}`;
}

const HTML_TAG_PATTERN = /<[^>]*>/g;
// Common named entities only - full HTML entity decoding isn't worth a
// dependency for a meta description that's already been stripped of tags.
const HTML_ENTITY_REPLACEMENTS: Array<[RegExp, string]> = [
  [/&nbsp;/gi, " "],
  [/&amp;/gi, "&"],
  [/&lt;/gi, "<"],
  [/&gt;/gi, ">"],
  [/&quot;/gi, '"'],
  [/&#0?39;/gi, "'"],
];

/**
 * Strip HTML tags, decode common entities, collapse whitespace, trim, and
 * truncate to maxLength (default ~160 chars, at a word boundary where
 * possible) with a trailing ellipsis. Returns "" for empty/missing input -
 * callers decide the fallback text (see buildNovelMetaDescription below).
 */
export function sanitizeMetaDescription(input: string | null | undefined, maxLength = 160): string {
  if (!input) return "";

  let text = input.replace(HTML_TAG_PATTERN, " ");
  for (const [pattern, replacement] of HTML_ENTITY_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }
  text = text.replace(/\s+/g, " ").trim();

  if (!text) return "";
  if (text.length <= maxLength) return text;

  const truncated = text.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");
  // Only cut at the word boundary if it doesn't throw away too much of the
  // budget (e.g. one very long word near the limit) - otherwise a hard cut
  // is more informative than an overly short sentence.
  const safeTruncated = lastSpace > maxLength * 0.6 ? truncated.slice(0, lastSpace) : truncated;
  return `${safeTruncated.trim()}…`;
}

/**
 * Meta description for a novel detail page: the novel's own
 * description/synopsis when present, otherwise a natural-reading fallback
 * that still names the novel and the site (never an empty <meta> tag).
 */
export function buildNovelMetaDescription(description: string | null | undefined, novelTitle: string): string {
  const sanitized = sanitizeMetaDescription(description);
  if (sanitized) return sanitized;
  const safeTitle = novelTitle?.trim() || "เรื่องนี้";
  return `อ่านนิยาย ${safeTitle} แปลไทยออนไลน์ได้ที่ ${SITE_NAME}`;
}
