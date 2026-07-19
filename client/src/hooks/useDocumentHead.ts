import { useEffect } from "react";

// Imperative document.head management for this client-rendered SPA (no SSR/
// framework head system - see docs/PERFORMANCE_SEO_AUDIT.md PART B for why a
// dependency-free hook was chosen over react-helmet-async). Every managed
// tag is looked up and updated in place rather than duplicated, so calling
// this hook repeatedly (e.g. on every render as data loads in) never leaves
// behind multiple <meta name="description"> tags.
//
// Known limitation: a route that never calls this hook keeps whatever the
// previously-visited routed page left in document.head. Only the pages
// this task's audit called out are wired up (see the audit doc); expanding
// coverage to every route is listed there as a future recommendation.

function upsertMetaByName(name: string, content: string) {
  let el = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute("name", name);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function upsertMetaByProperty(property: string, content: string) {
  let el = document.querySelector<HTMLMetaElement>(`meta[property="${property}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute("property", property);
    document.head.appendChild(el);
  }
  el.setAttribute("content", content);
}

function removeMetaByName(name: string) {
  document.querySelector(`meta[name="${name}"]`)?.remove();
}

function removeMetaByProperty(property: string) {
  document.querySelector(`meta[property="${property}"]`)?.remove();
}

function upsertCanonicalLink(href: string) {
  let el = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!el) {
    el = document.createElement("link");
    el.setAttribute("rel", "canonical");
    document.head.appendChild(el);
  }
  el.setAttribute("href", href);
}

const JSON_LD_SCRIPT_ID = "seo-json-ld";

function upsertJsonLd(data: object | object[] | null | undefined) {
  const existing = document.getElementById(JSON_LD_SCRIPT_ID) as HTMLScriptElement | null;
  if (!data) {
    existing?.remove();
    return;
  }
  let el = existing;
  if (!el) {
    el = document.createElement("script");
    el.type = "application/ld+json";
    el.id = JSON_LD_SCRIPT_ID;
    document.head.appendChild(el);
  }
  try {
    el.textContent = JSON.stringify(data);
  } catch {
    // A serialization failure (e.g. a circular reference slipped in) must
    // never crash the page - just drop the structured data for this render.
    el.textContent = "";
  }
}

export interface UseDocumentHeadOptions {
  /** Sets document.title AND og:title. */
  title?: string;
  /** Sets <meta name="description"> AND og:description. Pass through
   *  sanitizeMetaDescription()/buildNovelMetaDescription() first. */
  description?: string;
  /** Absolute URL - build with buildCanonicalUrl(), never a raw path. Sets
   *  <link rel="canonical"> AND og:url. */
  canonical?: string;
  /** e.g. "noindex,nofollow" | "noindex,follow". Omit entirely for a normal
   *  indexable page - that's the crawler default, no tag needed. */
  robots?: string;
  ogType?: "website" | "book" | "article";
  /** Absolute image URL. When omitted, any og:image/twitter:card left by a
   *  previously-visited page is removed (never advertise a stale image). */
  ogImage?: string;
  /** Pass a stable reference (useMemo) if non-null - see hook-level note. */
  jsonLd?: object | object[] | null;
}

/**
 * Set document.title and the page-specific SEO tags for the current route.
 * Each field is independent and optional; omit a field to leave that
 * concern alone (e.g. omit `robots` for a normal public page). Safe to call
 * with partially-loaded data (e.g. while a query is still pending) - pass
 * only the fields you already have, and call again once more data arrives.
 */
export function useDocumentHead(options: UseDocumentHeadOptions) {
  const { title, description, canonical, robots, ogType, ogImage, jsonLd } = options;

  useEffect(() => {
    if (title) {
      document.title = title;
      upsertMetaByProperty("og:title", title);
    }

    if (description) {
      upsertMetaByName("description", description);
      upsertMetaByProperty("og:description", description);
    }

    if (canonical) {
      upsertCanonicalLink(canonical);
      upsertMetaByProperty("og:url", canonical);
    }

    if (ogType) {
      upsertMetaByProperty("og:type", ogType);
    }

    if (ogImage) {
      upsertMetaByProperty("og:image", ogImage);
      upsertMetaByName("twitter:card", "summary_large_image");
    } else {
      removeMetaByProperty("og:image");
      removeMetaByName("twitter:card");
    }

    if (robots) {
      upsertMetaByName("robots", robots);
    } else {
      removeMetaByName("robots");
    }

    upsertJsonLd(jsonLd ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, description, canonical, robots, ogType, ogImage, jsonLd]);
}
