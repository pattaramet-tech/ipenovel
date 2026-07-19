import type { Request, Response } from "express";
import * as db from "../db";

// Intentionally a plain constant, not ENV.canonicalHost - a sitemap must
// always advertise the one true canonical domain regardless of what legacy/
// alias hosts happen to be configured for redirect purposes (see
// canonicalDomainRedirect.ts, a separate concern).
const CANONICAL_BASE_URL = "https://ipenovel.com";

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function formatLastmod(date: unknown): string | undefined {
  if (!date) return undefined;
  const d = date instanceof Date ? date : new Date(date as string);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().split("T")[0];
}

interface SitemapUrl {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: string;
}

export function buildSitemapXml(urls: SitemapUrl[]): string {
  const entries = urls
    .map((u) => {
      const parts = [`    <loc>${escapeXml(u.loc)}</loc>`];
      if (u.lastmod) parts.push(`    <lastmod>${u.lastmod}</lastmod>`);
      if (u.changefreq) parts.push(`    <changefreq>${u.changefreq}</changefreq>`);
      if (u.priority) parts.push(`    <priority>${u.priority}</priority>`);
      return `  <url>\n${parts.join("\n")}\n  </url>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

const STATIC_URLS: SitemapUrl[] = [
  { loc: `${CANONICAL_BASE_URL}/`, changefreq: "daily", priority: "1.0" },
  { loc: `${CANONICAL_BASE_URL}/novels`, changefreq: "daily", priority: "0.8" },
];

/**
 * GET /sitemap.xml - homepage, /novels, and one entry per published novel
 * (novels.detail's own public/publicOnly rule - archived/draft novels are
 * never included). Never touches episodes (a novel with hundreds of
 * chapters would otherwise make this response enormous) and never includes
 * admin/wallet/orders/account/reader URLs - see robots.txt for the matching
 * Disallow rules on those.
 */
export async function handleSitemapXml(_req: Request, res: Response) {
  res.set("Content-Type", "application/xml; charset=utf-8");

  try {
    const publishedNovels = await db.getPublishedNovelsForSitemap();

    const novelUrls: SitemapUrl[] = publishedNovels.map((n: any) => ({
      loc: `${CANONICAL_BASE_URL}/novels/${n.id}`,
      lastmod: formatLastmod(n.updatedAt),
      changefreq: "weekly",
      priority: "0.6",
    }));

    res.status(200).send(buildSitemapXml([...STATIC_URLS, ...novelUrls]));
  } catch (error) {
    // Never let a DB hiccup break the sitemap request - fall back to the
    // static URLs, which need no database at all.
    console.error("[Sitemap] Failed to load published novels, serving static-only sitemap:", error);
    res.status(200).send(buildSitemapXml(STATIC_URLS));
  }
}
