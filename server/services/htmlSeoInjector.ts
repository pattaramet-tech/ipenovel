// Safe, marker-based <head> metadata injection into the built index.html
// template. Deliberately does NOT regex over the whole HTML document - only
// ever touches the content between the two literal `<!-- SEO_START -->` /
// `<!-- SEO_END -->` comment markers (see client/index.html), so it can
// never accidentally corrupt anything outside that block (script tags,
// font links, etc.) regardless of what a novel's title/description
// contains.
import type { SeoMetadata } from "./serverSeoRenderer";

const SEO_BLOCK_PATTERN = /<!-- SEO_START -->[\s\S]*?<!-- SEO_END -->/;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function unescapeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// JSON-LD sits inside <script type="application/ld+json">, whose content is
// parsed as raw text by the HTML tokenizer looking for a literal
// "</script" - not as HTML markup. HTML-escaping would corrupt the JSON, so
// instead only the one dangerous substring is neutralized: escaping "<" as
// a unicode escape stops "</script>" appearing literally in the output
// while still decoding back to valid, unmodified JSON.
function safeJsonLdScript(data: Record<string, unknown>): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

interface TemplateDefaults {
  title?: string;
  description?: string;
  canonical?: string;
}

function extractTag(block: string, pattern: RegExp): string | undefined {
  const match = block.match(pattern);
  return match ? unescapeHtml(match[1]) : undefined;
}

/** Read the template's own current title/description/canonical, so a route
 *  that only overrides e.g. `robots` doesn't lose the rest. */
function readTemplateDefaults(template: string): TemplateDefaults {
  const blockMatch = template.match(SEO_BLOCK_PATTERN);
  const block = blockMatch ? blockMatch[0] : template;
  return {
    title: extractTag(block, /<title>([\s\S]*?)<\/title>/),
    description: extractTag(block, /<meta\s+name="description"\s+content="([\s\S]*?)"\s*\/?>/),
    canonical: extractTag(block, /<link\s+rel="canonical"\s+href="([\s\S]*?)"\s*\/?>/),
  };
}

function buildSeoBlock(meta: SeoMetadata): string {
  const lines: string[] = [];

  if (meta.title) {
    lines.push(`<title>${escapeHtml(meta.title)}</title>`);
    lines.push(`<meta property="og:title" content="${escapeHtml(meta.title)}" />`);
  }
  if (meta.description) {
    lines.push(`<meta name="description" content="${escapeHtml(meta.description)}" />`);
    lines.push(`<meta property="og:description" content="${escapeHtml(meta.description)}" />`);
  }
  if (meta.canonical) {
    lines.push(`<link rel="canonical" href="${escapeHtml(meta.canonical)}" />`);
    lines.push(`<meta property="og:url" content="${escapeHtml(meta.canonical)}" />`);
  }
  if (meta.robots) {
    lines.push(`<meta name="robots" content="${escapeHtml(meta.robots)}" />`);
  }
  if (meta.ogType) {
    lines.push(`<meta property="og:type" content="${escapeHtml(meta.ogType)}" />`);
  }
  if (meta.ogImage) {
    lines.push(`<meta property="og:image" content="${escapeHtml(meta.ogImage)}" />`);
    lines.push(`<meta name="twitter:card" content="summary_large_image" />`);
    if (meta.title) lines.push(`<meta name="twitter:title" content="${escapeHtml(meta.title)}" />`);
    if (meta.description) {
      lines.push(`<meta name="twitter:description" content="${escapeHtml(meta.description)}" />`);
    }
    lines.push(`<meta name="twitter:image" content="${escapeHtml(meta.ogImage)}" />`);
  }
  if (meta.jsonLd) {
    lines.push(`<script type="application/ld+json">${safeJsonLdScript(meta.jsonLd)}</script>`);
  }

  return `<!-- SEO_START -->\n    ${lines.join("\n    ")}\n    <!-- SEO_END -->`;
}

/**
 * Replace the `<!-- SEO_START -->...<!-- SEO_END -->` block in `template`
 * with tags built from `meta`. Any field left unset in `meta` falls back to
 * whatever the template's own current value is (extracted once from the
 * same template string) - so a route that only needs to change `robots`,
 * say, doesn't have to re-specify title/description/canonical to avoid
 * losing them. Never duplicates a tag (the whole marked region is replaced
 * wholesale every time, old contents included), and if the markers are
 * missing entirely (unexpected index.html edit), returns the template
 * completely unmodified rather than throwing or corrupting the document.
 */
export function injectSeoMetadata(template: string, meta: SeoMetadata): string {
  if (!SEO_BLOCK_PATTERN.test(template)) return template;

  const defaults = readTemplateDefaults(template);
  const merged: SeoMetadata = {
    title: meta.title ?? defaults.title,
    description: meta.description ?? defaults.description,
    canonical: meta.canonical ?? defaults.canonical,
    robots: meta.robots,
    ogType: meta.ogType,
    ogImage: meta.ogImage,
    jsonLd: meta.jsonLd,
  };

  return template.replace(SEO_BLOCK_PATTERN, buildSeoBlock(merged));
}
