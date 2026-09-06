import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const WORKSPACE_DOCS_SCOPES = [
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/documents.readonly",
] as const;
export const WORKSPACE_DOCS_SCOPE = WORKSPACE_DOCS_SCOPES.join(" ");
export const WORKSPACE_DOCS_CALLBACK_PATH = "/api/workspace/google/callback";
export const DOCS_NORMALIZATION_VERSION = 1 as const;

export function buildDocsAuthorizationUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  fixedRedirectUri: string;
  attempt: ReturnType<typeof createDocsConsentAttempt>;
}): string {
  const redirect = new URL(input.fixedRedirectUri);
  if (
    redirect.pathname !== WORKSPACE_DOCS_CALLBACK_PATH ||
    redirect.search ||
    redirect.hash
  ) {
    throw new Error("DOCS_REDIRECT_URI_NOT_FIXED");
  }
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set(
    "client_id",
    requireNonEmpty(input.clientId, "client_id")
  );
  url.searchParams.set("redirect_uri", input.fixedRedirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", input.attempt.scope);
  url.searchParams.set("state", input.attempt.state);
  url.searchParams.set("code_challenge", input.attempt.challenge);
  url.searchParams.set("code_challenge_method", input.attempt.challengeMethod);
  url.searchParams.set("access_type", input.attempt.accessType);
  url.searchParams.set("prompt", input.attempt.prompt);
  url.searchParams.set("include_granted_scopes", "true");
  return url.toString();
}

export function hasRequiredDocsScopes(grantedScopes: string): boolean {
  const granted = new Set(grantedScopes.split(/\s+/).filter(Boolean));
  return WORKSPACE_DOCS_SCOPES.every(scope => granted.has(scope));
}
export const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";
export type WorkspaceGoogleConnectionStatus =
  "active" | "reconnect_required" | "revoked";

export interface DocsMetadata {
  providerFileId: string;
  revision: string;
  mimeType: string;
  title: string;
  normalizedText: string;
  byteLength?: number;
}

export interface StoredGoogleCredential {
  encryptedRefreshToken: string;
  keyVersion: number;
}

export interface WorkspaceTokenCipher {
  encrypt(plaintext: string): StoredGoogleCredential;
  decrypt(credential: StoredGoogleCredential): string;
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("DOCS_INVALID_" + field.toUpperCase());
  return normalized;
}

export function normalizeDocsText(text: string): string {
  return text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(line => line.replace(/[\t ]+$/g, ""))
    .join("\n")
    .trim();
}

/** Returns identity and hashes only. Document body text never leaves this function. */
export function fingerprintDocsMetadata(metadata: DocsMetadata) {
  const providerFileId = requireNonEmpty(
    metadata.providerFileId,
    "provider_file_id"
  );
  const revision = requireNonEmpty(metadata.revision, "revision");
  const mimeType = requireNonEmpty(metadata.mimeType, "mime_type");
  if (mimeType !== GOOGLE_DOC_MIME_TYPE)
    throw new Error("DOCS_UNSUPPORTED_MIME_TYPE");
  const normalized = normalizeDocsText(metadata.normalizedText);
  const contentHash = createHash("sha256")
    .update("workspace-docs-v1\0" + normalized, "utf8")
    .digest("hex");
  return {
    providerFileId,
    revision,
    mimeType,
    title: metadata.title.trim(),
    normalizationVersion: DOCS_NORMALIZATION_VERSION,
    contentHash,
    byteLength:
      metadata.byteLength ?? Buffer.byteLength(metadata.normalizedText, "utf8"),
  };
}

export function createDocsConsentAttempt() {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  return {
    state,
    stateHash: createHash("sha256").update(state).digest("hex"),
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    challengeMethod: "S256" as const,
    scope: WORKSPACE_DOCS_SCOPE,
    accessType: "offline" as const,
    prompt: "consent" as const,
  };
}

export function verifyConsentState(
  expectedHash: string,
  presentedState: string
): boolean {
  if (!/^[a-f0-9]{64}$/i.test(expectedHash) || !presentedState) return false;
  const actual = createHash("sha256").update(presentedState).digest();
  const expected = Buffer.from(expectedHash, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createAesGcmTokenCipher(
  keys: ReadonlyMap<number, Buffer>,
  activeKeyVersion: number
): WorkspaceTokenCipher {
  const activeKey = keys.get(activeKeyVersion);
  if (!activeKey || activeKey.length !== 32)
    throw new Error("DOCS_TOKEN_KEY_UNAVAILABLE");
  return {
    encrypt(plaintext) {
      requireNonEmpty(plaintext, "refresh_token");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", activeKey, iv);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      return {
        keyVersion: activeKeyVersion,
        encryptedRefreshToken: [
          "v1",
          iv.toString("base64url"),
          cipher.getAuthTag().toString("base64url"),
          ciphertext.toString("base64url"),
        ].join("."),
      };
    },
    decrypt(credential) {
      const key = keys.get(credential.keyVersion);
      if (!key || key.length !== 32)
        throw new Error("DOCS_TOKEN_KEY_UNAVAILABLE");
      const [format, iv, tag, ciphertext] =
        credential.encryptedRefreshToken.split(".");
      if (format !== "v1" || !iv || !tag || !ciphertext)
        throw new Error("DOCS_TOKEN_CIPHERTEXT_INVALID");
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(iv, "base64url")
        );
        decipher.setAuthTag(Buffer.from(tag, "base64url"));
        return Buffer.concat([
          decipher.update(Buffer.from(ciphertext, "base64url")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new Error("DOCS_TOKEN_CIPHERTEXT_INVALID");
      }
    },
  };
}

export function rotateRefreshCredential(input: {
  current: StoredGoogleCredential;
  returnedRefreshToken?: string | null;
  cipher: WorkspaceTokenCipher;
}): StoredGoogleCredential {
  return input.returnedRefreshToken
    ? input.cipher.encrypt(input.returnedRefreshToken)
    : input.current;
}

export function canUseGoogleConnection(
  status: WorkspaceGoogleConnectionStatus
): boolean {
  return status === "active";
}

export interface WorkspaceDocsAdapter {
  getMetadata(input: { accessToken: string; providerFileId: string }): Promise<{
    providerFileId: string;
    revision: string;
    mimeType: string;
    title: string;
  }>;
  getNormalizedText(input: {
    accessToken: string;
    providerFileId: string;
  }): Promise<string>;
  revoke(input: { refreshToken: string }): Promise<void>;
}

export interface SnapshotRequest {
  connectionStatus: WorkspaceGoogleConnectionStatus;
  connectionOwnerUserId: number;
  actorUserId: number;
  providerFileId: string;
  accessToken: string;
}

export async function observeDocsSnapshot(
  request: SnapshotRequest,
  adapter: WorkspaceDocsAdapter
) {
  if (!canUseGoogleConnection(request.connectionStatus))
    throw new Error("DOCS_RECONNECT_REQUIRED");
  if (request.connectionOwnerUserId !== request.actorUserId)
    throw new Error("DOCS_CONNECTION_OWNERSHIP_REQUIRED");
  const providerFileId = requireNonEmpty(
    request.providerFileId,
    "provider_file_id"
  );
  const metadata = await adapter.getMetadata({
    accessToken: request.accessToken,
    providerFileId,
  });
  if (metadata.providerFileId !== providerFileId)
    throw new Error("DOCS_PROVIDER_ID_MISMATCH");
  if (metadata.mimeType !== GOOGLE_DOC_MIME_TYPE)
    throw new Error("DOCS_UNSUPPORTED_MIME_TYPE");
  const normalizedText = await adapter.getNormalizedText({
    accessToken: request.accessToken,
    providerFileId,
  });
  return fingerprintDocsMetadata({ ...metadata, normalizedText });
}

export async function revokeDocsConnection(input: {
  credential: StoredGoogleCredential;
  cipher: WorkspaceTokenCipher;
  adapter: WorkspaceDocsAdapter;
}) {
  const refreshToken = input.cipher.decrypt(input.credential);
  let providerRevocationSucceeded = true;
  try {
    await input.adapter.revoke({ refreshToken });
  } catch {
    providerRevocationSucceeded = false;
  }
  return {
    status: "revoked" as const,
    encryptedRefreshToken: null,
    revokedAt: new Date(),
    providerRevocationSucceeded,
  };
}
