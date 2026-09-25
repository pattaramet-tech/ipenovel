import { parseIntakeRow } from "../intake";
import type {
  NqaGoogleBulkIntakeConfig,
  NqaGoogleBulkRowSnapshot,
  NqaGoogleBulkScanResult,
  NqaGoogleDocumentAccess,
  NqaGoogleProviderErrorCode,
  NqaGoogleReadOnlyTransport,
  NqaGoogleSheetMetadata,
} from "./contracts";
import { NqaGoogleTransportError } from "./transport";

export const NQA_GOOGLE_ADAPTER_ERROR_CODES = [
  "INVALID_SCAN_RANGE",
  "SCAN_TOO_LARGE",
  "SHEET_NOT_FOUND",
  "SHEET_ID_MISMATCH",
  "COLUMN_OUT_OF_BOUNDS",
  "VALUE_RANGE_MISMATCH",
] as const;

export type NqaGoogleAdapterErrorCode =
  (typeof NQA_GOOGLE_ADAPTER_ERROR_CODES)[number];

export class NqaGoogleAdapterError extends Error {
  constructor(
    readonly code: NqaGoogleAdapterErrorCode,
    message: string
  ) {
    super(message);
    this.name = "NqaGoogleAdapterError";
  }
}

type PlannedRange = {
  a1: string;
  startRow: number;
  endRow: number;
};

const DEFAULT_MAX_ROWS_PER_SCAN = 200;
const DEFAULT_ROWS_PER_BATCH_RANGE = 50;
const DEFAULT_DOCUMENT_CONCURRENCY = 4;
const MAX_RANGES_PER_BATCH_REQUEST = 20;
function columnToIndex(column: string): number {
  const normalized = column.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(normalized)) {
    throw new NqaGoogleAdapterError(
      "COLUMN_OUT_OF_BOUNDS",
      "Google Sheet column mapping must use A1 column letters."
    );
  }

  let value = 0;
  for (const character of normalized) {
    value = value * 26 + character.charCodeAt(0) - 64;
  }
  return value - 1;
}

function indexToColumn(index: number): string {
  let value = index + 1;
  let output = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    output = String.fromCharCode(65 + remainder) + output;
    value = Math.floor((value - 1) / 26);
  }
  return output;
}

function quoteSheetName(sheetName: string): string {
  return `'${sheetName.replace(/'/g, "''")}'`;
}

function cellString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
function providerErrorCode(error: unknown): NqaGoogleProviderErrorCode {
  if (error instanceof NqaGoogleTransportError) {
    return error.code;
  }
  return "PROVIDER_ERROR";
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= values.length) return;
      results[current] = await mapper(values[current]);
    }
  }

  const workerCount = Math.min(
    Math.max(1, concurrency),
    Math.max(1, values.length)
  );
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export class NqaGoogleBulkIntakeAdapter {
  private readonly maxRowsPerScan: number;
  private readonly rowsPerBatchRange: number;
  private readonly documentConcurrency: number;

  constructor(
    private readonly transport: NqaGoogleReadOnlyTransport,
    private readonly config: NqaGoogleBulkIntakeConfig
  ) {
    this.maxRowsPerScan = Math.max(
      1,
      config.maxRowsPerScan ?? DEFAULT_MAX_ROWS_PER_SCAN
    );
    this.rowsPerBatchRange = Math.max(
      1,
      config.rowsPerBatchRange ?? DEFAULT_ROWS_PER_BATCH_RANGE
    );
    this.documentConcurrency = Math.max(
      1,
      config.documentConcurrency ?? DEFAULT_DOCUMENT_CONCURRENCY
    );
  }

  private resolveSheet(
    sheets: NqaGoogleSheetMetadata[]
  ): NqaGoogleSheetMetadata {
    const sheet = sheets.find(
      candidate => candidate.title === this.config.sheetName
    );
    if (!sheet) {
      throw new NqaGoogleAdapterError(
        "SHEET_NOT_FOUND",
        `Configured Google Sheet tab not found: ${this.config.sheetName}`
      );
    }

    if (
      this.config.sheetId !== undefined &&
      this.config.sheetId !== null &&
      sheet.sheetId !== this.config.sheetId
    ) {
      throw new NqaGoogleAdapterError(
        "SHEET_ID_MISMATCH",
        "Configured Google Sheet ID does not match the live sheet."
      );
    }

    return sheet;
  }

  private mappedColumns(): {
    minimum: number;
    maximum: number;
    offsets: {
      novelTitle: number;
      translation: number;
      webSource: number;
      preparedSource: number;
    };
  } {
    const indexes = {
      novelTitle: columnToIndex(this.config.columns.novelTitle),
      translation: columnToIndex(this.config.columns.translation),
      webSource: columnToIndex(this.config.columns.webSource),
      preparedSource: columnToIndex(this.config.columns.preparedSource),
    };
    const values = Object.values(indexes);
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);

    return {
      minimum,
      maximum,
      offsets: {
        novelTitle: indexes.novelTitle - minimum,
        translation: indexes.translation - minimum,
        webSource: indexes.webSource - minimum,
        preparedSource: indexes.preparedSource - minimum,
      },
    };
  }

  private planRanges(
    startRow: number,
    endRow: number,
    startColumn: string,
    endColumn: string
  ): PlannedRange[] {
    const ranges: PlannedRange[] = [];
    for (let row = startRow; row <= endRow; row += this.rowsPerBatchRange) {
      const rangeEnd = Math.min(endRow, row + this.rowsPerBatchRange - 1);
      ranges.push({
        a1:
          quoteSheetName(this.config.sheetName) +
          "!" +
          startColumn +
          row +
          ":" +
          endColumn +
          rangeEnd,
        startRow: row,
        endRow: rangeEnd,
      });
    }
    return ranges;
  }

  private async inspectDocument(
    documentId: string
  ): Promise<NqaGoogleDocumentAccess> {
    try {
      const metadata = await this.transport.getDocumentMetadata(documentId);
      return {
        status: "READABLE",
        documentId,
        metadata,
        errorCode: null,
      };
    } catch (error) {
      return {
        status: "UNREADABLE",
        documentId,
        metadata: null,
        errorCode: providerErrorCode(error),
      };
    }
  }

  async scanRange(input: {
    startRow: number;
    endRow: number;
  }): Promise<NqaGoogleBulkScanResult> {
    if (
      !Number.isInteger(input.startRow) ||
      !Number.isInteger(input.endRow) ||
      input.startRow < 2 ||
      input.endRow < input.startRow
    ) {
      throw new NqaGoogleAdapterError(
        "INVALID_SCAN_RANGE",
        "Bulk intake scan range must be integer data rows starting at row 2."
      );
    }

    const rowCount = input.endRow - input.startRow + 1;
    if (rowCount > this.maxRowsPerScan) {
      throw new NqaGoogleAdapterError(
        "SCAN_TOO_LARGE",
        `Bulk intake scan exceeds maxRowsPerScan=${this.maxRowsPerScan}.`
      );
    }

    const spreadsheet = await this.transport.getSpreadsheetMetadata(
      this.config.spreadsheetId
    );
    const sheet = this.resolveSheet(spreadsheet.sheets);
    const columns = this.mappedColumns();

    if (sheet.columnCount !== null && columns.maximum >= sheet.columnCount) {
      throw new NqaGoogleAdapterError(
        "COLUMN_OUT_OF_BOUNDS",
        "Configured intake column exceeds the live sheet column count."
      );
    }
    const plannedRanges = this.planRanges(
      input.startRow,
      input.endRow,
      indexToColumn(columns.minimum),
      indexToColumn(columns.maximum)
    );

    const returnedRanges = [];
    let sheetValueBatches = 0;
    for (const group of chunkArray(
      plannedRanges,
      MAX_RANGES_PER_BATCH_REQUEST
    )) {
      const values = await this.transport.batchGetValues({
        spreadsheetId: this.config.spreadsheetId,
        ranges: group.map(item => item.a1),
      });
      sheetValueBatches += 1;
      if (values.length !== group.length) {
        throw new NqaGoogleAdapterError(
          "VALUE_RANGE_MISMATCH",
          "Google Sheets batch response did not match requested range count."
        );
      }
      returnedRanges.push(...values);
    }

    const rows: NqaGoogleBulkRowSnapshot[] = [];
    for (
      let rangeIndex = 0;
      rangeIndex < plannedRanges.length;
      rangeIndex += 1
    ) {
      const plan = plannedRanges[rangeIndex];
      const values = returnedRanges[rangeIndex]?.values ?? [];
      const expectedRows = plan.endRow - plan.startRow + 1;

      for (let offset = 0; offset < expectedRows; offset += 1) {
        const rowNumber = plan.startRow + offset;
        const cells = values[offset] ?? [];
        const raw = {
          novelTitle: cellString(cells[columns.offsets.novelTitle]),
          translationUrl: cellString(cells[columns.offsets.translation]),
          webSourceUrl: cellString(cells[columns.offsets.webSource]),
          preparedSourceUrl: cellString(cells[columns.offsets.preparedSource]),
        };

        rows.push({
          row: rowNumber,
          raw,
          parse: parseIntakeRow({
            locator: {
              spreadsheetId: this.config.spreadsheetId,
              sheetName: this.config.sheetName,
              sheetId: sheet.sheetId,
              row: rowNumber,
            },
            novelDisplayTitle: raw.novelTitle,
            translationUrl: raw.translationUrl,
            webSourceUrl: raw.webSourceUrl,
            preparedSourceUrl: raw.preparedSourceUrl,
          }),
          documents: {
            translation: null,
            preparedSource: null,
          },
        });
      }
    }

    const uniqueDocumentIds = new Set<string>();
    for (const row of rows) {
      if (row.parse.status !== "PASS") continue;
      uniqueDocumentIds.add(row.parse.contract.translationRef.documentId);
      uniqueDocumentIds.add(row.parse.contract.preparedSourceRef.documentId);
    }

    const documentIds = Array.from(uniqueDocumentIds);
    const accesses = await mapWithConcurrency(
      documentIds,
      this.documentConcurrency,
      documentId => this.inspectDocument(documentId)
    );
    const accessById = new Map(
      accesses.map(access => [access.documentId, access])
    );
    for (const row of rows) {
      if (row.parse.status !== "PASS") continue;
      row.documents.translation =
        accessById.get(row.parse.contract.translationRef.documentId) ?? null;
      row.documents.preparedSource =
        accessById.get(row.parse.contract.preparedSourceRef.documentId) ?? null;
    }

    return {
      spreadsheet,
      sheet,
      startRow: input.startRow,
      endRow: input.endRow,
      rowCount,
      rows,
      providerReadCounts: {
        spreadsheetMetadata: 1,
        sheetValueBatches,
        uniqueDocuments: documentIds.length,
      },
    };
  }

  async getRow(row: number): Promise<NqaGoogleBulkRowSnapshot> {
    const result = await this.scanRange({
      startRow: row,
      endRow: row,
    });
    const snapshot = result.rows[0];
    if (!snapshot) {
      throw new NqaGoogleAdapterError(
        "VALUE_RANGE_MISMATCH",
        "Google Sheets row snapshot was not returned."
      );
    }
    return snapshot;
  }
}
