import { AXIOS_TIMEOUT_MS } from "@shared/const";
import axios from "axios";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { ENV } from "./env";

// Low-level Google OpenID Connect client - the direct-Google counterpart to
// server/_core/sdk.ts's OAuthService, but talking to Google's own token/JWKS
// endpoints instead of Manus's. Kept deliberately separate from sdk.ts: this
// module knows nothing about ipenovel sessions/cookies/users, only how to
// exchange an authorization code for an ID token and verify that token -
// see server/_core/googleOAuth.ts for the route handlers that use this, and
// server/services/googleIdentityService.ts for what happens with the
// verified claims.

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
// Google's ID tokens use either form interchangeably across documentation
// examples and real-world tokens observed in the wild - both are accepted.
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export type GoogleTokenResponse = {
  idToken: string;
};

export type GoogleIdTokenClaims = {
  sub: string;
  email: string;
  emailVerified: true;
  name: string | null;
  picture: string | null;
};

/**
 * Exchanges an authorization code (plus its PKCE code_verifier) for tokens
 * at Google's token endpoint. Per this feature's explicit scope, only the
 * ID token is extracted and returned - access_token/refresh_token are
 * discarded immediately (never stored, never logged, never returned from
 * this function) since nothing in this codebase calls the Google API on
 * the user's behalf.
 *
 * redirect_uri here MUST be byte-identical to the one sent at
 * /api/auth/google/start (both are ENV.googleRedirectUri, read verbatim
 * from GOOGLE_OAUTH_REDIRECT_URI - never derived from a request header) -
 * Google's token endpoint rejects the exchange otherwise.
 */
export async function exchangeCodeForTokens(params: {
  code: string;
  codeVerifier: string;
}): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    code: params.code,
    client_id: ENV.googleClientId,
    client_secret: ENV.googleClientSecret,
    redirect_uri: ENV.googleRedirectUri,
    grant_type: "authorization_code",
    code_verifier: params.codeVerifier,
  });

  const { data } = await axios.post(GOOGLE_TOKEN_ENDPOINT, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: AXIOS_TIMEOUT_MS,
  });

  const idToken = data?.id_token;
  if (typeof idToken !== "string" || idToken.length === 0) {
    throw new Error("[GoogleOidc] Token response did not include an id_token");
  }

  return { idToken };
}

let cachedRemoteJwks: JWTVerifyGetKey | null = null;
function getRemoteGoogleJwks(): JWTVerifyGetKey {
  if (!cachedRemoteJwks) {
    cachedRemoteJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  }
  return cachedRemoteJwks;
}

/**
 * Verifies a Google ID token and returns its claims, or throws. Every check
 * required by this feature's spec is enforced here, in this order:
 *
 *  1. signature (via `getKey` - real RS256 verification against Google's
 *     published JWKS in production; tests inject a local JWKS instead, see
 *     options.getKey below - never network access from a unit test)
 *  2. issuer (must be one of GOOGLE_ISSUERS)
 *  3. audience (must equal ENV.googleClientId - read fresh on every call,
 *     never cached at module load, so it can never mismatch a
 *     since-rotated client id)
 *  4. expiration (jose's jwtVerify rejects an expired token on its own)
 *  5. nonce (must equal `expectedNonce`, the value this app generated and
 *     cookied at /api/auth/google/start)
 *  6. sub (must be a non-empty string)
 *  7. email (must be a non-empty string)
 *  8. email_verified (must be exactly boolean `true` - Google can send this
 *     as a string "true" for some token shapes; only the strict boolean is
 *     accepted, so an ambiguous/falsy value fails closed, never login)
 *
 * `options.getKey` defaults to Google's real remote JWKS
 * (`createRemoteJWKSet`, cached across calls) - injectable purely so unit
 * tests can pass a local JWKS built from a test-generated keypair and
 * exercise REAL signature verification without any network access. Never
 * used to bypass a check in production - there is no production code path
 * that supplies anything other than the default.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  expectedNonce: string,
  options: { getKey?: JWTVerifyGetKey } = {}
): Promise<GoogleIdTokenClaims> {
  const getKey = options.getKey ?? getRemoteGoogleJwks();

  const { payload } = await jwtVerify(idToken, getKey, {
    issuer: GOOGLE_ISSUERS,
    audience: ENV.googleClientId,
  });

  if (typeof payload.nonce !== "string" || payload.nonce.length === 0 || payload.nonce !== expectedNonce) {
    throw new Error("[GoogleOidc] ID token nonce does not match this sign-in attempt");
  }

  const sub = payload.sub;
  if (typeof sub !== "string" || sub.length === 0) {
    throw new Error("[GoogleOidc] ID token is missing a usable sub claim");
  }

  const email = (payload as Record<string, unknown>).email;
  if (typeof email !== "string" || email.length === 0) {
    throw new Error("[GoogleOidc] ID token is missing a usable email claim");
  }

  if ((payload as Record<string, unknown>).email_verified !== true) {
    throw new Error("[GoogleOidc] ID token's email is not verified (email_verified !== true)");
  }

  const rawName = (payload as Record<string, unknown>).name;
  const name = typeof rawName === "string" && rawName.trim().length > 0 ? rawName.trim() : null;

  const rawPicture = (payload as Record<string, unknown>).picture;
  const picture = typeof rawPicture === "string" && rawPicture.trim().length > 0 ? rawPicture.trim() : null;

  return { sub, email, emailVerified: true, name, picture };
}
