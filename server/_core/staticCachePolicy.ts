// Pure, dependency-free cache-policy decision for static files served in
// production (server/_core/vite.ts's serveStatic()). Kept separate from
// Express wiring so it can be unit-tested without a running server.
//
// Three categories, each with a very different correctness requirement:
//   1. Files Vite emits under the built `assets/` directory carry a content
//      hash in their filename - a given URL either serves the exact bytes
//      that hash represents forever, or (after a new build) a different
//      URL. Safe to cache for a very long time, marked immutable.
//   2. HTML (index.html, and the SPA fallback that serves the same
//      template for client-side routes) has no hash and is what actually
//      points at the current hashed asset URLs - it must always be
//      revalidated so a deploy is visible immediately, never served stale
//      from a shared/browser cache.
//   3. Everything else under the static root (e.g. files copied verbatim
//      from client/public/ - favicon.ico, robots.txt, and similar) has no
//      hash either, but changes rarely - a short cache is a reasonable
//      middle ground rather than the two extremes above.

export const IMMUTABLE_HASHED_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const HTML_CACHE_CONTROL = "public, max-age=0, must-revalidate";
export const SHORT_CACHE_PUBLIC_FILE_CACHE_CONTROL = "public, max-age=3600";

export type StaticCachePolicyKind = "immutable-hashed-asset" | "html" | "short-cache-public-file";

/**
 * Classifies a static file by its path (absolute filesystem path, or a
 * path/URL relative to the static root - either works, since only the
 * path segments matter). Handles both `/` and `\` separators so this
 * behaves identically whether `express.static`/Node report Windows or
 * POSIX-style paths.
 *
 * "assets" must appear as an exact path SEGMENT (a directory component),
 * not merely as a substring of the path - e.g. `my-assets-backup/x.js` or
 * `foo/assetsxyz/bar.js` are correctly NOT classified as a hashed asset,
 * only a real `.../assets/...` directory is.
 */
export function classifyStaticFile(filePath: string): StaticCachePolicyKind {
  const segments = filePath.split(/[\\/]+/).filter(Boolean);
  const fileName = segments[segments.length - 1] ?? "";

  if (fileName.toLowerCase() === "index.html") {
    return "html";
  }

  const directorySegments = segments.slice(0, -1);
  const isUnderAssetsDirectory = directorySegments.some((segment) => segment === "assets");
  if (isUnderAssetsDirectory) {
    return "immutable-hashed-asset";
  }

  return "short-cache-public-file";
}

/** The `Cache-Control` header value to send for a given static file path. */
export function resolveStaticCacheControl(filePath: string): string {
  switch (classifyStaticFile(filePath)) {
    case "immutable-hashed-asset":
      return IMMUTABLE_HASHED_ASSET_CACHE_CONTROL;
    case "html":
      return HTML_CACHE_CONTROL;
    case "short-cache-public-file":
      return SHORT_CACHE_PUBLIC_FILE_CACHE_CONTROL;
  }
}
