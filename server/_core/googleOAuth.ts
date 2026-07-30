import { createHash, randomBytes } from "node:crypto";
import { COOKIE_NAME, SESSION_TTL_MS } from "@shared/const";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { isAnonymousCredentialError } from "./authErrors";
import { safeErrorSummary } from "../../scripts/lib/safeErrorSummary.mjs";
import { connectGoogleIdentityToUser, resolveGoogleIdentity } from "../services/googleIdentityService";
import { getGoogleOAuthTransientCookieOptions, getSessionCookieOptions, readCookie } from "./cookies";
import { ENV, isGoogleAuthActive } from "./env";
import * as googleOidc from "./googleOidc";
import { sdk } from "./sdk";

// Direct Google OpenID Connect login/connect - the AUTH_PROVIDER=google and
// AUTH_PROVIDER=transition counterpart to server/_core/oauth.ts's Manus
// /api/oauth/callback. Registered unconditionally (see
// server/_core/index.ts), but every route below fails closed with a plain
// 404 unless isGoogleAuthActive() (AUTH_PROVIDER is exactly "google" or
// "transition"), so with the flag at its default ("manus") these routes
// are indistinguishable from not existing at all - existing production
// behavior cannot change just because this file was deployed.
//
// Two distinct flows share the same callback (/api/auth/google/callback),
// distinguished by a short-lived "intent" cookie set at whichever start
// route began the attempt:
//   - /api/auth/google/start           (intent=login)   - sign in, may
//     create a new user (see resolveGoogleIdentity) or auto-link an
//     existing account by verified email.
//   - /api/auth/google/connect/start   (intent=connect) - link a Google
//     identity onto the CURRENTLY signed-in user (see
//     connectGoogleIdentityToUser). Requires an existing, valid session
//     before it will even redirect to Google. Never creates a user, never
//     changes users.id/openId, never mints a new session cookie (the
//     caller's existing session is already valid).
// The callback re-derives which flow to run from the intent cookie alone -
// never from a query string, never from anything client-supplied beyond
// that one cookie, and never from a userId smuggled anywhere - the
// connect intent re-authenticates the current session from scratch via
// sdk.authenticateRequest(req), the exact same helper every tRPC
// protectedProcedure relies on.

const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_OAUTH_SCOPE = "openid email profile";

export const GOOGLE_STATE_COOKIE = "google_oauth_state";
export const GOOGLE_NONCE_COOKIE = "google_oauth_nonce";
export const GOOGLE_PKCE_COOKIE = "google_oauth_code_verifier";
export const GOOGLE_INTENT_COOKIE = "google_oauth_intent";
const GOOGLE_TRANSIENT_COOKIES = [GOOGLE_STATE_COOKIE, GOOGLE_NONCE_COOKIE, GOOGLE_PKCE_COOKIE, GOOGLE_INTENT_COOKIE];

/** Where the connect flow sends the browser back to, success or failure - a fixed, non-configurable path, never derived from any request input. See ACCOUNT_PAGE_STATUS_PARAM below for the (deliberately minimal) status signal. */
const ACCOUNT_PAGE_PATH = "/profile";
const ACCOUNT_PAGE_STATUS_PARAM = "googleConnect";

type OAuthIntent = "login" | "connect";

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

/**
 * Shared by both start routes - generates state/nonce/PKCE, cookies them
 * (including the intent, so the callback knows which flow to run without
 * trusting anything else client-supplied), and redirects to Google. The
 * only difference between /start and /connect/start is which `intent` is
 * passed in and the extra session check /connect/start does first (see
 * registerGoogleOAuthRoutes below) - everything about the actual
 * authorization redirect is identical, so there is exactly one place that
 * builds it.
 */
function beginGoogleAuthorizationRedirect(req: Request, res: Response, intent: OAuthIntent): void {
  const state = generateRandomToken();
  const nonce = generateRandomToken();
  const codeVerifier = generateRandomToken();
  const codeChallenge = computeCodeChallenge(codeVerifier);

  const cookieOptions = getGoogleOAuthTransientCookieOptions(req);
  res.cookie(GOOGLE_STATE_COOKIE, state, cookieOptions);
  res.cookie(GOOGLE_NONCE_COOKIE, nonce, cookieOptions);
  res.cookie(GOOGLE_PKCE_COOKIE, codeVerifier, cookieOptions);
  res.cookie(GOOGLE_INTENT_COOKIE, intent, cookieOptions);

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
}

export function registerGoogleOAuthRoutes(app: Express) {
  app.get("/api/auth/google/start", (req: Request, res: Response) => {
    if (!isGoogleAuthActive()) {
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

    beginGoogleAuthorizationRedirect(req, res, "login");
  });

  app.get("/api/auth/google/connect/start", async (req: Request, res: Response) => {
    if (!isGoogleAuthActive()) {
      res.status(404).end();
      return;
    }
    if (!isGoogleProviderConfigured()) {
      console.error(
        "[GoogleOAuth] ERROR: GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET/GOOGLE_OAUTH_REDIRECT_URI must all be set to connect a Google account."
      );
      res.status(500).json({ error: "Google login is not configured" });
      return;
    }

    // Requires an existing, valid session BEFORE redirecting to Google at
    // all - reuses sdk.authenticateRequest, the exact same session
    // verification every tRPC protectedProcedure relies on (cookie
    // parse -> JWT verify -> DB user lookup). An anonymous/invalid session
    // is rejected safely here; any OTHER error (e.g. the database being
    // down) is an infrastructure failure, not "not logged in", and must
    // propagate as a real error rather than being silently treated as an
    // auth rejection - matching the discipline authErrors.ts documents for
    // every other caller of authenticateRequest.
    try {
      await sdk.authenticateRequest(req);
    } catch (error) {
      if (isAnonymousCredentialError(error)) {
        res.status(401).json({ error: "Sign in before connecting a Google account" });
        return;
      }
      console.error("[GoogleOAuth] connect/start session check failed:", safeErrorSummary(error));
      res.status(500).json({ error: "Unable to start Google account connection" });
      return;
    }

    beginGoogleAuthorizationRedirect(req, res, "connect");
  });

  app.get("/api/auth/google/callback", async (req: Request, res: Response) => {
    if (!isGoogleAuthActive()) {
      res.status(404).end();
      return;
    }

    // Read every transient cookie up front, then always clear them exactly
    // once before this handler returns - on the error paths below AND on
    // success (see the end of each branch). A single-use attempt must
    // never be replayable, whether it succeeded or failed.
    const stateCookie = readCookie(req, GOOGLE_STATE_COOKIE);
    const nonceCookie = readCookie(req, GOOGLE_NONCE_COOKIE);
    const verifierCookie = readCookie(req, GOOGLE_PKCE_COOKIE);
    const intentCookie = readCookie(req, GOOGLE_INTENT_COOKIE);

    const failLogin = (status: number, error: string) => {
      clearGoogleOAuthCookies(req, res);
      res.status(status).json({ error });
    };

    const redirectToAccountPage = (status: "success" | "error") => {
      clearGoogleOAuthCookies(req, res);
      const url = new URL(ACCOUNT_PAGE_PATH, "http://internal.invalid");
      url.searchParams.set(ACCOUNT_PAGE_STATUS_PARAM, status);
      res.redirect(302, url.pathname + url.search);
    };

    // Both `error` and `error_description` are attacker/user-influenced
    // input - this is an unauthenticated GET query string, so anyone can
    // craft a redirect URL with arbitrary content in either param
    // (including newlines/control characters, not just "unexpectedly long
    // text"). Neither is ever interpolated into a log line or read into a
    // variable here (error_description isn't read at all - the literal
    // string "error_description" does not appear anywhere in this file).
    // The log line and the browser response are both fixed, constant
    // strings - never a substring, a slice, or any other derivative of
    // the query string, so there is no length/content of that input that
    // can ever change what gets logged or returned.
    const providerError = getQueryParam(req, "error");
    if (providerError) {
      console.warn("[GoogleOAuth] Google authorization was not completed");
      if (intentCookie === "connect") {
        redirectToAccountPage("error");
      } else {
        failLogin(400, "Google sign-in was not completed");
      }
      return;
    }

    const code = getQueryParam(req, "code");
    const stateParam = getQueryParam(req, "state");
    if (!code || !stateParam) {
      failLogin(400, "code and state are required");
      return;
    }

    if (!stateCookie) {
      failLogin(400, "Sign-in attempt has expired - please try again");
      return;
    }
    if (stateParam !== stateCookie) {
      failLogin(400, "Invalid sign-in state");
      return;
    }
    if (!nonceCookie || !verifierCookie) {
      failLogin(400, "Sign-in attempt has expired - please try again");
      return;
    }

    // Intent must be exactly one of the two known literals - anything
    // else (missing cookie, expired, tampered) fails closed as an
    // ordinary login attempt gone stale, never silently assumed to be
    // either flow.
    const intent: OAuthIntent | null = intentCookie === "login" || intentCookie === "connect" ? intentCookie : null;
    if (!intent) {
      failLogin(400, "Sign-in attempt has expired - please try again");
      return;
    }

    if (!isGoogleProviderConfigured()) {
      console.error(
        "[GoogleOAuth] ERROR: GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET/GOOGLE_OAUTH_REDIRECT_URI must all be set to complete a Google sign-in."
      );
      if (intent === "connect") {
        redirectToAccountPage("error");
      } else {
        failLogin(500, "Google login is not configured");
      }
      return;
    }

    if (intent === "connect") {
      await handleConnectCallback(req, res, { code, verifierCookie, nonceCookie, redirectToAccountPage });
      return;
    }

    await handleLoginCallback(req, res, { code, verifierCookie, nonceCookie, failLogin, clearGoogleOAuthCookies });
  });
}

type LoginCallbackDeps = {
  code: string;
  verifierCookie: string;
  nonceCookie: string;
  failLogin: (status: number, error: string) => void;
  clearGoogleOAuthCookies: (req: Request, res: Response) => void;
};

async function handleLoginCallback(req: Request, res: Response, deps: LoginCallbackDeps): Promise<void> {
  const { code, verifierCookie, nonceCookie, failLogin } = deps;
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
      failLogin(409, "Unable to sign in with Google for this account - please contact support");
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
    failLogin(500, "Google sign-in failed");
  }
}

type ConnectCallbackDeps = {
  code: string;
  verifierCookie: string;
  nonceCookie: string;
  redirectToAccountPage: (status: "success" | "error") => void;
};

async function handleConnectCallback(req: Request, res: Response, deps: ConnectCallbackDeps): Promise<void> {
  const { code, verifierCookie, nonceCookie, redirectToAccountPage } = deps;
  try {
    // Re-verify the session from scratch - the one from /connect/start
    // may have expired, been logged out elsewhere, or simply be a
    // different browser/tab by the time Google redirects back. Never
    // trust anything cached from the start request. userId comes ONLY
    // from this re-verified session - never a query string, never a
    // cookie value of its own, never anything client-supplied.
    const currentUser = await sdk.authenticateRequest(req);

    const tokens = await googleOidc.exchangeCodeForTokens({ code, codeVerifier: verifierCookie });
    const claims = await googleOidc.verifyGoogleIdToken(tokens.idToken, nonceCookie);

    await db.assertDatabaseAvailable();
    const database = await db.getDb();
    if (!database) {
      throw new Error("[GoogleOAuth] Database is not available");
    }

    const result = await connectGoogleIdentityToUser(database, {
      userId: currentUser.id,
      sub: claims.sub,
      email: claims.email,
      emailVerified: claims.emailVerified,
    });

    if (result.outcome === "connected" || result.outcome === "already_connected") {
      // No new session is minted - the current session was already valid
      // and is left completely untouched.
      redirectToAccountPage("success");
      return;
    }

    // Conflict cases (sub belongs to someone else / this user already has
    // a different Google identity) - fail closed, no details leaked to
    // the browser beyond a generic error status.
    console.warn(`[GoogleOAuth] Google account connect refused: ${result.outcome}`);
    redirectToAccountPage("error");
  } catch (error) {
    if (isAnonymousCredentialError(error)) {
      // Session expired/invalidated between /connect/start and this
      // callback - fail closed, no session is minted (there was never a
      // login flow here to mint one from), just report the failure.
      redirectToAccountPage("error");
      return;
    }
    console.error("[GoogleOAuth] Connect callback failed:", safeErrorSummary(error));
    redirectToAccountPage("error");
  }
}
