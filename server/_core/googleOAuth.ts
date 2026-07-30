import { createHash, randomBytes } from "node:crypto";
import { COOKIE_NAME, SESSION_TTL_MS } from "@shared/const";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { safeErrorSummary } from "../../scripts/lib/safeErrorSummary.mjs";
import { resolveGoogleIdentity } from "../services/googleIdentityService";
import { getGoogleOAuthTransientCookieOptions, getSessionCookieOptions, readCookie } from "./cookies";
import { ENV } from "./env";
import * as googleOidc from "./googleOidc";
import { sdk } from "./sdk";

// Direct Google OpenID Connect login - the AUTH_PROVIDER=google counterpart
// to server/_core/oauth.ts's Manus /api/oauth/callback. Registered
// unconditionally (see server/_core/index.ts), but every route below fails
// closed with a plain 404 unless ENV.authProvider === "google", so with the
// flag at its default ("manus") these routes are indistinguishable from not
// existing at all - existing production behavior cannot change just
// because this file was deployed.

const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_OAUTH_SCOPE = "openid email profile";

export const GOOGLE_STATE_COOKIE = "google_oauth_state";
export const GOOGLE_NONCE_COOKIE = "google_oauth_nonce";
export const GOOGLE_PKCE_COOKIE = "google_oauth_code_verifier";
const GOOGLE_TRANSIENT_COOKIES = [GOOGLE_STATE_COOKIE, GOOGLE_NONCE_COOKIE, GOOGLE_PKCE_COOKIE];

function isGoogleProviderConfigured(): boolean {
  return Boolean(ENV.googleClientId && ENV.googleClientSecret && ENV.googleRedirectUri);
}

/** Cryptographically random, URL-safe token - used for state, nonce, and the PKCE code_verifier alike (all three need the same property: unguessable, opaque, no meaning of their own). */
function generateRandomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** PKCE S256 code_challenge derivation (RFC 7636 §4.2): BASE64URL(SHA256(code_verifier)), no padding. */
function computeCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

function clearGoogleOAuthCookies(req: Request, res: Response): void {
  const options = getGoogleOAuthTransientCookieOptions(req);
  for (const name of GOOGLE_TRANSIENT_COOKIES) {
    res.clearCookie(name, { ...options, maxAge: -1 });
  }
}

export function registerGoogleOAuthRoutes(app: Express) {
  app.get("/api/auth/google/start", (req: Request, res: Response) => {
    if (ENV.authProvider !== "google") {
      res.status(404).end();
      return;
    }
    if (!isGoogleProviderConfigured()) {
      console.error(
        "[GoogleOAuth] ERROR: GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET/GOOGLE_OAUTH_REDIRECT_URI must all be set to start a Google sign-in."
      );
      res.status(500).json({ error: "Google login is not configured" });
      return;
    }

    const state = generateRandomToken();
    const nonce = generateRandomToken();
    const codeVerifier = generateRandomToken();
    const codeChallenge = computeCodeChallenge(codeVerifier);

    const cookieOptions = getGoogleOAuthTransientCookieOptions(req);
    res.cookie(GOOGLE_STATE_COOKIE, state, cookieOptions);
    res.cookie(GOOGLE_NONCE_COOKIE, nonce, cookieOptions);
    res.cookie(GOOGLE_PKCE_COOKIE, codeVerifier, cookieOptions);

    const authorizeUrl = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
    authorizeUrl.searchParams.set("client_id", ENV.googleClientId);
    authorizeUrl.searchParams.set("redirect_uri", ENV.googleRedirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("scope", GOOGLE_OAUTH_SCOPE);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("nonce", nonce);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    res.redirect(302, authorizeUrl.toString());
  });

  app.get("/api/auth/google/callback", async (req: Request, res: Response) => {
    if (ENV.authProvider !== "google") {
      res.status(404).end();
      return;
    }

    // Read every transient cookie up front, then always clear them exactly
    // once before this handler returns - on the error paths below AND on
    // success (see the end of the try block). A single-use attempt must
    // never be replayable, whether it succeeded or failed.
    const stateCookie = readCookie(req, GOOGLE_STATE_COOKIE);
    const nonceCookie = readCookie(req, GOOGLE_NONCE_COOKIE);
    const verifierCookie = readCookie(req, GOOGLE_PKCE_COOKIE);

    const fail = (status: number, error: string) => {
      clearGoogleOAuthCookies(req, res);
      res.status(status).json({ error });
    };

    // Google's `error` param is a short, fixed OAuth error CODE from a
    // known enum (RFC 6749 §4.1.2.1 - e.g. "access_denied",
    // "invalid_request", "unsupported_response_type") - safe to log as-is
    // (still length-capped below as a structural guard, never trusted to
    // stay short just because the spec says so). `error_description`,
    // by contrast, is free text Google (or, since this is an unauthenticated
    // GET query string, anyone crafting the redirect URL) can populate
    // with anything - this handler never reads it at all (not even into a
    // local variable) specifically so it can never end up in a log line,
    // a browser response, or anywhere else, now or after a future edit.
    // The browser only ever receives the fixed, generic message below -
    // never the provider's own error code or description.
    const providerError = getQueryParam(req, "error");
    if (providerError) {
      console.warn(`[GoogleOAuth] Google returned an authorization error: ${providerError.slice(0, 64)}`);
      fail(400, "Google sign-in was not completed");
      return;
    }

    const code = getQueryParam(req, "code");
    const stateParam = getQueryParam(req, "state");
    if (!code || !stateParam) {
      fail(400, "code and state are required");
      return;
    }

    if (!stateCookie) {
      fail(400, "Sign-in attempt has expired - please try again");
      return;
    }
    if (stateParam !== stateCookie) {
      fail(400, "Invalid sign-in state");
      return;
    }
    if (!nonceCookie || !verifierCookie) {
      fail(400, "Sign-in attempt has expired - please try again");
      return;
    }

    if (!isGoogleProviderConfigured()) {
      console.error(
        "[GoogleOAuth] ERROR: GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET/GOOGLE_OAUTH_REDIRECT_URI must all be set to complete a Google sign-in."
      );
      fail(500, "Google login is not configured");
      return;
    }

    try {
      const tokens = await googleOidc.exchangeCodeForTokens({ code, codeVerifier: verifierCookie });
      const claims = await googleOidc.verifyGoogleIdToken(tokens.idToken, nonceCookie);

      // Confirmed BEFORE any identity resolution, upsert, or session mint -
      // an outage here must never look like a successful login. Also
      // re-checked inside resolveGoogleIdentity itself (defense in depth,
      // matches the existing Manus callback's discipline in
      // server/_core/oauth.ts).
      await db.assertDatabaseAvailable();

      const resolution = await resolveGoogleIdentity({
        sub: claims.sub,
        email: claims.email,
        emailVerified: claims.emailVerified,
        name: claims.name,
      });

      if (resolution.outcome === "ambiguous_email") {
        // Multiple existing accounts already share this email - never
        // auto-link, never guess, never create a third account. No
        // details about which accounts or how many are ever sent to the
        // browser.
        console.warn("[GoogleOAuth] Refusing to sign in: multiple existing accounts share this Google account's email");
        fail(409, "Unable to sign in with Google for this account - please contact support");
        return;
      }

      // Uses the ipenovel session system exactly as-is: the resolved
      // user's own openId (never the Google ID token), the same
      // sdk.createSessionToken helper, the same COOKIE_NAME/SESSION_TTL_MS,
      // the same getSessionCookieOptions(req). No new session/JWT schema.
      const sessionToken = await sdk.createSessionToken(resolution.user.openId, {
        name: resolution.user.name,
        expiresInMs: SESSION_TTL_MS,
      });

      clearGoogleOAuthCookies(req, res);
      const sessionCookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...sessionCookieOptions, maxAge: SESSION_TTL_MS });
      res.redirect(302, "/");
    } catch (error) {
      // Sanitized: a token-exchange/verification failure here can carry
      // Google's raw response, the authorization code, or token material
      // in its message/cause - never logged raw. safeErrorSummary never
      // includes the code, ID token, access token, client secret, cookies,
      // or a raw Google response - only a short driver/HTTP-shaped summary.
      console.error("[GoogleOAuth] Callback failed:", safeErrorSummary(error));
      fail(500, "Google sign-in failed");
    }
  });
}
