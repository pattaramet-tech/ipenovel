import type { CookieOptions, Request } from "express";
import { parse as parseCookieHeader } from "cookie";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function isIpAddress(host: string) {
  // Basic IPv4 check and IPv6 presence detection.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(":");
}

function isSecureRequest(req: Request) {
  if (req.protocol === "https") return true;

  const forwardedProto = req.headers["x-forwarded-proto"];
  if (!forwardedProto) return false;

  const protoList = Array.isArray(forwardedProto)
    ? forwardedProto
    : forwardedProto.split(",");

  return protoList.some(proto => proto.trim().toLowerCase() === "https");
}

export function getSessionCookieOptions(
  req: Request
): Pick<CookieOptions, "httpOnly" | "path" | "sameSite" | "secure"> {
  const hostname = req.hostname || "";
  const isLocal = LOCAL_HOSTS.has(hostname) || isIpAddress(hostname);

  // secure is the source of truth; sameSite is DERIVED from it below, so it
  // is structurally impossible to emit SameSite=None with Secure=false -
  // browsers silently reject/drop that combination, which was the likely
  // cause of admin sessions not persisting when a proxy in front of the app
  // didn't get detected as HTTPS (isSecureRequest only trusts req.protocol
  // and x-forwarded-proto). Treat the request as secure if we can detect
  // HTTPS directly, if we're explicitly running in production, or if the
  // host isn't a known local dev host/IP.
  const secure =
    isSecureRequest(req) ||
    process.env.NODE_ENV === "production" ||
    !isLocal;

  // Debug only - never log the token/session value itself, just the
  // request context that decided secure/sameSite, to help diagnose "admin
  // session doesn't persist" reports without exposing anything sensitive.
  if (process.env.NODE_ENV !== "production") {
    console.log("[Cookie] session cookie options", {
      host: req.hostname,
      protocol: req.protocol,
      xForwardedProto: req.headers["x-forwarded-proto"] || null,
      secure,
      sameSite: secure ? "none" : "lax",
    });
  }

  return {
    httpOnly: true,
    path: "/",
    sameSite: secure ? "none" : "lax",
    secure,
  };
}

/**
 * Reads a single cookie by name from the raw `Cookie` request header.
 * There is no `cookie-parser` middleware registered in this app (confirmed:
 * server/_core/index.ts never calls `app.use(cookieParser())`), so
 * `req.cookies` is always undefined - every cookie read in this codebase
 * goes through the `cookie` package directly (see server/_core/sdk.ts's
 * private `parseCookies`). This is the shared, exported equivalent, for
 * the Google OAuth state/nonce/PKCE cookies (server/_core/googleOAuth.ts),
 * which - unlike the session cookie - are read back by a plain route
 * handler outside sdk.ts.
 */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const parsed = parseCookieHeader(header);
  return parsed[name];
}

/**
 * Short-lived HttpOnly cookie options for the Google OAuth `state`/`nonce`/
 * PKCE `code_verifier` values (server/_core/googleOAuth.ts) - these exist
 * only to survive one redirect round-trip to Google and back, never to
 * persist a session, so they deliberately do NOT reuse
 * getSessionCookieOptions above:
 *
 *  - `sameSite` is always "lax" (not derived from `secure` the way the
 *    session cookie's is) - the browser must still send these cookies on
 *    the top-level GET navigation Google redirects back with, which is
 *    exactly the case `SameSite=Lax` is designed to allow (a top-level,
 *    same-site-initiated round trip), and unlike the session cookie there
 *    is no reason to ever widen this to `SameSite=None`.
 *  - `path` is restricted to the Google OAuth routes themselves, not "/"
 *    - these cookies are meaningless (and should never be sent) outside
 *      `/api/auth/google/start` and `/api/auth/google/callback`.
 *  - `maxAge` is a fixed ~10 minutes - long enough for a real user to
 *    complete the Google consent screen, short enough that an abandoned
 *    attempt's cookies don't linger.
 *
 * Reuses the same `secure` detection as getSessionCookieOptions (via
 * isSecureRequest/NODE_ENV/isLocal above) so both cookie families agree
 * about whether the current request is genuinely HTTPS.
 */
const GOOGLE_OAUTH_COOKIE_PATH = "/api/auth/google";
const GOOGLE_OAUTH_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;

export function getGoogleOAuthTransientCookieOptions(
  req: Request
): Pick<CookieOptions, "httpOnly" | "path" | "sameSite" | "secure" | "maxAge"> {
  const hostname = req.hostname || "";
  const isLocal = LOCAL_HOSTS.has(hostname) || isIpAddress(hostname);
  const secure = isSecureRequest(req) || process.env.NODE_ENV === "production" || !isLocal;

  return {
    httpOnly: true,
    path: GOOGLE_OAUTH_COOKIE_PATH,
    sameSite: "lax",
    secure,
    maxAge: GOOGLE_OAUTH_COOKIE_MAX_AGE_MS,
  };
}
