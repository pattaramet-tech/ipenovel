import type {
  NqaGoogleDocumentMetadata,
  NqaGoogleDocumentTabMetadata,
  NqaGoogleProviderErrorCode,
  NqaGoogleReadOnlyTransport,
  NqaGoogleSpreadsheetMetadata,
  NqaGoogleValueRange,
} from "./contracts";

export class NqaGoogleTransportError extends Error {
  constructor(
    readonly code: NqaGoogleProviderErrorCode,
    message: string,
    readonly status: number | null = null
  ) {
    super(message);
    this.name = "NqaGoogleTransportError";
  }
}

export type NqaGoogleAccessTokenProvider = () => Promise<string> | string;

export type NqaGoogleFetch = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

export type NqaGoogleTransportOptions = {
  accessTokenProvider: NqaGoogleAccessTokenProvider;
  fetchFn?: NqaGoogleFetch;
  maxAttempts?: number;
  baseRetryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_RETRY_DELAY_MS = 100;
function classifyStatus(status: number): NqaGoogleProviderErrorCode {
  if (status === 401) return "AUTH_FAILURE";
  if (status === 403) return "PERMISSION_DENIED";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "TRANSIENT_PROVIDER_FAILURE";
  return "PROVIDER_ERROR";
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, milliseconds));
}

function safeJsonParse(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new NqaGoogleTransportError(
      "MALFORMED_RESPONSE",
      "Google API returned malformed JSON."
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NqaGoogleTransportError(
      "MALFORMED_RESPONSE",
      "Google API response shape was invalid."
    );
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function flattenDocumentTabs(
  tabs: unknown,
  output: NqaGoogleDocumentTabMetadata[] = []
): NqaGoogleDocumentTabMetadata[] {
  if (!Array.isArray(tabs)) return output;

  for (const rawTab of tabs) {
    const tab = asRecord(rawTab);
    const properties = asRecord(tab.tabProperties ?? {});
    const tabId = optionalString(properties.tabId);
    if (tabId) {
      output.push({
        tabId,
        title: optionalString(properties.title),
        index: optionalNumber(properties.index),
        parentTabId: optionalString(properties.parentTabId),
      });
    }
    flattenDocumentTabs(tab.childTabs, output);
  }

  return output;
}

export class GoogleRestReadOnlyTransport implements NqaGoogleReadOnlyTransport {
  private readonly fetchFn: NqaGoogleFetch;
  private readonly maxAttempts: number;
  private readonly baseRetryDelayMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: NqaGoogleTransportOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.baseRetryDelayMs = Math.max(
      0,
      options.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS
    );
    this.sleep = options.sleep ?? defaultSleep;
  }

  private async requestJson(url: string): Promise<unknown> {
    const token = await this.options.accessTokenProvider();
    if (!token || !token.trim()) {
      throw new NqaGoogleTransportError(
        "AUTH_FAILURE",
        "Google access token is unavailable."
      );
    }

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchFn(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
        });
      } catch {
        if (attempt < this.maxAttempts) {
          await this.sleep(this.baseRetryDelayMs * Math.pow(2, attempt - 1));
          continue;
        }
        throw new NqaGoogleTransportError(
          "TRANSIENT_PROVIDER_FAILURE",
          "Google API request failed before a response was received."
        );
      }

      const text = await response.text();
      if (response.ok) {
        return safeJsonParse(text);
      }
      const code = classifyStatus(response.status);
      if (isRetryableStatus(response.status) && attempt < this.maxAttempts) {
        await this.sleep(this.baseRetryDelayMs * Math.pow(2, attempt - 1));
        continue;
      }

      throw new NqaGoogleTransportError(
        code,
        `Google API read failed with status ${response.status}.`,
        response.status
      );
    }

    throw new NqaGoogleTransportError(
      "TRANSIENT_PROVIDER_FAILURE",
      "Google API read exhausted retry attempts."
    );
  }

  async getSpreadsheetMetadata(
    spreadsheetId: string
  ): Promise<NqaGoogleSpreadsheetMetadata> {
    const fields = [
      "spreadsheetId",
      "properties(title,locale,timeZone)",
      "sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))",
    ].join(",");
    const url =
      "https://sheets.googleapis.com/v4/spreadsheets/" +
      encodeURIComponent(spreadsheetId) +
      "?includeGridData=false&fields=" +
      encodeURIComponent(fields);

    const root = asRecord(await this.requestJson(url));
    const properties = asRecord(root.properties ?? {});
    const sheets = Array.isArray(root.sheets) ? root.sheets : [];

    return {
      spreadsheetId: optionalString(root.spreadsheetId) ?? spreadsheetId,
      title: optionalString(properties.title),
      locale: optionalString(properties.locale),
      timeZone: optionalString(properties.timeZone),
      sheets: sheets.map(rawSheet => {
        const sheet = asRecord(rawSheet);
        const sheetProperties = asRecord(sheet.properties ?? {});
        const grid = asRecord(sheetProperties.gridProperties ?? {});
        return {
          sheetId: optionalNumber(sheetProperties.sheetId) ?? -1,
          title: optionalString(sheetProperties.title) ?? "",
          index: optionalNumber(sheetProperties.index) ?? -1,
          rowCount: optionalNumber(grid.rowCount),
          columnCount: optionalNumber(grid.columnCount),
        };
      }),
    };
  }

  async batchGetValues(input: {
    spreadsheetId: string;
    ranges: string[];
  }): Promise<NqaGoogleValueRange[]> {
    const params = new URLSearchParams();
    for (const range of input.ranges) {
      params.append("ranges", range);
    }
    params.set("majorDimension", "ROWS");
    params.set("valueRenderOption", "FORMATTED_VALUE");

    const url =
      "https://sheets.googleapis.com/v4/spreadsheets/" +
      encodeURIComponent(input.spreadsheetId) +
      "/values:batchGet?" +
      params.toString();

    const root = asRecord(await this.requestJson(url));
    const valueRanges = Array.isArray(root.valueRanges) ? root.valueRanges : [];

    return valueRanges.map(rawRange => {
      const range = asRecord(rawRange);
      return {
        range: optionalString(range.range) ?? "",
        majorDimension: optionalString(range.majorDimension),
        values: Array.isArray(range.values)
          ? (range.values as unknown[][])
          : [],
      };
    });
  }
  async getDocumentMetadata(
    documentId: string
  ): Promise<NqaGoogleDocumentMetadata> {
    const fields =
      "documentId,title,revisionId,tabs(tabProperties,childTabs(tabProperties))";
    const url =
      "https://docs.googleapis.com/v1/documents/" +
      encodeURIComponent(documentId) +
      "?includeTabsContent=false&fields=" +
      encodeURIComponent(fields);

    const root = asRecord(await this.requestJson(url));
    return {
      documentId: optionalString(root.documentId) ?? documentId,
      title: optionalString(root.title),
      revisionId: optionalString(root.revisionId),
      tabs: flattenDocumentTabs(root.tabs),
    };
  }
}
