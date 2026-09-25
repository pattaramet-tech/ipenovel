import { describe, expect, it, vi } from "vitest";

import { GoogleDocsChapterReader } from "./googleReader";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("NQA Google Docs chapter reader", () => {
  it("uses GET with includeTabsContent=true and flattens paragraph indexes", async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(url).toContain("includeTabsContent=true");
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer token-1"
      );

      return response({
        documentId: "doc-123",
        title: "Novel",
        revisionId: "rev-1",
        tabs: [
          {
            tabProperties: {
              tabId: "t.0",
              title: "Tab 1",
              index: 0,
            },
            documentTab: {
              body: {
                content: [
                  {
                    startIndex: 1,
                    endIndex: 25,
                    paragraph: {
                      elements: [
                        {
                          textRun: {
                            content: "บท 198: 197. Possessing\n",
                          },
                        },
                      ],
                    },
                  },
                  {
                    startIndex: 25,
                    endIndex: 40,
                    paragraph: {
                      elements: [
                        {
                          textRun: {
                            content: "chapter body\n",
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        ],
      });
    });

    const reader = new GoogleDocsChapterReader({
      accessTokenProvider: () => "token-1",
      fetchFn,
    });

    const result = await reader.readDocument("doc-123");

    expect(result).toMatchObject({
      documentId: "doc-123",
      title: "Novel",
      revisionId: "rev-1",
      tabs: [
        {
          tabId: "t.0",
          index: 0,
          paragraphs: [
            {
              text: "บท 198: 197. Possessing",
              startIndex: 1,
              endIndex: 25,
            },
            {
              text: "chapter body",
              startIndex: 25,
              endIndex: 40,
            },
          ],
        },
      ],
    });
  });

  it("supports legacy body content when tabs are absent", async () => {
    const reader = new GoogleDocsChapterReader({
      accessTokenProvider: () => "token-1",
      fetchFn: async () =>
        response({
          documentId: "legacy-doc",
          title: "Legacy",
          revisionId: "rev-legacy",
          body: {
            content: [
              {
                startIndex: 1,
                endIndex: 18,
                paragraph: {
                  elements: [
                    {
                      textRun: {
                        content: "บทที่ 1 เริ่มต้น\n",
                      },
                    },
                  ],
                },
              },
            ],
          },
        }),
    });

    const result = await reader.readDocument("legacy-doc");

    expect(result.tabs).toEqual([
      {
        tabId: "t.0",
        title: null,
        index: 0,
        parentTabId: null,
        paragraphs: [
          {
            text: "บทที่ 1 เริ่มต้น",
            startIndex: 1,
            endIndex: 18,
            tabId: "t.0",
          },
        ],
      },
    ]);
  });

  it("fails closed when credentials are unavailable", async () => {
    const fetchFn = vi.fn();
    const reader = new GoogleDocsChapterReader({
      accessTokenProvider: () => "",
      fetchFn,
    });

    await expect(reader.readDocument("doc-123")).rejects.toMatchObject({
      code: "AUTH_FAILURE",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("retries a rate limit and then succeeds", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(response({ error: "rate" }, 429))
      .mockResolvedValueOnce(
        response({
          documentId: "doc-123",
          title: "Novel",
          revisionId: "rev-1",
          tabs: [],
          body: { content: [] },
        })
      );

    const reader = new GoogleDocsChapterReader({
      accessTokenProvider: () => "token-1",
      fetchFn,
      sleep,
      baseRetryDelayMs: 1,
      maxAttempts: 3,
    });

    await expect(reader.readDocument("doc-123")).resolves.toMatchObject({
      documentId: "doc-123",
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("classifies permission denied without leaking response body", async () => {
    const fetchFn = vi.fn(
      async () => new Response("secret provider text", { status: 403 })
    );
    const reader = new GoogleDocsChapterReader({
      accessTokenProvider: () => "token-1",
      fetchFn,
      sleep: vi.fn(async () => undefined),
    });

    await expect(reader.readDocument("doc-denied")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      status: 403,
      message: "Google Docs chapter read failed with status 403.",
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
