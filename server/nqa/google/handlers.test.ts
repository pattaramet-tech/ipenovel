import { describe, expect, it } from "vitest";

import { InMemoryNqaGatewayAuditSink } from "../mcp/audit";
import { NqaMcpGateway } from "../mcp/gateway";
import { NqaGatewayHandlerRegistry } from "../mcp/handlers";
import { InMemoryNqaIdempotencyStore } from "../mcp/idempotency";
import { NqaGoogleBulkIntakeAdapter } from "./adapter";
import type {
  NqaGoogleReadOnlyTransport,
  NqaGoogleSpreadsheetMetadata,
} from "./contracts";
import { createNqaGoogleIntakeHandlers } from "./handlers";

const SPREADSHEET_ID = "sheet-1234567890";
const SHEET_NAME = "Intake";

const spreadsheet: NqaGoogleSpreadsheetMetadata = {
  spreadsheetId: SPREADSHEET_ID,
  title: "Test",
  locale: "th_TH",
  timeZone: "Asia/Bangkok",
  sheets: [
    {
      sheetId: 7,
      title: SHEET_NAME,
      index: 0,
      rowCount: 100,
      columnCount: 26,
    },
  ],
};

function rowValues(rangeStart: number) {
  return [
    `เรื่องทดสอบ ${String(rangeStart).padStart(3, "0")} - ${String(
      rangeStart + 29
    ).padStart(3, "0")}`,
    "https://docs.google.com/document/d/translationDoc12345/edit",
    null,
    "https://example.com/source",
    null,
    null,
    null,
    null,
    null,
    "https://docs.google.com/document/d/sourceDocument12345/edit",
  ];
}
function makeAdapter() {
  const transport: NqaGoogleReadOnlyTransport = {
    getSpreadsheetMetadata: async () => spreadsheet,
    batchGetValues: async input =>
      input.ranges.map((range, index) => ({
        range,
        majorDimension: "ROWS",
        values: [rowValues(index * 30 + 1)],
      })),
    getDocumentMetadata: async documentId => ({
      documentId,
      title: "Document",
      revisionId: "rev-1",
      tabs: [],
    }),
  };

  return new NqaGoogleBulkIntakeAdapter(transport, {
    spreadsheetId: SPREADSHEET_ID,
    sheetName: SHEET_NAME,
    sheetId: 7,
    columns: {
      novelTitle: "B",
      translation: "C",
      webSource: "E",
      preparedSource: "K",
    },
    rowsPerBatchRange: 1,
    maxRowsPerScan: 20,
  });
}

function makeGateway() {
  const handlers = createNqaGoogleIntakeHandlers(makeAdapter());
  return new NqaMcpGateway({
    handlers: new NqaGatewayHandlerRegistry(handlers),
    idempotencyStore: new InMemoryNqaIdempotencyStore(),
    auditSink: new InMemoryNqaGatewayAuditSink(),
    now: () => "2026-09-24T02:00:00+07:00",
  });
}

function principal() {
  return {
    principalId: "reader",
    sessionId: "session-1",
    permissions: ["READ" as const],
    authenticated: true,
  };
}
function request(capability: string, target: Record<string, unknown>) {
  return {
    requestId: "req-1",
    correlationId: "corr-1",
    actorId: "ignored-request-actor",
    capability,
    target,
    requestedAt: "2026-09-24T02:00:00+07:00",
  };
}

describe("NQA Google intake MCP handlers", () => {
  it("serves get_row through the authenticated READ gateway", async () => {
    const result = await makeGateway().dispatch({
      request: request("nqa.intake.get_row", { row: 2 }),
      principal: principal(),
    });

    expect(result).toMatchObject({
      status: "OK",
      result: {
        row: 2,
        parse: { status: "PASS" },
      },
    });
  });

  it("serves bounded scan_range using row and rowEnd", async () => {
    const result = await makeGateway().dispatch({
      request: request("nqa.intake.scan_range", {
        row: 2,
        rowEnd: 4,
      }),
      principal: principal(),
    });

    expect(result.status).toBe("OK");
    if (result.status === "OK") {
      expect((result.result as { rows: unknown[] }).rows).toHaveLength(3);
    }
  });

  it("does not require idempotency for READ-only intake handlers", async () => {
    const result = await makeGateway().dispatch({
      request: request("nqa.intake.get_manifest", { row: 2 }),
      principal: principal(),
    });

    expect(result.status).toBe("OK");
    expect(result.error).toBeNull();
  });
  it("returns only contract validation output for validate_contract", async () => {
    const result = await makeGateway().dispatch({
      request: request("nqa.intake.validate_contract", {
        row: 2,
      }),
      principal: principal(),
    });

    expect(result).toMatchObject({
      status: "OK",
      result: {
        row: 2,
        parse: { status: "PASS" },
      },
    });
    if (result.status === "OK") {
      expect(result.result).not.toHaveProperty("documents");
    }
  });

  it("fails safely when target.row is omitted", async () => {
    const result = await makeGateway().dispatch({
      request: request("nqa.intake.get_row", {}),
      principal: principal(),
    });

    expect(result).toMatchObject({
      status: "ERROR",
      error: {
        code: "EXECUTION_FAILED",
        message: "NQA handler execution failed.",
      },
    });
  });
});
