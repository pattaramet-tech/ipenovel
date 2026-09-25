import { describe, expect, it, vi } from "vitest";

import {
  NQA_GOOGLE_OPTIONAL_READ_ONLY_SCOPES,
  NQA_GOOGLE_READ_ONLY_SCOPES,
  NQA_GOOGLE_REQUIRED_READ_ONLY_SCOPES,
} from "./contracts";
import {
  GoogleRestReadOnlyTransport,
  NqaGoogleTransportError,
} from "./transport";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("NQA Google read-only REST transport", () => {
  it("declares only read-only OAuth scopes", () => {
    expect(NQA_GOOGLE_READ_ONLY_SCOPES).toEqual([
      "https://www.googleapis.com/auth/spreadsheets.readonly",
      "https://www.googleapis.com/auth/documents.readonly",
      "https://www.googleapis.com/auth/drive.metadata.readonly",
    ]);
    expect(
      NQA_GOOGLE_READ_ONLY_SCOPES.every(scope => scope.endsWith(".readonly"))
    ).toBe(true);
  });

  it("reads spreadsheet metadata with GET and bearer auth", async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer token-1"
      );
      return jsonResponse({
        spreadsheetId: "sheet-123",
        properties: {
          title: "รวมนิยาย",
          locale: "th_TH",
          timeZone: "Asia/Bangkok",
        },
        sheets: [
          {
            properties: {
              sheetId: 0,
              title: "นิยายยังไม่จบ/ยังไม่ยื่น",
              index: 0,
              gridProperties: {
                rowCount: 3459,
                columnCount: 26,
              },
            },
          },
        ],
      });
    });
    const transport = new GoogleRestReadOnlyTransport({
      accessTokenProvider: () => "token-1",
      fetchFn,
    });

    const result = await transport.getSpreadsheetMetadata("sheet-123");

    expect(result).toMatchObject({
      spreadsheetId: "sheet-123",
      title: "รวมนิยาย",
      locale: "th_TH",
      timeZone: "Asia/Bangkok",
      sheets: [
        {
          sheetId: 0,
          title: "นิยายยังไม่จบ/ยังไม่ยื่น",
          rowCount: 3459,
          columnCount: 26,
        },
      ],
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toContain(
      "sheets.googleapis.com/v4/spreadsheets/sheet-123"
    );
  });

  it("uses Sheets values:batchGet with bounded read ranges", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      expect(url).toContain("/values:batchGet?");
      expect(url).toContain("majorDimension=ROWS");
      expect(url).toContain("valueRenderOption=FORMATTED_VALUE");
      return jsonResponse({
        valueRanges: [
          {
            range: "'Sheet'!B2:K3",
            majorDimension: "ROWS",
            values: [["Story 001 - 030"]],
          },
          {
            range: "'Sheet'!B4:K5",
            majorDimension: "ROWS",
            values: [["Story 031 - 060"]],
          },
        ],
      });
    });

    const transport = new GoogleRestReadOnlyTransport({
      accessTokenProvider: () => "token-1",
      fetchFn,
    });
    const result = await transport.batchGetValues({
      spreadsheetId: "sheet-123",
      ranges: ["'Sheet'!B2:K3", "'Sheet'!B4:K5"],
    });

    expect(result).toHaveLength(2);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("reads only document metadata and tab properties", async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(url).toContain("docs.googleapis.com/v1/documents/doc-123");
      expect(url).toContain("includeTabsContent=false");
      return jsonResponse({
        documentId: "doc-123",
        title: "Source document",
        revisionId: "rev-4",
        tabs: [
          {
            tabProperties: {
              tabId: "t.0",
              title: "Tab 1",
              index: 0,
            },
            childTabs: [
              {
                tabProperties: {
                  tabId: "t.child",
                  title: "Child",
                  index: 0,
                  parentTabId: "t.0",
                },
              },
            ],
          },
        ],
      });
    });

    const transport = new GoogleRestReadOnlyTransport({
      accessTokenProvider: () => "token-1",
      fetchFn,
    });
    const result = await transport.getDocumentMetadata("doc-123");

    expect(result).toMatchObject({
      documentId: "doc-123",
      revisionId: "rev-4",
      tabs: [
        { tabId: "t.0", title: "Tab 1" },
        {
          tabId: "t.child",
          title: "Child",
          parentTabId: "t.0",
        },
      ],
    });
  });

  it("retries 429 and then succeeds", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "rate" }, 429))
      .mockResolvedValueOnce(
        jsonResponse({
          spreadsheetId: "sheet-123",
          properties: {},
          sheets: [],
        })
      );
    const transport = new GoogleRestReadOnlyTransport({
      accessTokenProvider: () => "token-1",
      fetchFn,
      sleep,
      baseRetryDelayMs: 1,
      maxAttempts: 3,
    });

    await expect(
      transport.getSpreadsheetMetadata("sheet-123")
    ).resolves.toMatchObject({ spreadsheetId: "sheet-123" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("does not retry permission denied", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchFn = vi.fn(async () =>
      jsonResponse({ error: "forbidden" }, 403)
    );
    const transport = new GoogleRestReadOnlyTransport({
      accessTokenProvider: () => "token-1",
      fetchFn,
      sleep,
      maxAttempts: 3,
    });

    await expect(
      transport.getDocumentMetadata("doc-denied")
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      status: 403,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fails closed when token is unavailable", async () => {
    const fetchFn = vi.fn();
    const transport = new GoogleRestReadOnlyTransport({
      accessTokenProvider: () => "",
      fetchFn,
    });

    await expect(
      transport.getSpreadsheetMetadata("sheet-123")
    ).rejects.toBeInstanceOf(NqaGoogleTransportError);
    await expect(
      transport.getSpreadsheetMetadata("sheet-123")
    ).rejects.toMatchObject({ code: "AUTH_FAILURE" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("classifies malformed JSON as MALFORMED_RESPONSE", async () => {
    const fetchFn = vi.fn(
      async () => new Response("not-json", { status: 200 })
    );
    const transport = new GoogleRestReadOnlyTransport({
      accessTokenProvider: () => "token-1",
      fetchFn,
    });

    await expect(
      transport.getSpreadsheetMetadata("sheet-123")
    ).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
  });
});
