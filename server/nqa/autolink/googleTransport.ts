import {
  NqaGoogleTransportError,
  type NqaGoogleFetch,
  type NqaGoogleTransportOptions,
} from "../google/transport";
import type {
  NqaNovelIdBackfillWriteReceipt,
  NqaNovelIdSheetBackfillTransport,
  NqaNovelIdSheetRowIdentity,
} from "./contracts";

export const NQA_GOOGLE_NOVEL_ID_BACKFILL_SCOPE =
  "https://www.googleapis.com/auth/spreadsheets" as const;

function quoteSheetName(sheetName: string): string {
  return "'" + sheetName.replace(/'/g, "''") + "'";
}

function cellString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NqaGoogleTransportError(
      "MALFORMED_RESPONSE",
      "Google Sheets backfill response shape was invalid."
    );
  }
  return value as Record<string, unknown>;
}

function optionalNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function classifyStatus(status: number) {
  if (status === 401) return "AUTH_FAILURE" as const;
  if (status === 403) return "PERMISSION_DENIED" as const;
  if (status === 404) return "NOT_FOUND" as const;
  if (status === 429) return "RATE_LIMITED" as const;
  if (status >= 500) return "TRANSIENT_PROVIDER_FAILURE" as const;
  return "PROVIDER_ERROR" as const;
}

async function safeResponseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new NqaGoogleTransportError(
      "MALFORMED_RESPONSE",
      "Google Sheets backfill response was malformed JSON.",
      response.status
    );
  }
}

export class GoogleRestNovelIdSheetBackfillTransport implements NqaNovelIdSheetBackfillTransport {
  private readonly fetchFn: NqaGoogleFetch;

  constructor(private readonly options: NqaGoogleTransportOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  private async token(): Promise<string> {
    const token = await this.options.accessTokenProvider();
    if (!token || !token.trim()) {
      throw new NqaGoogleTransportError(
        "AUTH_FAILURE",
        "Google Sheets backfill access token is unavailable."
      );
    }
    return token;
  }

  private async request(input: {
    url: string;
    method: "GET" | "PUT";
    body?: unknown;
  }): Promise<unknown> {
    const token = await this.token();
    let response: Response;
    try {
      response = await this.fetchFn(input.url, {
        method: input.method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(input.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      });
    } catch {
      throw new NqaGoogleTransportError(
        "TRANSIENT_PROVIDER_FAILURE",
        "Google Sheets backfill request failed before a response was received."
      );
    }

    if (!response.ok) {
      throw new NqaGoogleTransportError(
        classifyStatus(response.status),
        `Google Sheets backfill request failed with status ${response.status}.`,
        response.status
      );
    }
    return await safeResponseJson(response);
  }

  private async metadata(spreadsheetId: string): Promise<{
    spreadsheetId: string;
    spreadsheetTitle: string | null;
    sheetTitles: string[];
  }> {
    const fields = "spreadsheetId,properties(title),sheets(properties(title))";
    const url =
      "https://sheets.googleapis.com/v4/spreadsheets/" +
      encodeURIComponent(spreadsheetId) +
      "?includeGridData=false&fields=" +
      encodeURIComponent(fields);
    const root = asRecord(await this.request({ url, method: "GET" }));
    const properties = asRecord(root.properties ?? {});
    const rawSheets = Array.isArray(root.sheets) ? root.sheets : [];
    return {
      spreadsheetId:
        typeof root.spreadsheetId === "string"
          ? root.spreadsheetId
          : spreadsheetId,
      spreadsheetTitle:
        typeof properties.title === "string" ? properties.title : null,
      sheetTitles: rawSheets.map(raw => {
        const sheet = asRecord(raw);
        const props = asRecord(sheet.properties ?? {});
        return typeof props.title === "string" ? props.title : "";
      }),
    };
  }

  async readRowIdentity(input: {
    spreadsheetId: string;
    sheetName: string;
    row: number;
  }): Promise<NqaNovelIdSheetRowIdentity> {
    const metadata = await this.metadata(input.spreadsheetId);
    if (!metadata.sheetTitles.includes(input.sheetName)) {
      throw new NqaGoogleTransportError(
        "NOT_FOUND",
        "Configured Google Sheet tab for novel-id backfill was not found."
      );
    }

    const range =
      quoteSheetName(input.sheetName) + "!A" + input.row + ":B" + input.row;
    const url =
      "https://sheets.googleapis.com/v4/spreadsheets/" +
      encodeURIComponent(input.spreadsheetId) +
      "/values/" +
      encodeURIComponent(range) +
      "?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE";
    const root = asRecord(await this.request({ url, method: "GET" }));
    const values = Array.isArray(root.values) ? root.values : [];
    const rowValues = Array.isArray(values[0]) ? (values[0] as unknown[]) : [];

    return {
      spreadsheetId: metadata.spreadsheetId,
      spreadsheetTitle: metadata.spreadsheetTitle,
      sheetName: input.sheetName,
      row: input.row,
      novelIdCell: cellString(rowValues[0]),
      novelTitle: cellString(rowValues[1]),
    };
  }

  async writeNovelId(input: {
    spreadsheetId: string;
    sheetName: string;
    row: number;
    novelId: number;
  }): Promise<NqaNovelIdBackfillWriteReceipt> {
    const range = quoteSheetName(input.sheetName) + "!A" + input.row;
    const url =
      "https://sheets.googleapis.com/v4/spreadsheets/" +
      encodeURIComponent(input.spreadsheetId) +
      "/values/" +
      encodeURIComponent(range) +
      "?valueInputOption=RAW&includeValuesInResponse=true";
    const root = asRecord(
      await this.request({
        url,
        method: "PUT",
        body: {
          range,
          majorDimension: "ROWS",
          values: [[input.novelId]],
        },
      })
    );

    return {
      updatedRange:
        typeof root.updatedRange === "string" ? root.updatedRange : range,
      updatedRows: optionalNumber(root.updatedRows),
      updatedColumns: optionalNumber(root.updatedColumns),
      updatedCells: optionalNumber(root.updatedCells),
    };
  }
}
