export type AuthProviderMode = "manus" | "google" | "transition";

/**
 * EXACT-LITERAL resolution ONLY - deliberately no .trim(), no
 * .toLowerCase()/.toUpperCase(), no whitespace stripping of any kind.
 * "GOOGLE", "Google", " google", "google ", "Transition", " transition"
 * are NOT accepted - every one of them resolves to "manus", the exact same
 * fallback as unset/empty/a genuine typo. This is a deliberate hardening
 * over an earlier version of this function that normalized case/whitespace
 * before comparing - that normalization meant a value most people would
 * assume is "obviously google" (e.g. a config UI that title-cases values,
 * or a trailing newline from a copy-paste) silently activated the Google
 * flow. Exact-literal matching removes that entire class of surprise: the
 * only way to opt in is to set the variable to precisely "google" or
 * precisely "transition", byte for byte.
 *
 * A plain, exported, non-module-scoped function (not read from
 * process.env internally) specifically so it is directly unit-testable
 * with arbitrary inputs, with no module reload / process.env stubbing
 * required - see server/_core/env.test.ts.
 */
export function resolveAuthProviderMode(raw: string | undefined): AuthProviderMode {
  if (raw === "google") return "google";
  if (raw === "transition") return "transition";
  return "manus";
}

/**
 * EXACT-LITERAL "true" only - never "TRUE"/"True"/" true"/"true " and
 * never any other truthy-looking string. Every other value, including an
 * empty string or unset, resolves to false. Mirrors
 * resolveAuthProviderMode's discipline for the same reason: a
 * migration-forcing flag is exactly the kind of setting that must never
 * activate itself by accident from a stray whitespace character or a
 * config UI's own casing convention.
 */
export function resolveRequireGoogleConnection(raw: string | undefined): boolean {
  return raw === "true";
}

const STRICT_ISO_8601_UTC_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

/**
 * Strict ISO-8601 UTC timestamp only (e.g. "2026-08-01T00:00:00Z", with an
 * optional fractional-seconds component) - matches the exact example format
 * given for AUTH_FORCE_RELOGIN_AFTER. Returns the cutoff as whole epoch
 * seconds (matching a JWT `iat` claim's units), or `null` if the value is
 * empty/unset OR doesn't match the required strict format OR names a
 * calendar date/time that does not actually exist.
 *
 * Deliberately does NOT rely on `Date.parse()`/`new Date(string)` alone to
 * decide validity - both silently NORMALIZE an out-of-range component
 * instead of rejecting it (e.g. "2026-02-30T00:00:00Z" quietly becomes
 * March 2, "...T24:00:00Z" quietly becomes the next day at midnight), which
 * would make a fat-fingered date resolve to a DIFFERENT real cutoff instead
 * of failing closed to disabled. Instead: the regex only constrains the
 * SHAPE (digit counts), each component is parsed as a plain integer, a
 * candidate UTC instant is built with `Date.UTC`, and every component is
 * then read back and compared against the input - if `Date.UTC` had to
 * normalize anything (a nonexistent date, `hour: 24`, `minute`/`second: 60`,
 * ...), at least one read-back component will not match what was typed, and
 * this returns `null`. (The year is shifted by +400 purely for this
 * round-trip comparison, then discarded - `Date.UTC`/`new Date(y, ...)`
 * special-case a bare 0-99 year as 1900+y, which would otherwise make this
 * check itself misfire for an unusual but literally-4-digit year like
 * "0099"; +400 is a full Gregorian leap-year cycle, so it never changes
 * which dates are valid.)
 *
 * `null` means "the forced-relogin cutoff is DISABLED" - this is the ONLY
 * safe behavior for an invalid/malformed/nonexistent value. This function
 * must never resolve an invalid value to a cutoff that would force EVERY
 * existing session to re-login (e.g. epoch 0, or "now") - that would turn a
 * typo in an environment variable into an accidental mass-logout of the
 * entire user base, which is exactly the failure mode this deliberately
 * fails closed (to "disabled"), not open, against.
 */
export function resolveForceReloginCutoffSeconds(raw: string | undefined): number | null {
  if (!raw) return null;

  const match = STRICT_ISO_8601_UTC_PATTERN.exec(raw);
  if (!match) return null;

  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr, fractionStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const second = Number(secondStr);
  // Date.UTC's ms parameter is whole milliseconds only - pad/truncate any
  // fractional-seconds digits to exactly 3 (e.g. ".5" -> 500ms, ".123456"
  // -> 123ms, sub-millisecond precision is simply not representable).
  const milliseconds = fractionStr ? Number(fractionStr.padEnd(3, "0").slice(0, 3)) : 0;

  const yearForRoundTrip = year + 400;
  const candidateMs = Date.UTC(yearForRoundTrip, month - 1, day, hour, minute, second, milliseconds);
  const roundTrip = new Date(candidateMs);
  const roundTripMatches =
    roundTrip.getUTCFullYear() === yearForRoundTrip &&
    roundTrip.getUTCMonth() === month - 1 &&
    roundTrip.getUTCDate() === day &&
    roundTrip.getUTCHours() === hour &&
    roundTrip.getUTCMinutes() === minute &&
    roundTrip.getUTCSeconds() === second &&
    roundTrip.getUTCMilliseconds() === milliseconds;
  if (!roundTripMatches) return null;

  const realMs = Date.UTC(year, month - 1, day, hour, minute, second, milliseconds);
  return Math.floor(realMs / 1000);
}

export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  ocrEnabled: process.env.OCR_ENABLED !== "false",
  // Cloudflare R2 - used only by server/services/r2Storage.ts for newly
  // uploaded novel covers/banners (see uploadCover/uploadImage in
  // routers.ts). Never read eagerly at module load - only checked when an
  // upload actually happens, so a missing/incomplete R2 config never breaks
  // any other page or endpoint.
  r2AccountId: process.env.R2_ACCOUNT_ID ?? "",
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
  r2BucketName: process.env.R2_BUCKET_NAME ?? "",
  r2PublicBaseUrl: process.env.R2_PUBLIC_BASE_URL ?? "",
  r2Endpoint: process.env.R2_ENDPOINT ?? "",
  // Cloudflare R2 - PRIVATE bucket, used only by
  // server/services/r2PrivateStorage.ts for payment slips and paid episode
  // files (never a public base URL - objects are only ever reachable via a
  // short-lived presigned GetObject URL generated on demand). Same
  // lazy-read-only-on-use discipline as the public r2* vars above.
  r2PrivateAccountId: process.env.R2_PRIVATE_ACCOUNT_ID ?? "",
  r2PrivateAccessKeyId: process.env.R2_PRIVATE_ACCESS_KEY_ID ?? "",
  r2PrivateSecretAccessKey: process.env.R2_PRIVATE_SECRET_ACCESS_KEY ?? "",
  r2PrivateEndpoint: process.env.R2_PRIVATE_ENDPOINT ?? "",
  r2PrivateBucketName: process.env.R2_PRIVATE_BUCKET_NAME ?? "",
  r2PrivateSignedUrlExpiresSeconds:
    Number(process.env.R2_PRIVATE_SIGNED_URL_EXPIRES_SECONDS) > 0
      ? Number(process.env.R2_PRIVATE_SIGNED_URL_EXPIRES_SECONDS)
      : 900,
  // Canonical domain redirect - see server/_core/canonicalDomainRedirect.ts.
  // LEGACY_REDIRECT_HOSTS is comma-separated; only hosts added here are ever
  // redirected, so e.g. www.ipenovel.com should only be added once its DNS/
  // domain verification has actually gone through.
  canonicalHost: process.env.CANONICAL_HOST ?? "ipenovel.com",
  legacyRedirectHosts: process.env.LEGACY_REDIRECT_HOSTS ?? "ipenovelz.manus.space",
  // Feature flag selecting which login provider(s) server-side auth routes
  // are active for (server/_core/googleOAuth.ts, server/_core/oauth.ts).
  // Defaults to "manus" - the ONLY three recognized values are "manus",
  // "google", and "transition"; anything else (unset, typo, empty string)
  // also resolves to "manus" so existing production behavior can never
  // change just because this variable is missing or misconfigured.
  // "transition" is NOT a fourth, separate mode with its own routes - it
  // deliberately runs BOTH the Manus and Google server-side flows
  // simultaneously (see isManusAuthActive/isGoogleAuthActive below), for
  // the migration window where existing Manus users need to keep signing
  // in the old way while new/converting users can use Google, including
  // linking a Google identity onto an existing Manus-created account (see
  // server/services/googleIdentityService.ts's connectGoogleIdentityToUser
  // and /api/auth/google/connect/start). This is an intentional,
  // explicitly-requested exception to "the server only ever runs one
  // provider" - it does NOT mean an accidental/unintended mixed mode: the
  // three-way exact-literal match below is the only way to reach it. The
  // client has its own, independently-set VITE_AUTH_PROVIDER (see
  // client/src/const.ts) - the two are never derived from each other, so a
  // deploy that forgets to set one of them fails closed to Manus rather
  // than silently mixing flows.
  authProvider: resolveAuthProviderMode(process.env.AUTH_PROVIDER),
  // Mandatory Google-migration gate (feature-flagged, only meaningful
  // together with AUTH_PROVIDER=transition - see isGoogleConnectionMandatory
  // below). AUTH_REQUIRE_GOOGLE_CONNECTION opts a signed-in, non-admin user
  // out of every "business action" tRPC procedure (server/_core/trpc.ts's
  // protectedProcedure) until they explicitly connect a Google identity -
  // see server/_core/googleMigrationGate.ts. Exact-literal "true" only.
  requireGoogleConnection: resolveRequireGoogleConnection(process.env.AUTH_REQUIRE_GOOGLE_CONNECTION),
  // Forces every session ISSUED BEFORE this UTC timestamp to be rejected
  // (AnonymousCredentialError, cookie cleared) the next time it's used -
  // see server/_core/sdk.ts's authenticateRequest/isSessionIssuedBeforeCutoff.
  // Never applies to a local admin session (openId "admin-*"). `null` when
  // unset or invalid - see resolveForceReloginCutoffSeconds's docstring for
  // why an invalid value must disable this, never force a mass logout.
  forceReloginAfterSeconds: resolveForceReloginCutoffSeconds(process.env.AUTH_FORCE_RELOGIN_AFTER),
  // Google OpenID Connect (direct, feature-flagged) - see
  // server/_core/googleOAuth.ts and server/_core/googleOidc.ts. Deliberately
  // NOT eagerly validated here (same lazy-checked-only-on-use discipline as
  // the R2_PRIVATE_* vars above) - googleOAuth.ts's routes check these are
  // all present before doing anything, so an unconfigured/partially
  // configured Google login fails closed with a clear error instead of a
  // confusing crash, and never affects any other route.
  googleClientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
  // Must be read verbatim from the environment, never derived from the
  // request's Host or X-Forwarded-Host header - those are client-influenced
  // and Google's token endpoint requires the redirect_uri sent at token
  // exchange to exactly match what was registered in Google Cloud Console,
  // so deriving it from a spoofable header would both break real requests
  // behind a proxy that alters the header and open an open-redirect-style
  // surface at the OAuth layer.
  googleRedirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI ?? "",
};

/**
 * Whether the Manus OAuth callback (server/_core/oauth.ts's
 * /api/oauth/callback) should be reachable. Active in "manus" (the whole
 * point) and "transition" (existing Manus users must keep being able to
 * sign in the old way during the migration window) - only "google" turns
 * it off, since that mode is a full cutover.
 */
export function isManusAuthActive(): boolean {
  return ENV.authProvider === "manus" || ENV.authProvider === "transition";
}

/**
 * Whether the Google OpenID Connect routes (server/_core/googleOAuth.ts's
 * /api/auth/google/start, /callback, and /connect/start) should be
 * reachable. Active in "google" (the whole point) and "transition" (new
 * logins and existing-account linking both need Google available
 * alongside Manus) - only "manus" turns it off.
 */
export function isGoogleAuthActive(): boolean {
  return ENV.authProvider === "google" || ENV.authProvider === "transition";
}

/**
 * Whether a signed-in, non-admin user must have a connected Google identity
 * before they can use any "business action" tRPC procedure (see
 * server/_core/googleMigrationGate.ts, which is what actually enforces
 * this - this function is only the single source of truth for WHETHER the
 * gate is active, never the enforcement itself). True only when BOTH
 * AUTH_PROVIDER is exactly "transition" AND AUTH_REQUIRE_GOOGLE_CONNECTION
 * is exactly "true" - AUTH_REQUIRE_GOOGLE_CONNECTION alone (e.g. left set
 * to "true" after flipping AUTH_PROVIDER to "google" or back to "manus")
 * must never activate this gate outside the transition migration window.
 */
export function isGoogleConnectionMandatory(): boolean {
  return ENV.authProvider === "transition" && ENV.requireGoogleConnection === true;
}

export const OCR_SETTINGS_KEY = "ocr_enabled";
