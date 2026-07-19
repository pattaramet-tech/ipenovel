// Server-side HTML <head> metadata injection for public SEO routes - fixes
// view-source/social-crawler requests seeing the static homepage
// title/description/canonical/OG for every route (e.g. /novels/57), since
// the previous fix (client/src/hooks/useDocumentHead.ts) only updates
// document.head AFTER React hydrates, which crawlers that don't execute JS
// (or execute it too slowly/not at all) never see.
//
// Reuses client/src/lib/seo.ts's pure helpers (buildCanonicalUrl,
// buildNovelMetaDescription, SITE_NAME) directly - not duplicated here - so
// the server-rendered <head> and the client-side hook can never drift on
// what a canonical URL or a novel's fallback description looks like. That
// file has zero DOM/React dependencies, so it's safe to import from Node.
//
// See docs/PERFORMANCE_SEO_AUDIT.md for the full route table, the
// noindex/robots reasoning, and the Manus edge-layer OG limitation this
// can't reach (PART D).
import * as db from "../db";
import { buildCanonicalUrl, buildNovelMetaDescription, SITE_NAME } from "../../client/src/lib/seo";
import { injectSeoMetadata } from "./htmlSeoInjector";

const HOME_TITLE = `${SITE_NAME} — นิยายแปลออนไลน์`;
const HOME_DESCRIPTION =
  "อ่านนิยายแปลออนไลน์ นิยายแฟนฟิค นิยายกีฬา นิยายอนิเมะ และนิยายยอดนิยมบน IpeNovel";
const NOVELS_LIST_TITLE = "รายการนิยาย | IpeNovel";
const NOVELS_LIST_DESCRIPTION =
  "เลือกอ่านนิยายแปลออนไลน์หลากหลายแนวบน IpeNovel ทั้งนิยายยอดนิยม นิยายใหม่ และนิยายฟรีครบทุกหมวดหมู่";

// Mirrors the exact same route classification client/src/hooks/useDocumentHead.ts
// call sites use (Cart/Orders/MyNovels/MyLibrary/Profile/Points/Wallet/
// Payment/Admin) - keep these two lists in sync.
const PRIVATE_NOINDEX_PATH_PREFIXES = [
  "/admin",
  "/cart",
  "/orders",
  "/my-novels",
  "/my-library",
  "/profile",
  "/points",
  "/wallet",
  "/payment",
];

const NOVEL_DETAIL_PATTERN = /^\/novels\/(\d+)\/?$/;
const READER_PATTERN = /^\/read\/(\d+)\/?$/;

export interface SeoMetadata {
  title?: string;
  description?: string;
  canonical?: string;
  robots?: string;
  ogType?: "website" | "book" | "article";
  ogImage?: string;
  jsonLd?: Record<string, unknown> | null;
}

// ---- In-memory TTL cache for novel SEO data (PART E - no Redis) ----
const NOVEL_CACHE_TTL_MS = 10 * 60 * 1000;
const NOVEL_CACHE_MAX_ENTRIES = 500;

interface NovelSeoRow {
  id: number;
  title: string;
  description: string | null;
  coverImageUrl: string | null;
  author: string | null;
  publicationStatus: string;
}

interface CacheEntry {
  data: NovelSeoRow | null;
  expiresAt: number;
}

const novelSeoCache = new Map<number, CacheEntry>();

async function getNovelSeoDataCached(novelId: number): Promise<NovelSeoRow | null> {
  const now = Date.now();
  const cached = novelSeoCache.get(novelId);
  if (cached && cached.expiresAt > now) return cached.data;

  let data: NovelSeoRow | null;
  try {
    data = (await db.getNovelSeoData(novelId)) as NovelSeoRow | null;
  } catch (error) {
    console.error("[ServerSEO] Failed to load novel SEO data, DB unavailable:", error);
    // Don't cache a DB-error result (would pin a false "not found" for the
    // whole TTL window) - serve the last-known-good cached value if any,
    // otherwise let the caller fall back to generic site metadata.
    return cached?.data ?? null;
  }

  if (novelSeoCache.size >= NOVEL_CACHE_MAX_ENTRIES && !novelSeoCache.has(novelId)) {
    const oldestKey = novelSeoCache.keys().next().value;
    if (oldestKey !== undefined) novelSeoCache.delete(oldestKey);
  }
  novelSeoCache.set(novelId, { data, expiresAt: now + NOVEL_CACHE_TTL_MS });
  return data;
}

/** Test-only escape hatch - never used by production code paths. */
export function __clearNovelSeoCacheForTests() {
  novelSeoCache.clear();
}

/**
 * Resolve the <head> metadata for a given request path. Returns null for
 * any route this renderer doesn't have an opinion about (e.g.
 * /sports-votes) - callers should leave the HTML template's existing
 * metadata untouched in that case rather than guessing.
 */
export async function resolveSeoMetadata(pathname: string): Promise<SeoMetadata | null> {
  const cleanPath = (pathname.split("?")[0].split("#")[0] || "/").replace(/\/{2,}/g, "/");

  if (cleanPath === "/") {
    return {
      title: HOME_TITLE,
      description: HOME_DESCRIPTION,
      canonical: buildCanonicalUrl("/"),
      ogType: "website",
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: SITE_NAME,
        url: buildCanonicalUrl("/"),
      },
    };
  }

  if (cleanPath === "/novels") {
    // Every /novels query variant (?sort=, ?filter=, ?storyStatus=, ?page=,
    // ?search=) is a view of the same catalog, not a distinct page - the
    // client hook (client/src/pages/NovelsPage.tsx) already made this call
    // and always canonicalizes to plain /novels, so the server must match it
    // exactly or the pre-hydration <head> and the post-hydration <head>
    // would disagree (see docs/PERFORMANCE_SEO_AUDIT.md Phase 2 on avoiding
    // client/server drift). Title/description are likewise left static for
    // the same reason: the client hook never varies them by query either.
    //
    // robots is the one axis that's safe to differentiate server-side only,
    // since the client hook never sets a robots tag for /novels at all (a
    // missing tag defaults to indexable) - adding noindex,follow here for
    // thin/duplicate query variants (internal search results, and page 2+
    // which already defers all index weight to the bare canonical) reduces
    // crawl waste without the client ever needing to remove/contradict it.
    const queryString = pathname.split("?")[1] ?? "";
    const query = new URLSearchParams(queryString);
    const hasSearch = (query.get("search") ?? "").trim().length > 0;
    const pageNum = parseInt(query.get("page") ?? "1", 10);
    const isDeepPage = Number.isFinite(pageNum) && pageNum > 1;

    return {
      title: NOVELS_LIST_TITLE,
      description: NOVELS_LIST_DESCRIPTION,
      canonical: buildCanonicalUrl("/novels"),
      ogType: "website",
      robots: hasSearch || isDeepPage ? "noindex,follow" : undefined,
    };
  }

  const novelMatch = cleanPath.match(NOVEL_DETAIL_PATTERN);
  if (novelMatch) {
    const novelId = parseInt(novelMatch[1], 10);
    const canonical = buildCanonicalUrl(`/novels/${novelId}`);
    const novel = await getNovelSeoDataCached(novelId);

    if (!novel || novel.publicationStatus !== "published") {
      // Not found / archived / draft - never expose it, fall back to
      // generic site-level metadata. HTTP status intentionally stays
      // whatever the SPA's existing catch-all already sends (200, with the
      // client rendering its own "novel not available" UI) - this function
      // only ever changes <head> tag content, never response status, so
      // nothing about the route's existing behavior changes.
      return { title: HOME_TITLE, description: HOME_DESCRIPTION, canonical, ogType: "website" };
    }

    const description = buildNovelMetaDescription(novel.description, novel.title);
    const jsonLd: Record<string, unknown> = {
      "@context": "https://schema.org",
      "@type": "Book",
      name: novel.title,
      url: canonical,
      inLanguage: "th-TH",
    };
    if (description) jsonLd.description = description;
    if (novel.coverImageUrl) jsonLd.image = novel.coverImageUrl;
    if (novel.author?.trim()) {
      jsonLd.author = { "@type": "Person", name: novel.author.trim() };
    }

    return {
      title: `${novel.title} | ${SITE_NAME}`,
      description,
      canonical,
      ogType: "book",
      ogImage: novel.coverImageUrl || undefined,
      jsonLd,
    };
  }

  const readerMatch = cleanPath.match(READER_PATTERN);
  if (readerMatch) {
    // reader.getEpisode is a protectedProcedure - an unauthenticated
    // crawler (and this renderer runs with no user session) can never see
    // real chapter/episode data here, so this deliberately does NOT query
    // the DB for episode-specific title/description. noindex,follow (not
    // nofollow) so the page's own nav links still get crawled - same
    // reasoning as the client-side hook's Reader call.
    return {
      title: `อ่านนิยาย | ${SITE_NAME}`,
      canonical: buildCanonicalUrl(cleanPath),
      robots: "noindex,follow",
    };
  }

  if (PRIVATE_NOINDEX_PATH_PREFIXES.some((prefix) => cleanPath === prefix || cleanPath.startsWith(`${prefix}/`))) {
    // Only robots changes - title/description/canonical are intentionally
    // left unset here so the injector preserves whatever the template
    // already has, matching the client-side hook's behavior for these same
    // routes (it also only ever sets `robots` for private pages).
    return { robots: "noindex,nofollow" };
  }

  return null;
}

/**
 * Resolve metadata for `pathname` and inject it into `template`. The single
 * entry point server/_core/vite.ts calls for every HTML response. Never
 * throws - any failure resolving metadata (a DB error not already caught by
 * getNovelSeoDataCached, a bad path, etc.) falls back to returning the
 * template completely unmodified rather than breaking the page.
 */
export async function renderSeoHtml(template: string, pathname: string): Promise<string> {
  try {
    const meta = await resolveSeoMetadata(pathname);
    if (!meta) return template;
    return injectSeoMetadata(template, meta);
  } catch (error) {
    console.error("[ServerSEO] Failed to resolve/inject SEO metadata, serving template unmodified:", error);
    return template;
  }
}
