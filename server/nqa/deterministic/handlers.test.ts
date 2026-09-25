import { describe, expect, it, vi } from "vitest";

import type { NqaDocumentSnapshot } from "../chapter/contracts";
import type { NqaChapterDocumentReader } from "../chapter/googleReader";
import { NqaGoogleBulkIntakeAdapter } from "../google/adapter";
import type {
  NqaGoogleReadOnlyTransport,
  NqaGoogleSpreadsheetMetadata,
} from "../google/contracts";
import { InMemoryNqaGatewayAuditSink } from "../mcp/audit";
import { NqaMcpGateway } from "../mcp/gateway";
import { NqaGatewayHandlerRegistry } from "../mcp/handlers";
import { InMemoryNqaIdempotencyStore } from "../mcp/idempotency";
import { createNqaDeterministicQaHandlers } from "./handlers";

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

function adapter(valid = true) {
  const transport: NqaGoogleReadOnlyTransport = {
    getSpreadsheetMetadata: async () => spreadsheet,
    batchGetValues: async input =>
      input.ranges.map(range => ({
        range,
        majorDimension: "ROWS",
        values: [
          [
            "เรื่องทดสอบ 181 - 230",
            "https://docs.google.com/document/d/" + TRANSLATION_ID + "/edit",
            null,
            "https://example.com/source",
            null,
            null,
            null,
            null,
            null,
            valid
              ? "https://docs.google.com/document/d/" + SOURCE_ID + "/edit"
              : "not-a-google-doc",
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
            text: "A".repeat(500),
            startIndex: 26,
            endIndex: 526,
            tabId: "t.0",
          },
          {
            text: "บท 199: 198. Rookie",
            startIndex: 527,
            endIndex: 548,
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
            text: "บทที่ 197 การสิงร่าง",
            startIndex: 1,
            endIndex: 23,
            tabId: "t.197",
          },
          {
            text: "ก".repeat(500),
            startIndex: 24,
            endIndex: 524,
            tabId: "t.197",
          },
        ],
      },
    ],
  };
}

function makeGateway(input?: {
  validContract?: boolean;
  reader?: NqaChapterDocumentReader;
}) {
  const reader =
    input?.reader ??
    ({
      readDocument: vi.fn(async documentId =>
        documentId === SOURCE_ID ? sourceSnapshot() : translationSnapshot()
      ),
    } satisfies NqaChapterDocumentReader);

  const handlers = createNqaDeterministicQaHandlers({
    adapter: adapter(input?.validContract ?? true),
    reader,
    expectedInternalSequence: chapter => (chapter === 197 ? 198 : null),
    policy: {
      minChapterCharsReview: 1,
      maxChapterCharsReview: 100_000,
      minLengthRatioReview: 0.1,
      maxLengthRatioReview: 10,
      minParagraphRatioReview: 0.1,
      maxParagraphRatioReview: 10,
    },
  });

  const auditSink = new InMemoryNqaGatewayAuditSink();
  return {
    gateway: new NqaMcpGateway({
      handlers: new NqaGatewayHandlerRegistry(handlers),
      idempotencyStore: new InMemoryNqaIdempotencyStore(),
      auditSink,
      now: () => "2026-09-24T09:00:00+07:00",
    }),
    auditSink,
    reader,
  };
}
const principal = {
  principalId: "qa-operator",
  sessionId: "session-1",
  permissions: ["QA_OPERATE" as const],
  authenticated: true,
};

function request(idempotencyKey?: string) {
  return {
    requestId: "req-det-1",
    correlationId: "corr-det-1",
    actorId: "ignored",
    capability: "nqa.qa.run_deterministic",
    target: { row: 2, chapter: 197 },
    idempotencyKey,
    requestedAt: "2026-09-24T09:00:00+07:00",
  };
}

describe("NQA deterministic QA MCP handler", () => {
  it("requires idempotency before executing the QA handler", async () => {
    const { gateway, reader } = makeGateway();

    const result = await gateway.dispatch({
      request: request(),
      principal,
    });

    expect(result).toMatchObject({
      status: "ERROR",
      error: { code: "IDEMPOTENCY_KEY_REQUIRED" },
    });
    expect(reader.readDocument).not.toHaveBeenCalled();
  });

  it("runs deterministic QA with QA_OPERATE and a valid key", async () => {
    const { gateway } = makeGateway();

    const result = await gateway.dispatch({
      request: request("a".repeat(64)),
      principal,
    });

    expect(result).toMatchObject({
      status: "OK",
      result: {
        row: 2,
        chapter: 197,
        status: "PASS",
        deterministic: {
          decision: "PASS",
          policyVersion: "nqa-deterministic-v1",
        },
      },
    });
  });

  it("reuses the completed deterministic result without re-reading documents", async () => {
    const { gateway, reader, auditSink } = makeGateway();
    const repeated = request("b".repeat(64));

    const first = await gateway.dispatch({
      request: repeated,
      principal,
    });
    const second = await gateway.dispatch({
      request: repeated,
      principal,
    });

    expect(first.status).toBe("OK");
    expect(second.status).toBe("REUSED");
    expect(reader.readDocument).toHaveBeenCalledTimes(2);
    expect(
      auditSink.records.some(record => record.event === "IDEMPOTENCY_REUSED")
    ).toBe(true);
  });
  it("returns contract invalid without reading chapter bodies", async () => {
    const reader: NqaChapterDocumentReader = {
      readDocument: vi.fn(),
    };
    const { gateway } = makeGateway({
      validContract: false,
      reader,
    });

    const result = await gateway.dispatch({
      request: request("c".repeat(64)),
      principal,
    });

    expect(result).toMatchObject({
      status: "OK",
      result: {
        status: "CONTRACT_INVALID",
        deterministic: null,
      },
    });
    expect(reader.readDocument).not.toHaveBeenCalled();
  });

  it("returns REVIEW when resolver evidence is ambiguous", async () => {
    const duplicateTranslation = translationSnapshot();
    duplicateTranslation.tabs.push({
      ...duplicateTranslation.tabs[0],
      tabId: "t.197b",
      title: "บทที่ 197 การสิงร่าง แปลใหม่",
      index: 17,
      paragraphs: duplicateTranslation.tabs[0].paragraphs.map(paragraph => ({
        ...paragraph,
        tabId: "t.197b",
      })),
    });

    const reader: NqaChapterDocumentReader = {
      readDocument: vi.fn(async documentId =>
        documentId === SOURCE_ID ? sourceSnapshot() : duplicateTranslation
      ),
    };
    const { gateway } = makeGateway({ reader });

    const result = await gateway.dispatch({
      request: request("d".repeat(64)),
      principal,
    });

    expect(result).toMatchObject({
      status: "OK",
      result: {
        status: "REVIEW",
        deterministic: {
          decision: "REVIEW",
          reasonCodes: expect.arrayContaining([
            "AMBIGUOUS_CHAPTER_MAPPING",
            "DUPLICATE_CHAPTER_ID",
          ]),
        },
      },
    });
  });

  it("denies READ-only principals from running deterministic QA", async () => {
    const { gateway } = makeGateway();

    const result = await gateway.dispatch({
      request: request("e".repeat(64)),
      principal: {
        principalId: "reader",
        sessionId: "session-read",
        permissions: ["READ"],
        authenticated: true,
      },
    });

    expect(result).toMatchObject({
      status: "ERROR",
      error: { code: "MISSING_PERMISSION" },
    });
  });
});
