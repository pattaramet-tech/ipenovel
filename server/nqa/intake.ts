import {
  NQA_SOURCE_CONTRACT_VERSION,
  SourceContractSchema,
  type SheetLocator,
  type SourceContract,
} from "./contracts";
import { parseBundleDisplayTitle, type ParsedBundleTitle } from "./core";

export type IntakeIssueCode =
  | "NOVEL_TITLE_MISSING"
  | "BUNDLE_RANGE_UNRESOLVED"
  | "TRANSLATION_REFERENCE_MISSING"
  | "TRANSLATION_REFERENCE_INVALID"
  | "SOURCE_REFERENCE_MISSING"
  | "SOURCE_REFERENCE_INVALID"
  | "WEB_REFERENCE_INVALID";

export type IntakeRowInput = {
  locator: SheetLocator;
  novelDisplayTitle: string | null | undefined;
  translationUrl: string | null | undefined;
  webSourceUrl?: string | null;
  preparedSourceUrl: string | null | undefined;
};

export type IntakeParseResult =
  | {
      status: "PASS";
      contract: SourceContract;
      parsedBundle: ParsedBundleTitle;
      issues: [];
    }
  | {
      status: "FAIL";
      contract: null;
      parsedBundle: ParsedBundleTitle | null;
      issues: IntakeIssueCode[];
    };

export function extractGoogleDocId(input: string): string | null {
  const trimmed = input.trim();
  const match = trimmed.match(
    /^https:\/\/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]+)(?:\/|$)/
  );
  return match?.[1] ?? null;
}

function isHttpUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function parseIntakeRow(input: IntakeRowInput): IntakeParseResult {
  const issues: IntakeIssueCode[] = [];
  const title = input.novelDisplayTitle?.trim() ?? "";
  const parsedBundle = title ? parseBundleDisplayTitle(title) : null;

  if (!title) {
    issues.push("NOVEL_TITLE_MISSING");
  } else if (!parsedBundle) {
    issues.push("BUNDLE_RANGE_UNRESOLVED");
  }

  const translationUrl = input.translationUrl?.trim() ?? "";
  const translationDocumentId = translationUrl
    ? extractGoogleDocId(translationUrl)
    : null;
  if (!translationUrl) {
    issues.push("TRANSLATION_REFERENCE_MISSING");
  } else if (!translationDocumentId) {
    issues.push("TRANSLATION_REFERENCE_INVALID");
  }

  const preparedSourceUrl = input.preparedSourceUrl?.trim() ?? "";
  const sourceDocumentId = preparedSourceUrl
    ? extractGoogleDocId(preparedSourceUrl)
    : null;
  if (!preparedSourceUrl) {
    issues.push("SOURCE_REFERENCE_MISSING");
  } else if (!sourceDocumentId) {
    issues.push("SOURCE_REFERENCE_INVALID");
  }

  const webSourceUrl = input.webSourceUrl?.trim() || null;
  if (webSourceUrl && !isHttpUrl(webSourceUrl)) {
    issues.push("WEB_REFERENCE_INVALID");
  }

  if (
    issues.length > 0 ||
    !parsedBundle ||
    !translationDocumentId ||
    !sourceDocumentId
  ) {
    return {
      status: "FAIL",
      contract: null,
      parsedBundle,
      issues,
    };
  }

  const contract = SourceContractSchema.parse({
    contractVersion: NQA_SOURCE_CONTRACT_VERSION,
    locator: input.locator,
    novelDisplayTitle: title,
    translationRef: {
      kind: "google_doc",
      column: "C",
      documentId: translationDocumentId,
      url: translationUrl,
    },
    preparedSourceRef: {
      kind: "google_doc",
      column: "K",
      documentId: sourceDocumentId,
      url: preparedSourceUrl,
    },
    webSourceRef: webSourceUrl
      ? {
          column: "E",
          url: webSourceUrl,
        }
      : null,
    routingPolicy: "K_PRIMARY_E_FALLBACK_METADATA",
  });

  return {
    status: "PASS",
    contract,
    parsedBundle,
    issues: [],
  };
}
