import { describe, expect, it } from "vitest";

import { NqaGoogleBulkIntakeAdapter } from "../google/adapter";
import type {
  NqaGoogleReadOnlyTransport,
  NqaGoogleSpreadsheetMetadata,
} from "../google/contracts";
import { InMemoryNqaGatewayAuditSink } from "../mcp/audit";
import { NqaMcpGateway } from "../mcp/gateway";
import { NqaGatewayHandlerRegistry } from "../mcp/handlers";
import { InMemoryNqaIdempotencyStore } from "../mcp/idempotency";
import type { NqaChapterDocumentReader } from "./googleReader";
import { createNqaChapterHandlers } from "./handlers";
import type { NqaDocumentSnapshot } from "./contracts";

const SOURCE_ID = "sourceDocument12345";
const TRANSLATION_ID = "translationDoc12345";

const spreadsheet: NqaGoogleSpreadsheetMetadata = {
  spreadsheetId: "spreadsheet-12345",
  title: "Test",
  locale: "th_TH",
  timeZone: "Asia/Bangkok",
  sheets: [
    {
      sheetId: 1,
      title: "Sheet",
      index: 0,
      rowCount: 100,
      columnCount: 26,
    },
  ],
};

function adapter() {
  const transport: NqaGoogleReadOnlyTransport = {
    getSpreadsheetMetadata: async () => spreadsheet,
    batchGetValues: async input =>
      input.ranges.map(range => ({
        range,
        majorDimension: "ROWS",
        values: [
          [
            "เรื่องทดสอบ 181 - 230",
            `https://docs.google.com/document/d/${TRANSLATION_ID}/edit`,
            null,
            "https://example.com/source",
            null,
            null,
            null,
            null,
            null,
            `https://docs.google.com/document/d/${SOURCE_ID}/edit`,
          ],
        ],
      })),
    getDocumentMetadata: async documentId => ({
      documentId,
      title: "Document",
      revisionId: "meta-rev",
      tabs: [],
    }),
  };

  return new NqaGoogleBulkIntakeAdapter(transport, {
    spreadsheetId: "spreadsheet-12345",
    sheetName: "Sheet",
    sheetId: 1,
    columns: {
      novelTitle: "B",
      translation: "C",
      webSource: "E",
      preparedSource: "K",
    },
  });
}
function sourceSnapshot(): NqaDocumentSnapshot {
  return {
    documentId: SOURCE_ID,
    title: "English",
    revisionId: "source-rev",
    tabs: [
      {
        tabId: "t.0",
        title: "Tab 1",
        index: 0,
        parentTabId: null,
        paragraphs: [
          {
            text: "บท 198: 197. Possessing",
            startIndex: 1,
            endIndex: 25,
            tabId: "t.0",
          },
          {
            text: "Sabo and Kurama.",
            startIndex: 26,
            endIndex: 60,
            tabId: "t.0",
          },
          {
            text: "บท 199: 198. Rookie",
            startIndex: 61,
            endIndex: 82,
            tabId: "t.0",
          },
        ],
      },
    ],
  };
}

function translationSnapshot(): NqaDocumentSnapshot {
  return {
    documentId: TRANSLATION_ID,
    title: "Thai",
    revisionId: "translation-rev",
    tabs: [
      {
        tabId: "t.197",
        title: "บทที่ 197 การสิงร่าง",
        index: 16,
        parentTabId: null,
        paragraphs: [
          {
            text: "บทที่ 197 การสิงร่าง(แปลใหม่)",
            startIndex: 1,
            endIndex: 30,
            tabId: "t.197",
          },
          {
            text: "ซาโบและคุรามะ",
            startIndex: 31,
            endIndex: 60,
            tabId: "t.197",
          },
        ],
      },
    ],
  };
}

function gateway(reader: NqaChapterDocumentReader) {
  const handlers = createNqaChapterHandlers({
    adapter: adapter(),
    reader,
    expectedInternalSequence: chapter => (chapter === 197 ? 198 : null),
  });

  return new NqaMcpGateway({
    handlers: new NqaGatewayHandlerRegistry(handlers),
    idempotencyStore: new InMemoryNqaIdempotencyStore(),
    auditSink: new InMemoryNqaGatewayAuditSink(),
    now: () => "2026-09-24T08:00:00+07:00",
  });
}
const principal = {
  principalId: "reader",
  sessionId: "session-1",
  permissions: ["READ" as const],
  authenticated: true,
};

function request(capability: string) {
  return {
    requestId: "req-1",
    correlationId: "corr-1",
    actorId: "ignored",
    capability,
    target: { row: 2, chapter: 197 },
    requestedAt: "2026-09-24T08:00:00+07:00",
  };
}

describe("NQA chapter MCP handlers", () => {
  it("resolves canonical chapter 197 through authenticated READ gateway", async () => {
    const reader: NqaChapterDocumentReader = {
      readDocument: async documentId =>
        documentId === SOURCE_ID ? sourceSnapshot() : translationSnapshot(),
    };

    const result = await gateway(reader).dispatch({
      request: request("nqa.chapter.resolve"),
      principal,
    });

    expect(result).toMatchObject({
      status: "OK",
      result: {
        chapter: 197,
        status: "RESOLVED",
        resolution: {
          source: {
            internalSequence: 198,
            title: "Possessing",
          },
          translation: {
            variant: "corrected_candidate",
          },
        },
      },
    });
  });

  it("extracts only after a resolved mapping", async () => {
    const reader: NqaChapterDocumentReader = {
      readDocument: async documentId =>
        documentId === SOURCE_ID ? sourceSnapshot() : translationSnapshot(),
    };

    const result = await gateway(reader).dispatch({
      request: request("nqa.chapter.extract"),
      principal,
    });

    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      const payload = result.result as {
        extraction: {
          source: { text: string; sha256: string };
          translation: { text: string; sha256: string };
        };
      };
      expect(payload.extraction.source.text).toContain("Sabo");
      expect(payload.extraction.translation.text).toContain("ซาโบ");
      expect(payload.extraction.source.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("returns no extraction when mapping requires review", async () => {
    const ambiguous = translationSnapshot();
    ambiguous.tabs.push({
      ...ambiguous.tabs[0],
      tabId: "t.197b",
      title: "บทที่ 197 แปลใหม่ B",
      index: 17,
      paragraphs: ambiguous.tabs[0].paragraphs.map(paragraph => ({
        ...paragraph,
        tabId: "t.197b",
      })),
    });

    const reader: NqaChapterDocumentReader = {
      readDocument: async documentId =>
        documentId === SOURCE_ID ? sourceSnapshot() : ambiguous,
    };

    const result = await gateway(reader).dispatch({
      request: request("nqa.chapter.extract"),
      principal,
    });

    expect(result).toMatchObject({
      status: "OK",
      result: {
        status: "REVIEW",
        extraction: null,
      },
    });
  });

  it("remains READ-only and does not require idempotency", async () => {
    const reader: NqaChapterDocumentReader = {
      readDocument: async documentId =>
        documentId === SOURCE_ID ? sourceSnapshot() : translationSnapshot(),
    };

    const result = await gateway(reader).dispatch({
      request: request("nqa.chapter.resolve"),
      principal,
    });

    expect(result.status).toBe("OK");
    expect(result.error).toBeNull();
  });
});
