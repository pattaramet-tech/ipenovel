import { describe, expect, it } from "vitest";

import { makeNovelCandidateIdentity } from "../core";
import { NqaGoogleBulkIntakeAdapter } from "../google/adapter";
import type {
  NqaGoogleReadOnlyTransport,
  NqaGoogleSpreadsheetMetadata,
} from "../google/contracts";
import { InMemoryNqaGatewayAuditSink } from "../mcp/audit";
import { NqaMcpGateway } from "../mcp/gateway";
import { NqaGatewayHandlerRegistry } from "../mcp/handlers";
import { InMemoryNqaIdempotencyStore } from "../mcp/idempotency";
import { createNqaIdentityHandlers } from "./handlers";
import { NqaNovelIdentityResolver } from "./resolver";

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

function makeAdapter(title: string) {
  const transport: NqaGoogleReadOnlyTransport = {
    getSpreadsheetMetadata: async () => spreadsheet,
    batchGetValues: async input =>
      input.ranges.map(range => ({
        range,
        majorDimension: "ROWS",
        values: [
          [
            `${title} 001 - 030`,
            "https://docs.google.com/document/d/translationDoc12345/edit",
            null,
            "https://example.com/source",
            null,
            null,
            null,
            null,
            null,
            "https://docs.google.com/document/d/sourceDocument12345/edit",
          ],
        ],
      })),
    getDocumentMetadata: async documentId => ({
      documentId,
      title: "Document",
      revisionId: "rev-1",
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

function gatewayFor(title: string, resolver: NqaNovelIdentityResolver) {
  const handlers = createNqaIdentityHandlers({
    adapter: makeAdapter(title),
    resolver,
  });
  return new NqaMcpGateway({
    handlers: new NqaGatewayHandlerRegistry(handlers),
    idempotencyStore: new InMemoryNqaIdempotencyStore(),
    auditSink: new InMemoryNqaGatewayAuditSink(),
    now: () => "2026-09-24T02:45:00+07:00",
  });
}

function request() {
  return {
    requestId: "req-identity-1",
    correlationId: "corr-identity-1",
    actorId: "ignored",
    capability: "nqa.novel.resolve_identity",
    target: { row: 2 },
    requestedAt: "2026-09-24T02:45:00+07:00",
  };
}

const principal = {
  principalId: "reader",
  sessionId: "session-1",
  permissions: ["READ" as const],
  authenticated: true,
};
describe("NQA identity MCP handler", () => {
  it("resolves a structured new identity through the READ gateway", async () => {
    const gateway = gatewayFor(
      "เรื่องใหม่",
      new NqaNovelIdentityResolver({ novels: [], bundles: [] })
    );

    const result = await gateway.dispatch({
      request: request(),
      principal,
    });

    expect(result).toMatchObject({
      status: "OK",
      result: {
        row: 2,
        status: "IDENTITY_RESOLVED",
        resolution: {
          status: "NEW",
          kind: "STRUCTURED_NEW",
        },
      },
    });
  });

  it("returns fuzzy identity review without auto-merging", async () => {
    const known = makeNovelCandidateIdentity("เรื่องทดสอบฉบับสมบูรณ์");
    const resolver = new NqaNovelIdentityResolver(
      {
        novels: [
          {
            novel: known,
            translationDocumentIds: [],
            sourceDocumentIds: [],
          },
        ],
        bundles: [],
      },
      { fuzzyThreshold: 0.7 }
    );
    const gateway = gatewayFor("เรื่องทดสอบฉบับสมบูรณ", resolver);

    const result = await gateway.dispatch({
      request: request(),
      principal,
    });

    expect(result).toMatchObject({
      status: "OK",
      result: {
        status: "IDENTITY_REVIEW",
        resolution: {
          status: "REVIEW",
          kind: "FUZZY_REVIEW",
          novel: null,
        },
      },
    });
  });

  it("remains a READ-only capability and needs no idempotency key", async () => {
    const gateway = gatewayFor(
      "เรื่องใหม่",
      new NqaNovelIdentityResolver({ novels: [], bundles: [] })
    );

    const result = await gateway.dispatch({
      request: request(),
      principal,
    });

    expect(result.status).toBe("OK");
    expect(result.error).toBeNull();
  });
});
