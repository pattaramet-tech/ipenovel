import type {
  NqaGoogleAccessTokenProvider,
  NqaGoogleFetch,
} from "../google/transport";
import { NqaGoogleTransportError } from "../google/transport";
import type {
  NqaDocumentParagraph,
  NqaDocumentSnapshot,
  NqaDocumentTabSnapshot,
} from "./contracts";

export interface NqaChapterDocumentReader {
  readDocument(documentId: string): Promise<NqaDocumentSnapshot>;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function paragraphsFromContent(
  content: unknown,
  tabId: string
): NqaDocumentParagraph[] {
  const paragraphs: NqaDocumentParagraph[] = [];

  for (const rawElement of asArray(content)) {
    const element = asRecord(rawElement);
    const paragraph = asRecord(element.paragraph);
    if (Object.keys(paragraph).length === 0) continue;

    const pieces: string[] = [];
    for (const rawParagraphElement of asArray(paragraph.elements)) {
      const paragraphElement = asRecord(rawParagraphElement);
      const textRun = asRecord(paragraphElement.textRun);
      const contentText = stringValue(textRun.content);
      if (contentText !== null) pieces.push(contentText);
    }

    const text = pieces.join("").replace(/\n$/, "");
    const startIndex = numberValue(element.startIndex);
    const endIndex = numberValue(element.endIndex);
    if (startIndex === null || endIndex === null) continue;

    paragraphs.push({
      text,
      startIndex,
      endIndex,
      tabId,
    });
  }

  return paragraphs;
}
function flattenTabs(
  tabs: unknown,
  output: NqaDocumentTabSnapshot[] = []
): NqaDocumentTabSnapshot[] {
  for (const rawTab of asArray(tabs)) {
    const tab = asRecord(rawTab);
    const properties = asRecord(tab.tabProperties);
    const tabId = stringValue(properties.tabId);
    if (!tabId) continue;

    const documentTab = asRecord(tab.documentTab);
    const body = asRecord(documentTab.body);
    output.push({
      tabId,
      title: stringValue(properties.title),
      index: numberValue(properties.index),
      parentTabId: stringValue(properties.parentTabId),
      paragraphs: paragraphsFromContent(body.content, tabId),
    });

    flattenTabs(tab.childTabs, output);
  }

  return output;
}

function classifyStatus(status: number) {
  if (status === 401) return "AUTH_FAILURE" as const;
  if (status === 403) return "PERMISSION_DENIED" as const;
  if (status === 404) return "NOT_FOUND" as const;
  if (status === 429) return "RATE_LIMITED" as const;
  if (status >= 500) return "TRANSIENT_PROVIDER_FAILURE" as const;
  return "PROVIDER_ERROR" as const;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, milliseconds));
}

export class GoogleDocsChapterReader implements NqaChapterDocumentReader {
  constructor(
    private readonly input: {
      accessTokenProvider: NqaGoogleAccessTokenProvider;
      fetchFn?: NqaGoogleFetch;
      maxAttempts?: number;
      baseRetryDelayMs?: number;
      sleep?: (milliseconds: number) => Promise<void>;
    }
  ) {}

  async readDocument(documentId: string): Promise<NqaDocumentSnapshot> {
    const token = await this.input.accessTokenProvider();
    if (!token || !token.trim()) {
      throw new NqaGoogleTransportError(
        "AUTH_FAILURE",
        "Google access token is unavailable."
      );
    }

    const fetchFn = this.input.fetchFn ?? fetch;
    const fields = "documentId,title,revisionId,tabs,body";
    const url =
      "https://docs.googleapis.com/v1/documents/" +
      encodeURIComponent(documentId) +
      "?includeTabsContent=true&fields=" +
      encodeURIComponent(fields);
    const maxAttempts = Math.max(1, this.input.maxAttempts ?? 3);
    const baseRetryDelayMs = Math.max(0, this.input.baseRetryDelayMs ?? 100);
    const sleep = this.input.sleep ?? defaultSleep;

    let response: Response | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        response = await fetchFn(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
        });
      } catch {
        if (attempt < maxAttempts) {
          await sleep(baseRetryDelayMs * Math.pow(2, attempt - 1));
          continue;
        }
        throw new NqaGoogleTransportError(
          "TRANSIENT_PROVIDER_FAILURE",
          "Google Docs chapter read failed before a response was received."
        );
      }

      if (
        !response.ok &&
        isRetryableStatus(response.status) &&
        attempt < maxAttempts
      ) {
        await response.text();
        await sleep(baseRetryDelayMs * Math.pow(2, attempt - 1));
        continue;
      }
      break;
    }

    if (!response) {
      throw new NqaGoogleTransportError(
        "TRANSIENT_PROVIDER_FAILURE",
        "Google Docs chapter read exhausted retry attempts."
      );
    }

    const text = await response.text();
    if (!response.ok) {
      throw new NqaGoogleTransportError(
        classifyStatus(response.status),
        `Google Docs chapter read failed with status ${response.status}.`,
        response.status
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new NqaGoogleTransportError(
        "MALFORMED_RESPONSE",
        "Google Docs chapter response was malformed JSON."
      );
    }

    const root = asRecord(parsed);
    const tabs = flattenTabs(root.tabs);

    if (tabs.length === 0) {
      const body = asRecord(root.body);
      tabs.push({
        tabId: "t.0",
        title: null,
        index: 0,
        parentTabId: null,
        paragraphs: paragraphsFromContent(body.content, "t.0"),
      });
    }

    return {
      documentId: stringValue(root.documentId) ?? documentId,
      title: stringValue(root.title),
      revisionId: stringValue(root.revisionId),
      tabs,
    };
  }
}
