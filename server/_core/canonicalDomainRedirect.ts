// 301-redirects requests for a legacy/alias host (the old Manus subdomain,
// optionally www once verified - see LEGACY_REDIRECT_HOSTS below) to the
// canonical apex domain, preserving the path and query string exactly.
//
// Only GET/HEAD are ever redirected - POST/PUT/PATCH/DELETE (login, cart,
// payment, every tRPC mutation) always fall through untouched, so this can
// never interfere with an in-flight form submit or API call. localhost,
// 127.0.0.1, and *.local are never redirected, so local dev is unaffected
// regardless of what's set in the Host header.
import type { NextFunction, Request, Response } from "express";
import { ENV } from "./env";

const SAFE_REDIRECT_METHODS = new Set(["GET", "HEAD"]);

export function parseLegacyRedirectHosts(raw: string): string[] {
  return raw
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host.endsWith(".local");
}

// Computed once at module load (env doesn't change at runtime) rather than
// re-parsed on every request.
const canonicalHost = (ENV.canonicalHost || "ipenovel.com").trim().toLowerCase();
const legacyHosts = parseLegacyRedirectHosts(ENV.legacyRedirectHosts || "ipenovelz.manus.space");

export function canonicalDomainRedirect(req: Request, res: Response, next: NextFunction): void {
  const host = String(req.headers.host || "").split(":")[0].toLowerCase();

  const isSafeMethod = SAFE_REDIRECT_METHODS.has(req.method);
  const isCanonicalAlready = host === canonicalHost;

  if (isSafeMethod && host && !isLocalHost(host) && !isCanonicalAlready && legacyHosts.includes(host)) {
    const targetUrl = `https://${canonicalHost}${req.originalUrl || req.url || "/"}`;
    res.redirect(301, targetUrl);
    return;
  }

  next();
}
