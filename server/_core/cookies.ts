import type { CookieOptions, Request } from "express";

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
