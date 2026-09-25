import { describe, expect, it, vi } from "vitest";

import type {
  NqaGoogleDocumentMetadata,
  NqaGoogleReadOnlyTransport,
  NqaGoogleSpreadsheetMetadata,
  NqaGoogleValueRange,
} from "./contracts";
import { NqaGoogleAdapterError, NqaGoogleBulkIntakeAdapter } from "./adapter";
import { NqaGoogleTransportError } from "./transport";

const SPREADSHEET_ID = "1uUzDUt4McCQFADr4WFZ5NiRTUlg1hOafMLIyljzec7Y";
const SHEET_NAME = "นิยายยังไม่จบ/ยังไม่ยื่น";

const metadata: NqaGoogleSpreadsheetMetadata = {
  spreadsheetId: SPREADSHEET_ID,
  title: "รวมนิยาย",
  locale: "th_TH",
  timeZone: "Asia/Bangkok",
  sheets: [
    {
      sheetId: 0,
      title: SHEET_NAME,
      index: 0,
      rowCount: 3459,
      columnCount: 26,
    },
  ],
};

function sourceMetadata(documentId: string): NqaGoogleDocumentMetadata {
  return {
    documentId,
    title: "Source document",
    revisionId: "rev-1",
    tabs: [
      {
        tabId: "t.0",
        title: "Tab 1",
        index: 0,
        parentTabId: null,
      },
    ],
  };
}
function makeTransport(input: {
  valueRanges: NqaGoogleValueRange[];
  getDocumentMetadata?: (
    documentId: string
  ) => Promise<NqaGoogleDocumentMetadata>;
  spreadsheetMetadata?: NqaGoogleSpreadsheetMetadata;
}) {
  return {
    getSpreadsheetMetadata: vi.fn(
      async () => input.spreadsheetMetadata ?? metadata
    ),
    batchGetValues: vi.fn(async () => input.valueRanges),
    getDocumentMetadata: vi.fn(
      input.getDocumentMetadata ??
        (async documentId => sourceMetadata(documentId))
    ),
  } satisfies NqaGoogleReadOnlyTransport;
}

function adapterFor(
  transport: NqaGoogleReadOnlyTransport,
  overrides: Partial<{
    maxRowsPerScan: number;
    rowsPerBatchRange: number;
    documentConcurrency: number;
    sheetId: number | null;
  }> = {}
) {
  return new NqaGoogleBulkIntakeAdapter(transport, {
    spreadsheetId: SPREADSHEET_ID,
    sheetName: SHEET_NAME,
    sheetId: overrides.sheetId === undefined ? 0 : overrides.sheetId,
    columns: {
      novelTitle: "B",
      translation: "C",
      webSource: "E",
      preparedSource: "K",
    },
    maxRowsPerScan: overrides.maxRowsPerScan,
    rowsPerBatchRange: overrides.rowsPerBatchRange,
    documentConcurrency: overrides.documentConcurrency,
  });
}

describe("NQA Google bulk intake adapter", () => {
  it("captures current Row 1562 with source readable and translation denied", async () => {
    const translationId = "1gRxEHcLI3-e29E0jE0pWtGCGB1HlZm7opL-jcS9IyLQ";
    const sourceId = "1wXZBYJ9Eu586XajNw4R-Q768quKzHsJsIlK-KuWTB0Q";
    const transport = makeTransport({
      valueRanges: [
        {
          range: `'${SHEET_NAME}'!B1562:K1562`,
          majorDimension: "ROWS",
          values: [
            [
              "วันพีซ: ความทรงจำเนื้อเรื่องถูกลบ แต่ผมมีระบบนินจา 181 - 230",
              `https://docs.google.com/document/d/${translationId}/edit?tab=t.5tvv9nt8ogpt`,
              null,
              "https://www.webnovel.com/th/book/the-shinobi-of-straw-hats_19016984905951905",
              "TRUE",
              "FALSE",
              "FALSE",
              "FALSE",
              "FALSE",
              `https://docs.google.com/document/d/${sourceId}/edit`,
            ],
          ],
        },
      ],
      getDocumentMetadata: async documentId => {
        if (documentId === translationId) {
          throw new NqaGoogleTransportError(
            "PERMISSION_DENIED",
            "forbidden",
            403
          );
        }
        return {
          ...sourceMetadata(documentId),
          title:
            "วันพีซ: ความทรงจำเนื้อเรื่องถูกลบ แต่ผมมีระบบนินจา 181 - 230 (ต้นฉบับภาษาอังกฤษ)",
          revisionId:
            "ANLCKQlrksmAFNO1iPtKgVAlfisxIsQbLQc7uTC3g85mxGJsx6yzdO1-tNV-Bgyg8XLgDyFdmWb7I6BP0z3hB_9sNPam8u0pLVZzOoKp1Dk",
        };
      },
    });

    const result = await adapterFor(transport).scanRange({
      startRow: 1562,
      endRow: 1562,
    });

    expect(result.spreadsheet).toMatchObject({
      title: "รวมนิยาย",
      locale: "th_TH",
      timeZone: "Asia/Bangkok",
    });
    expect(result.rows[0].parse.status).toBe("PASS");
    expect(result.rows[0].documents.translation).toMatchObject({
      status: "UNREADABLE",
      documentId: translationId,
      errorCode: "PERMISSION_DENIED",
    });
    expect(result.rows[0].documents.preparedSource).toMatchObject({
      status: "READABLE",
      documentId: sourceId,
      metadata: {
        revisionId:
          "ANLCKQlrksmAFNO1iPtKgVAlfisxIsQbLQc7uTC3g85mxGJsx6yzdO1-tNV-Bgyg8XLgDyFdmWb7I6BP0z3hB_9sNPam8u0pLVZzOoKp1Dk",
      },
    });
    expect(result.providerReadCounts).toEqual({
      spreadsheetMetadata: 1,
      sheetValueBatches: 1,
      uniqueDocuments: 2,
    });
  });

  it("uses configured K position even when live header labels K as notes", async () => {
    const transport = makeTransport({
      valueRanges: [
        {
          range: `'${SHEET_NAME}'!B1558:K1558`,
          majorDimension: "ROWS",
          values: [
            [
              "วันพีซ: ความทรงจำเนื้อเรื่องถูกลบ แต่ผมมีระบบนินจา 001 - 030",
              "https://docs.google.com/document/d/translationDoc12345/edit",
              null,
              "https://www.webnovel.com/source",
              "TRUE",
              "TRUE",
              "FALSE",
              "FALSE",
              "FALSE",
              "ยังไม่ยื่น",
            ],
          ],
        },
      ],
    });

    const result = await adapterFor(transport).scanRange({
      startRow: 1558,
      endRow: 1558,
    });

    expect(result.rows[0].parse).toMatchObject({
      status: "FAIL",
      issues: ["SOURCE_REFERENCE_INVALID"],
    });
    expect(transport.getDocumentMetadata).not.toHaveBeenCalled();
  });
  it("deduplicates document metadata reads within one scan", async () => {
    const translationId = "translationDoc12345";
    const sourceId = "sourceDocument12345";
    const row = [
      "เรื่องทดสอบ 001 - 030",
      `https://docs.google.com/document/d/${translationId}/edit`,
      null,
      "https://example.com/source",
      null,
      null,
      null,
      null,
      null,
      `https://docs.google.com/document/d/${sourceId}/edit`,
    ];
    const transport = makeTransport({
      valueRanges: [
        {
          range: `'${SHEET_NAME}'!B2:K3`,
          majorDimension: "ROWS",
          values: [row, row],
        },
      ],
    });

    const result = await adapterFor(transport).scanRange({
      startRow: 2,
      endRow: 3,
    });

    expect(result.rows).toHaveLength(2);
    expect(result.providerReadCounts.uniqueDocuments).toBe(2);
    expect(transport.getDocumentMetadata).toHaveBeenCalledTimes(2);
  });

  it("plans bounded sheet ranges and preserves every requested row", async () => {
    const translationId = "translationDoc12345";
    const sourceId = "sourceDocument12345";
    const makeRow = (rangeStart: number) => [
      `เรื่องทดสอบ ${String(rangeStart).padStart(3, "0")} - ${String(
        rangeStart + 29
      ).padStart(3, "0")}`,
      `https://docs.google.com/document/d/${translationId}/edit`,
      null,
      "https://example.com/source",
      null,
      null,
      null,
      null,
      null,
      `https://docs.google.com/document/d/${sourceId}/edit`,
    ];
    const transport = makeTransport({
      valueRanges: [
        {
          range: `'${SHEET_NAME}'!B2:K3`,
          majorDimension: "ROWS",
          values: [makeRow(1), makeRow(31)],
        },
        {
          range: `'${SHEET_NAME}'!B4:K5`,
          majorDimension: "ROWS",
          values: [makeRow(61), makeRow(91)],
        },
        {
          range: `'${SHEET_NAME}'!B6:K6`,
          majorDimension: "ROWS",
          values: [makeRow(121)],
        },
      ],
    });

    const result = await adapterFor(transport, {
      rowsPerBatchRange: 2,
    }).scanRange({
      startRow: 2,
      endRow: 6,
    });

    expect(result.rows.map(row => row.row)).toEqual([2, 3, 4, 5, 6]);
    expect(transport.batchGetValues).toHaveBeenCalledTimes(1);
    expect(transport.batchGetValues.mock.calls[0][0].ranges).toEqual([
      `'${SHEET_NAME}'!B2:K3`,
      `'${SHEET_NAME}'!B4:K5`,
      `'${SHEET_NAME}'!B6:K6`,
    ]);
  });

  it("rejects scans larger than the configured safety bound", async () => {
    const transport = makeTransport({ valueRanges: [] });
    const adapter = adapterFor(transport, {
      maxRowsPerScan: 3,
    });

    await expect(
      adapter.scanRange({ startRow: 2, endRow: 5 })
    ).rejects.toMatchObject({ code: "SCAN_TOO_LARGE" });
    expect(transport.getSpreadsheetMetadata).not.toHaveBeenCalled();
  });
  it("fails closed when configured sheet ID does not match live metadata", async () => {
    const transport = makeTransport({ valueRanges: [] });
    const adapter = adapterFor(transport, { sheetId: 999 });

    await expect(
      adapter.scanRange({ startRow: 2, endRow: 2 })
    ).rejects.toMatchObject({ code: "SHEET_ID_MISMATCH" });
    expect(transport.batchGetValues).not.toHaveBeenCalled();
  });

  it("fails closed when Google batch range count is inconsistent", async () => {
    const transport = makeTransport({ valueRanges: [] });

    await expect(
      adapterFor(transport).scanRange({
        startRow: 2,
        endRow: 2,
      })
    ).rejects.toBeInstanceOf(NqaGoogleAdapterError);
    await expect(
      adapterFor(transport).scanRange({
        startRow: 2,
        endRow: 2,
      })
    ).rejects.toMatchObject({ code: "VALUE_RANGE_MISMATCH" });
  });

  it("getRow is a bounded one-row scan", async () => {
    const transport = makeTransport({
      valueRanges: [
        {
          range: `'${SHEET_NAME}'!B2:K2`,
          majorDimension: "ROWS",
          values: [
            [null, null, null, null, null, null, null, null, null, null],
          ],
        },
      ],
    });

    const row = await adapterFor(transport).getRow(2);
    expect(row.row).toBe(2);
    expect(row.parse.status).toBe("FAIL");
    expect(transport.batchGetValues).toHaveBeenCalledTimes(1);
  });
});
