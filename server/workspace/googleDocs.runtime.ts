import { createAesGcmTokenCipher, WORKSPACE_DOCS_CALLBACK_PATH } from "./googleDocs.domain";

const TOKEN_KEY_VERSION = 1;

function required(name: string, value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required for Workspace Google Docs.`);
  return normalized;
}

export function workspaceGoogleDocsTokenCipher() {
  const raw = required(
    "WORKSPACE_GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY",
    process.env.WORKSPACE_GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY
  );
  const key = /^[a-f0-9]{64}$/i.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      "WORKSPACE_GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY must decode to 32 bytes."
    );
  }
  return createAesGcmTokenCipher(new Map([[TOKEN_KEY_VERSION, key]]), TOKEN_KEY_VERSION);
}

export function workspaceGoogleDocsOAuthClientCredentials() {
  return {
    clientId: required("GOOGLE_OAUTH_CLIENT_ID", process.env.GOOGLE_OAUTH_CLIENT_ID),
    clientSecret: required(
      "GOOGLE_OAUTH_CLIENT_SECRET",
      process.env.GOOGLE_OAUTH_CLIENT_SECRET
    ),
  };
}

export function workspaceGoogleDocsOAuthConfig() {
  const redirectUri = required(
    "WORKSPACE_GOOGLE_DOCS_REDIRECT_URI",
    process.env.WORKSPACE_GOOGLE_DOCS_REDIRECT_URI
  );
  const parsed = new URL(redirectUri);
  const deployment = process.env.DEPLOYMENT_ENVIRONMENT?.trim().toLowerCase();
  const expectedOrigin =
    deployment === "production"
      ? "https://ipenovel.com"
      : deployment === "production-staging"
        ? "https://production-staging.ipenovel.com"
        : null;
  if (
    parsed.pathname !== WORKSPACE_DOCS_CALLBACK_PATH ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== "https:" &&
      !(process.env.NODE_ENV !== "production" && parsed.protocol === "http:")) ||
    (expectedOrigin !== null && parsed.origin !== expectedOrigin)
  ) {
    throw new Error(
      `WORKSPACE_GOOGLE_DOCS_REDIRECT_URI must be an explicit ${WORKSPACE_DOCS_CALLBACK_PATH} URL for this environment.`
    );
  }
  return {
    ...workspaceGoogleDocsOAuthClientCredentials(),
    redirectUri,
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    userInfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
  };
}
