import { describe, expect, it, vi } from "vitest";
import {
  buildDocsAuthorizationUrl,
  canUseGoogleConnection,
  createAesGcmTokenCipher,
  createDocsConsentAttempt,
  fingerprintDocsMetadata,
  GOOGLE_DOC_MIME_TYPE,
  hasRequiredDocsScopes,
  normalizeDocsText,
  observeDocsSnapshot,
  revokeDocsConnection,
  rotateRefreshCredential,
  verifyConsentState,
  WORKSPACE_DOCS_SCOPE,
} from "./googleDocs.domain";

describe("Workspace Docs M02 domain contract", () => {
  it("uses a separate least-privilege Docs scope and PKCE attempt", () => {
    const attempt = createDocsConsentAttempt();
    expect(attempt.scope).toBe(WORKSPACE_DOCS_SCOPE);
    expect(attempt.scope).toContain("drive.metadata.readonly");
    expect(attempt.scope).toContain("documents.readonly");
    expect(attempt.state).not.toBe(attempt.verifier);
    expect(attempt.challenge).not.toBe(attempt.verifier);
    expect(attempt.challengeMethod).toBe("S256");
    expect(verifyConsentState(attempt.stateHash, attempt.state)).toBe(true);
    expect(verifyConsentState(attempt.stateHash, attempt.state + "x")).toBe(
      false
    );
  });

  it("builds only the fixed incremental callback and validates returned scopes", () => {
    const attempt = createDocsConsentAttempt();
    const url = new URL(
      buildDocsAuthorizationUrl({
        authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        clientId: "workspace-client",
        fixedRedirectUri: "https://ipenovel.test/api/workspace/google/callback",
        attempt,
      })
    );
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://ipenovel.test/api/workspace/google/callback"
    );
    expect(url.searchParams.get("scope")).toBe(WORKSPACE_DOCS_SCOPE);
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(hasRequiredDocsScopes(WORKSPACE_DOCS_SCOPE)).toBe(true);
    expect(
      hasRequiredDocsScopes(
        "https://www.googleapis.com/auth/documents.readonly"
      )
    ).toBe(false);
    expect(() =>
      buildDocsAuthorizationUrl({
        authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        clientId: "workspace-client",
        fixedRedirectUri: "https://ipenovel.test/api/auth/google/callback",
        attempt,
      })
    ).toThrow("DOCS_REDIRECT_URI_NOT_FIXED");
  });

  it("normalizes deterministically without returning document text", () => {
    const composed = fingerprintDocsMetadata({
      providerFileId: "doc_1",
      revision: "r1",
      mimeType: GOOGLE_DOC_MIME_TYPE,
      title: " Draft ",
      normalizedText: " caf\u00e9  \r\nworld\t ",
    });
    const decomposed = fingerprintDocsMetadata({
      providerFileId: "doc_1",
      revision: "r2",
      mimeType: GOOGLE_DOC_MIME_TYPE,
      title: "Draft",
      normalizedText: " cafe\u0301\nworld",
    });
    expect(normalizeDocsText(" a \r\n b\t ")).toBe("a\n b");
    expect(composed.contentHash).toBe(decomposed.contentHash);
    expect(composed).toEqual(
      expect.objectContaining({
        providerFileId: "doc_1",
        normalizationVersion: 1,
        title: "Draft",
      })
    );
    expect(JSON.stringify(composed)).not.toContain("world");
  });

  it("fails closed for status, ownership, metadata mismatch, and non-Docs files", async () => {
    const adapter = {
      getMetadata: vi.fn(async () => ({
        providerFileId: "other",
        revision: "r1",
        mimeType: GOOGLE_DOC_MIME_TYPE,
        title: "Draft",
      })),
      getNormalizedText: vi.fn(async () => "body"),
      revoke: vi.fn(async () => undefined),
    };
    await expect(
      observeDocsSnapshot(
        {
          connectionStatus: "revoked",
          connectionOwnerUserId: 1,
          actorUserId: 1,
          providerFileId: "doc_1",
          accessToken: "access",
        },
        adapter
      )
    ).rejects.toThrow("DOCS_RECONNECT_REQUIRED");
    await expect(
      observeDocsSnapshot(
        {
          connectionStatus: "active",
          connectionOwnerUserId: 1,
          actorUserId: 2,
          providerFileId: "doc_1",
          accessToken: "access",
        },
        adapter
      )
    ).rejects.toThrow("DOCS_CONNECTION_OWNERSHIP_REQUIRED");
    await expect(
      observeDocsSnapshot(
        {
          connectionStatus: "active",
          connectionOwnerUserId: 1,
          actorUserId: 1,
          providerFileId: "doc_1",
          accessToken: "access",
        },
        adapter
      )
    ).rejects.toThrow("DOCS_PROVIDER_ID_MISMATCH");
    expect(adapter.getNormalizedText).not.toHaveBeenCalled();
    expect(canUseGoogleConnection("reconnect_required")).toBe(false);
  });

  it("observes repeat reads as stable immutable fingerprint inputs", async () => {
    const adapter = {
      getMetadata: vi.fn(async () => ({
        providerFileId: "doc_1",
        revision: "r7",
        mimeType: GOOGLE_DOC_MIME_TYPE,
        title: "Draft",
      })),
      getNormalizedText: vi.fn(async () => "same\r\nbody"),
      revoke: vi.fn(async () => undefined),
    };
    const request = {
      connectionStatus: "active" as const,
      connectionOwnerUserId: 7,
      actorUserId: 7,
      providerFileId: "doc_1",
      accessToken: "access",
    };
    const first = await observeDocsSnapshot(request, adapter);
    const second = await observeDocsSnapshot(request, adapter);
    expect(second).toEqual(first);
    expect(adapter.getMetadata).toHaveBeenCalledTimes(2);
  });

  it("encrypts, authenticates, rotates, preserves, and revokes refresh credentials", async () => {
    const keys = new Map([
      [4, Buffer.alloc(32, 7)],
      [5, Buffer.alloc(32, 8)],
    ]);
    const oldCipher = createAesGcmTokenCipher(keys, 4);
    const newCipher = createAesGcmTokenCipher(keys, 5);
    const old = oldCipher.encrypt("refresh-old");
    expect(old.encryptedRefreshToken).not.toContain("refresh-old");
    expect(oldCipher.decrypt(old)).toBe("refresh-old");
    expect(rotateRefreshCredential({ current: old, cipher: newCipher })).toBe(
      old
    );
    const rotated = rotateRefreshCredential({
      current: old,
      returnedRefreshToken: "refresh-new",
      cipher: newCipher,
    });
    expect(rotated.keyVersion).toBe(5);
    expect(newCipher.decrypt(rotated)).toBe("refresh-new");

    const revoke = vi.fn(async () => undefined);
    const result = await revokeDocsConnection({
      credential: rotated,
      cipher: newCipher,
      adapter: { getMetadata: vi.fn(), getNormalizedText: vi.fn(), revoke },
    });
    expect(revoke).toHaveBeenCalledWith({ refreshToken: "refresh-new" });
    expect(result.status).toBe("revoked");
    expect(result.encryptedRefreshToken).toBeNull();

    const tampered = {
      ...rotated,
      encryptedRefreshToken: rotated.encryptedRefreshToken.slice(0, -1) + "A",
    };
    expect(() => newCipher.decrypt(tampered)).toThrow(
      "DOCS_TOKEN_CIPHERTEXT_INVALID"
    );
  });
});
