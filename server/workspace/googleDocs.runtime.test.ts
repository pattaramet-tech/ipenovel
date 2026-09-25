import { afterEach, describe, expect, it } from "vitest";
import {
  workspaceGoogleDocsOAuthConfig,
  workspaceGoogleDocsTokenCipher,
} from "./googleDocs.runtime";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("Workspace Google Docs runtime config", () => {
  it("accepts only an explicit fixed Workspace callback in production", () => {
    process.env.NODE_ENV = "production";
    process.env.DEPLOYMENT_ENVIRONMENT = "production";
    process.env.GOOGLE_OAUTH_CLIENT_ID = "client";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "secret";
    process.env.WORKSPACE_GOOGLE_DOCS_REDIRECT_URI =
      "https://ipenovel.com/api/workspace/google/callback";

    expect(workspaceGoogleDocsOAuthConfig().redirectUri).toBe(
      "https://ipenovel.com/api/workspace/google/callback"
    );

    process.env.WORKSPACE_GOOGLE_DOCS_REDIRECT_URI =
      "https://ipenovel.com/api/workspace/google/callback?returnTo=/evil";
    expect(() => workspaceGoogleDocsOAuthConfig()).toThrow(
      "WORKSPACE_GOOGLE_DOCS_REDIRECT_URI"
    );

    process.env.WORKSPACE_GOOGLE_DOCS_REDIRECT_URI =
      "http://ipenovel.com/api/workspace/google/callback";
    expect(() => workspaceGoogleDocsOAuthConfig()).toThrow(
      "WORKSPACE_GOOGLE_DOCS_REDIRECT_URI"
    );

    process.env.WORKSPACE_GOOGLE_DOCS_REDIRECT_URI =
      "https://production-staging.ipenovel.com/api/workspace/google/callback";
    expect(() => workspaceGoogleDocsOAuthConfig()).toThrow(
      "WORKSPACE_GOOGLE_DOCS_REDIRECT_URI"
    );

    process.env.DEPLOYMENT_ENVIRONMENT = "production-staging";
    expect(workspaceGoogleDocsOAuthConfig().redirectUri).toBe(
      "https://production-staging.ipenovel.com/api/workspace/google/callback"
    );
  });

  it("requires a 32-byte server-only encryption key", () => {
    process.env.WORKSPACE_GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY = "short";
    expect(() => workspaceGoogleDocsTokenCipher()).toThrow("32 bytes");

    process.env.WORKSPACE_GOOGLE_DOCS_TOKEN_ENCRYPTION_KEY = "11".repeat(32);
    const cipher = workspaceGoogleDocsTokenCipher();
    const encrypted = cipher.encrypt("refresh-token");
    expect(encrypted.encryptedRefreshToken).not.toContain("refresh-token");
    expect(cipher.decrypt(encrypted)).toBe("refresh-token");
  });
});
