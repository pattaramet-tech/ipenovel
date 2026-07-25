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
};

export const OCR_SETTINGS_KEY = "ocr_enabled";
