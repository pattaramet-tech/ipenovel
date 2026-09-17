import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginWorkspaceGoogleDocsConsent,
  createWorkspaceGoogleDocsRuntimeAdapter,
  createWorkspaceGoogleDocsTokenCipher,
  fetchWorkspaceGoogleDriveFileMetadata,
  resolveWorkspaceGoogleDocsRuntimeConfig,
} from "./googleDocs.runtime";

const DOC_ID = "1RealGoogleDocAbCdEfGhIjKlMnOp";
const ACCESS_TOKEN = "access-token-never-log";

describe("IPE-054-D2A Google Docs runtime", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses incremental consent outside Preview before touching the database", async () => {
    vi.stubEnv("WORKSPACE_AI_QC_RUNTIME_TARGET", "production");
    await expect(beginWorkspaceGoogleDocsConsent(1)).rejects.toMatchObject({
      code: "RUNTIME_CONFIG_INVALID",
    });
  });

  it("requires a pinned HTTPS callback and complete OAuth config", () => {
    expect(
      resolveWorkspaceGoogleDocsRuntimeConfig({
        GOOGLE_OAUTH_CLIENT_ID: "client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
        WORKSPACE_GOOGLE_DOCS_REDIRECT_URI:
          "https://r2-preview.ipenovel.com/api/workspace/google/callback",
      } as NodeJS.ProcessEnv)
    ).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri:
        "https://r2-preview.ipenovel.com/api/workspace/google/callback",
    });
    expect(() =>
      resolveWorkspaceGoogleDocsRuntimeConfig({
        GOOGLE_OAUTH_CLIENT_ID: "client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
        WORKSPACE_GOOGLE_DOCS_REDIRECT_URI:
          "http://example.test/api/workspace/google/callback",
      } as NodeJS.ProcessEnv)
    ).toThrow(/exact Preview Workspace Google callback/);
    expect(() =>
      resolveWorkspaceGoogleDocsRuntimeConfig({
        GOOGLE_OAUTH_CLIENT_ID: "client-id",
        GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
        WORKSPACE_GOOGLE_DOCS_REDIRECT_URI:
          "https://ipenovel.com/api/workspace/google/callback",
      } as NodeJS.ProcessEnv)
    ).toThrow(/exact Preview Workspace Google callback/);
  });
  it("encrypts refresh credentials with a dedicated 32-byte key", () => {
    const cipher = createWorkspaceGoogleDocsTokenCipher("11".repeat(32));
    const encrypted = cipher.encrypt("refresh-secret");
    expect(encrypted.encryptedRefreshToken).not.toContain("refresh-secret");
    expect(cipher.decrypt(encrypted)).toBe("refresh-secret");
    expect(() => createWorkspaceGoogleDocsTokenCipher("too-short")).toThrow(
      /exactly 32 bytes/
    );
  });

  it("pins Drive metadata reads and never exposes upstream error bodies", async () => {
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe(
          `https://www.googleapis.com/drive/v3/files/${DOC_ID}?fields=id,name,mimeType,version,trashed`
        );
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Bearer ${ACCESS_TOKEN}`
        );
        return new Response(JSON.stringify({ error: "upstream-secret-body" }), {
          status: 401,
        });
      }
    ) as unknown as typeof fetch;
    await expect(
      fetchWorkspaceGoogleDriveFileMetadata({
        accessToken: ACCESS_TOKEN,
        providerFileId: DOC_ID,
        fetchImpl,
      })
    ).rejects.toThrow("HTTP 401");
    await expect(
      fetchWorkspaceGoogleDriveFileMetadata({
        accessToken: ACCESS_TOKEN,
        providerFileId: DOC_ID,
        fetchImpl,
      })
    ).rejects.not.toThrow(/upstream-secret-body|access-token-never-log/);
  });
  it("reads metadata and all tab text without retaining document content", async () => {
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const value = String(url);
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Bearer ${ACCESS_TOKEN}`
        );
        if (value.includes("/drive/v3/files/")) {
          return new Response(
            JSON.stringify({
              id: DOC_ID,
              name: "Real Preview Draft",
              mimeType: "application/vnd.google-apps.document",
              version: "27",
              trashed: false,
            }),
            { status: 200 }
          );
        }
        expect(value).toBe(
          `https://docs.googleapis.com/v1/documents/${DOC_ID}?includeTabsContent=true`
        );
        return new Response(
          JSON.stringify({
            tabs: [
              {
                documentTab: {
                  body: {
                    content: [
                      {
                        paragraph: {
                          elements: [{ textRun: { content: "chapter one\n" } }],
                        },
                      },
                    ],
                  },
                },
                childTabs: [
                  {
                    documentTab: {
                      body: {
                        content: [
                          {
                            table: {
                              tableRows: [
                                {
                                  tableCells: [
                                    {
                                      content: [
                                        {
                                          paragraph: {
                                            elements: [
                                              {
                                                textRun: {
                                                  content: "nested tab\n",
                                                },
                                              },
                                            ],
                                          },
                                        },
                                      ],
                                    },
                                  ],
                                },
                              ],
                            },
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            ],
          }),
          { status: 200 }
        );
      }
    ) as unknown as typeof fetch;
    const adapter = createWorkspaceGoogleDocsRuntimeAdapter(fetchImpl);
    await expect(
      adapter.getMetadata({
        accessToken: ACCESS_TOKEN,
        providerFileId: DOC_ID,
      })
    ).resolves.toEqual({
      providerFileId: DOC_ID,
      revision: "27",
      mimeType: "application/vnd.google-apps.document",
      title: "Real Preview Draft",
    });
    await expect(
      adapter.getNormalizedText({
        accessToken: ACCESS_TOKEN,
        providerFileId: DOC_ID,
      })
    ).resolves.toBe("chapter one\nnested tab\n");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("allows a bounded large Docs response above the generic Google response limit", async () => {
    const payload = JSON.stringify({
      padding: "x".repeat(5_050_000),
      tabs: [{ documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: "large doc\n" } }] } }] } } }],
    });
    const fetchImpl = vi.fn(async () => new Response(payload, { status: 200 })) as unknown as typeof fetch;
    const adapter = createWorkspaceGoogleDocsRuntimeAdapter(fetchImpl);
    await expect(adapter.getNormalizedText({ accessToken: ACCESS_TOKEN, providerFileId: DOC_ID })).resolves.toBe("large doc\n");
  });

});
