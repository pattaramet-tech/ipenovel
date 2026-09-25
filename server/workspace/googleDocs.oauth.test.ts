import { describe, expect, it, vi } from "vitest";
import { WORKSPACE_DOCS_SCOPE } from "./googleDocs.domain";
import { exchangeWorkspaceGoogleDocsAuthorizationCode } from "./googleDocs.oauth";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Workspace Google Docs OAuth exchange", () => {
  it("exchanges PKCE code, validates read-only scopes, and resolves provider subject", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "access-token",
          refresh_token: "refresh-token",
          scope: WORKSPACE_DOCS_SCOPE,
        })
      )
      .mockResolvedValueOnce(jsonResponse({ sub: "google-subject-1" }));

    const result = await exchangeWorkspaceGoogleDocsAuthorizationCode(
      {
        code: "code-1",
        codeVerifier: "verifier-1",
        redirectUri: "https://ipenovel.com/api/workspace/google/callback",
        clientId: "client-id",
        clientSecret: "client-secret",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        userInfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
      },
      fetchImpl
    );

    expect(result).toEqual({
      providerSubject: "google-subject-1",
      refreshToken: "refresh-token",
      grantedScopes: WORKSPACE_DOCS_SCOPE,
    });
    const [, tokenInit] = fetchImpl.mock.calls[0];
    const body = new URLSearchParams(String(tokenInit?.body));
    expect(body.get("redirect_uri")).toBe(
      "https://ipenovel.com/api/workspace/google/callback"
    );
    expect(body.get("code_verifier")).toBe("verifier-1");
    expect(fetchImpl.mock.calls[1][1]?.headers).toEqual({
      Authorization: "Bearer access-token",
    });
  });

  it("fails closed when Google does not return durable credentials or required scopes", async () => {
    const missingRefresh = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ access_token: "access", scope: WORKSPACE_DOCS_SCOPE })
      );
    await expect(
      exchangeWorkspaceGoogleDocsAuthorizationCode(
        {
          code: "code",
          codeVerifier: "verifier",
          redirectUri: "https://ipenovel.com/api/workspace/google/callback",
          clientId: "client",
          clientSecret: "secret",
          tokenEndpoint: "https://oauth2.googleapis.com/token",
          userInfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
        },
        missingRefresh
      )
    ).rejects.toThrow("durable credentials");

    const missingDocsScope = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        access_token: "access",
        refresh_token: "refresh",
        scope: "openid https://www.googleapis.com/auth/documents.readonly",
      })
    );
    await expect(
      exchangeWorkspaceGoogleDocsAuthorizationCode(
        {
          code: "code",
          codeVerifier: "verifier",
          redirectUri: "https://ipenovel.com/api/workspace/google/callback",
          clientId: "client",
          clientSecret: "secret",
          tokenEndpoint: "https://oauth2.googleapis.com/token",
          userInfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
        },
        missingDocsScope
      )
    ).rejects.toThrow("required read-only Docs scopes");
  });
});
