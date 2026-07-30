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
  // Feature flag selecting which login provider server-side auth routes
  // are active for (server/_core/googleOAuth.ts, server/_core/oauth.ts).
  // Defaults to "manus" - the ONLY two recognized values are "manus" and
  // "google"; anything else (unset, typo, empty string) also resolves to
  // "manus" so existing production behavior can never change just because
  // this variable is missing or misconfigured. The client has its own,
  // independently-set VITE_AUTH_PROVIDER (see client/src/const.ts) - the
  // two are never derived from each other, so a deploy that forgets to set
  // one of them fails closed to Manus rather than silently mixing flows.
  authProvider: (process.env.AUTH_PROVIDER ?? "").trim().toLowerCase() === "google" ? "google" : "manus",
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

export const OCR_SETTINGS_KEY = "ocr_enabled";
