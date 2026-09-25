import type { IntakeParseResult } from "../intake";

export const NQA_GOOGLE_REQUIRED_READ_ONLY_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/documents.readonly",
] as const;

export const NQA_GOOGLE_OPTIONAL_READ_ONLY_SCOPES = [
  "https://www.googleapis.com/auth/drive.metadata.readonly",
] as const;

export const NQA_GOOGLE_READ_ONLY_SCOPES = [
  ...NQA_GOOGLE_REQUIRED_READ_ONLY_SCOPES,
  ...NQA_GOOGLE_OPTIONAL_READ_ONLY_SCOPES,
] as const;

export const NQA_GOOGLE_PROVIDER_ERROR_CODES = [
  "AUTH_FAILURE",
  "PERMISSION_DENIED",
  "NOT_FOUND",
  "RATE_LIMITED",
  "TRANSIENT_PROVIDER_FAILURE",
  "MALFORMED_RESPONSE",
  "PROVIDER_ERROR",
] as const;

export type NqaGoogleProviderErrorCode =
  (typeof NQA_GOOGLE_PROVIDER_ERROR_CODES)[number];

export type NqaGoogleSheetMetadata = {
  sheetId: number;
  title: string;
  index: number;
  rowCount: number | null;
  columnCount: number | null;
};

export type NqaGoogleSpreadsheetMetadata = {
  spreadsheetId: string;
  title: string | null;
  locale: string | null;
  timeZone: string | null;
  sheets: NqaGoogleSheetMetadata[];
};
export type NqaGoogleValueRange = {
  range: string;
  majorDimension: "ROWS" | string | null;
  values: unknown[][];
};

export type NqaGoogleDocumentTabMetadata = {
  tabId: string;
  title: string | null;
  index: number | null;
  parentTabId: string | null;
};

export type NqaGoogleDocumentMetadata = {
  documentId: string;
  title: string | null;
  revisionId: string | null;
  tabs: NqaGoogleDocumentTabMetadata[];
};

export type NqaGoogleDocumentAccess =
  | {
      status: "READABLE";
      documentId: string;
      metadata: NqaGoogleDocumentMetadata;
      errorCode: null;
    }
  | {
      status: "UNREADABLE";
      documentId: string;
      metadata: null;
      errorCode: NqaGoogleProviderErrorCode;
    };

export type NqaGoogleColumnMapping = {
  novelTitle: string;
  translation: string;
  webSource: string;
  preparedSource: string;
};

export type NqaGoogleBulkIntakeConfig = {
  spreadsheetId: string;
  sheetName: string;
  sheetId?: number | null;
  columns: NqaGoogleColumnMapping;
  maxRowsPerScan?: number;
  rowsPerBatchRange?: number;
  documentConcurrency?: number;
};
export type NqaGoogleBulkRowSnapshot = {
  row: number;
  raw: {
    novelTitle: string | null;
    translationUrl: string | null;
    webSourceUrl: string | null;
    preparedSourceUrl: string | null;
  };
  parse: IntakeParseResult;
  documents: {
    translation: NqaGoogleDocumentAccess | null;
    preparedSource: NqaGoogleDocumentAccess | null;
  };
};

export type NqaGoogleBulkScanResult = {
  spreadsheet: NqaGoogleSpreadsheetMetadata;
  sheet: NqaGoogleSheetMetadata;
  startRow: number;
  endRow: number;
  rowCount: number;
  rows: NqaGoogleBulkRowSnapshot[];
  providerReadCounts: {
    spreadsheetMetadata: number;
    sheetValueBatches: number;
    uniqueDocuments: number;
  };
};

export interface NqaGoogleReadOnlyTransport {
  getSpreadsheetMetadata(
    spreadsheetId: string
  ): Promise<NqaGoogleSpreadsheetMetadata>;

  batchGetValues(input: {
    spreadsheetId: string;
    ranges: string[];
  }): Promise<NqaGoogleValueRange[]>;

  getDocumentMetadata(documentId: string): Promise<NqaGoogleDocumentMetadata>;
}
