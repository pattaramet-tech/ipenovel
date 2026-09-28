const HTML_CACHE_SAFE = /(no-store|no-cache|max-age=0|must-revalidate)/i;
const HASHED_CACHE_SAFE = /immutable/i;

function fail(message) {
  throw new Error(message);
}

function requireHttpsBase(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:") {
    fail(`Frontend asset graph target must be HTTPS: ${url.href}`);
  }
  return url;
}

function extractAssetUrls(html, pageUrl) {
  const refs = new Set();
  const patterns = [
    /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi,
    /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const raw = match[1]?.trim();
      if (!raw) continue;
      const resolved = new URL(raw, pageUrl);
      if (resolved.origin !== pageUrl.origin) continue;
      if (!resolved.pathname.startsWith("/assets/")) continue;
      refs.add(resolved.href);
    }
  }
  return [...refs];
}

function assertHtmlResponse(response, label) {
  if (response.status !== 200) {
    fail(`${label} returned HTTP ${response.status}.`);
  }
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("text/html")) {
    fail(`${label} did not return text/html; got ${contentType || "missing"}.`);
  }
  const cacheControl = response.headers.get("cache-control") || "";
  if (!HTML_CACHE_SAFE.test(cacheControl)) {
    fail(`${label} HTML cache policy is unsafe: ${cacheControl || "missing"}.`);
  }
}

function assertAssetResponse(response, assetUrl) {
  if (response.status !== 200) {
    fail(`Asset ${assetUrl.pathname} returned HTTP ${response.status}.`);
  }
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (/\.m?js$/i.test(assetUrl.pathname)) {
    if (!/(javascript|ecmascript)/i.test(contentType)) {
      fail(`Asset ${assetUrl.pathname} has invalid JS MIME ${contentType || "missing"}.`);
    }
  } else if (/\.css$/i.test(assetUrl.pathname)) {
    if (!contentType.includes("text/css")) {
      fail(`Asset ${assetUrl.pathname} has invalid CSS MIME ${contentType || "missing"}.`);
    }
  }
  const cacheControl = response.headers.get("cache-control") || "";
  if (!HASHED_CACHE_SAFE.test(cacheControl)) {
    fail(`Asset ${assetUrl.pathname} is not immutable-cacheable: ${cacheControl || "missing"}.`);
  }
}

export async function verifyFrontendAssetGraph({
  baseUrl,
  label = "frontend",
  routes = ["/", "/workspace"],
  timeoutMs = 15_000,
} = {}) {
  const base = requireHttpsBase(baseUrl);
  const assetUrls = new Set();

  for (const route of routes) {
    const pageUrl = new URL(route, base);
    const response = await fetch(pageUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    assertHtmlResponse(response, `${label} ${pageUrl.pathname}`);
    const html = await response.text();
    const refs = extractAssetUrls(html, pageUrl);
    if (refs.length === 0) {
      fail(`${label} ${pageUrl.pathname} referenced no /assets files.`);
    }
    for (const ref of refs) assetUrls.add(ref);
  }

  for (const raw of assetUrls) {
    const assetUrl = new URL(raw);
    const response = await fetch(assetUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    assertAssetResponse(response, assetUrl);
    await response.arrayBuffer();
  }

  const missing = new URL(
    `/assets/__m29314_missing_${Date.now()}.js`,
    base
  );
  const missingResponse = await fetch(missing, {
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (missingResponse.status !== 404) {
    fail(
      `${label} missing asset returned HTTP ${missingResponse.status}; expected 404.`
    );
  }
  const missingType = (missingResponse.headers.get("content-type") || "").toLowerCase();
  if (missingType.includes("text/html")) {
    fail(`${label} missing asset incorrectly fell back to HTML.`);
  }
  const missingCache = missingResponse.headers.get("cache-control") || "";
  if (!/no-store/i.test(missingCache)) {
    fail(
      `${label} missing asset 404 is cacheable: ${missingCache || "missing"}.`
    );
  }

  return {
    routesChecked: routes.length,
    assetsChecked: assetUrls.size,
    missingAssetStatus: missingResponse.status,
  };
}
