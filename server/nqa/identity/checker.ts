import { makeBundleIdentity } from "../core";
import type { NqaGoogleBulkRowSnapshot } from "../google/contracts";
import type {
  NqaIdentityCatalog,
  NqaIntakeCheckResult,
  NqaIntakeReasonCode,
} from "./contracts";
import { NqaNovelIdentityResolver } from "./resolver";

function overlaps(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number
): boolean {
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function addReason(
  result: NqaIntakeCheckResult,
  reason: NqaIntakeReasonCode
): void {
  if (!result.reasonCodes.includes(reason)) {
    result.reasonCodes.push(reason);
  }

  if (result.status !== "INTAKE_FAIL") {
    result.status = "INTAKE_REVIEW";
  }
}

function failResult(
  row: number,
  reasonCodes: NqaIntakeReasonCode[],
  identityResolution: NqaIntakeCheckResult["identityResolution"] = null
): NqaIntakeCheckResult {
  return {
    row,
    status: "INTAKE_FAIL",
    reasonCodes,
    novel: null,
    bundle: null,
    identityResolution,
  };
}

export class NqaIntakeChecker {
  constructor(
    private readonly catalog: NqaIdentityCatalog = {
      novels: [],
      bundles: [],
    },
    private readonly resolver = new NqaNovelIdentityResolver(catalog)
  ) {}

  private checkBase(row: NqaGoogleBulkRowSnapshot): NqaIntakeCheckResult {
    if (row.parse.status !== "PASS") {
      return failResult(row.row, ["CONTRACT_INVALID"]);
    }

    const contract = row.parse.contract;
    if (
      contract.translationRef.documentId ===
      contract.preparedSourceRef.documentId
    ) {
      return failResult(row.row, ["SOURCE_TRANSLATION_SAME_DOCUMENT"]);
    }

    if (
      !row.documents.translation ||
      row.documents.translation.status !== "READABLE"
    ) {
      return failResult(row.row, ["TRANSLATION_DOC_UNREADABLE"]);
    }

    if (
      !row.documents.preparedSource ||
      row.documents.preparedSource.status !== "READABLE"
    ) {
      return failResult(row.row, ["SOURCE_DOC_UNREADABLE"]);
    }
    const identityResolution = this.resolver.resolve({
      canonicalTitle: row.parse.parsedBundle.canonicalTitle,
      contract,
    });

    if (identityResolution.status === "REVIEW") {
      return {
        row: row.row,
        status: "INTAKE_REVIEW",
        reasonCodes: [
          identityResolution.kind === "FUZZY_REVIEW"
            ? "FUZZY_IDENTITY_REVIEW"
            : "IDENTITY_AMBIGUOUS",
        ],
        novel: null,
        bundle: null,
        identityResolution,
      };
    }

    const novel = identityResolution.novel;
    const bundle = makeBundleIdentity({
      novel,
      rangeStart: row.parse.parsedBundle.rangeStart,
      rangeEnd: row.parse.parsedBundle.rangeEnd,
      locator: contract.locator,
      translationDocumentId: contract.translationRef.documentId,
      sourceDocumentId: contract.preparedSourceRef.documentId,
    });

    return {
      row: row.row,
      status: "INTAKE_PASS",
      reasonCodes: [],
      novel,
      bundle,
      identityResolution,
    };
  }

  private applyCatalogChecks(result: NqaIntakeCheckResult): void {
    if (!result.bundle || !result.novel) return;

    for (const entry of this.catalog.bundles) {
      const known = entry.bundle;

      if (known.bundleId === result.bundle.bundleId) {
        const sameDocuments =
          known.translationDocumentId === result.bundle.translationDocumentId &&
          known.sourceDocumentId === result.bundle.sourceDocumentId;

        if (!sameDocuments) {
          addReason(result, "BUNDLE_DOCUMENT_DRIFT");
        }
        continue;
      }

      if (
        known.novelId === result.bundle.novelId &&
        overlaps(
          known.rangeStart,
          known.rangeEnd,
          result.bundle.rangeStart,
          result.bundle.rangeEnd
        )
      ) {
        addReason(result, "OVERLAPPING_BUNDLE_RANGE");
      }

      const reusedTranslation =
        known.translationDocumentId === result.bundle.translationDocumentId;
      const reusedSource =
        known.sourceDocumentId === result.bundle.sourceDocumentId;
      if (reusedTranslation || reusedSource) {
        addReason(result, "DOCUMENT_REUSED_ACROSS_BUNDLES");
      }
    }
  }
  private applyBatchChecks(results: NqaIntakeCheckResult[]): void {
    for (let leftIndex = 0; leftIndex < results.length; leftIndex += 1) {
      const left = results[leftIndex];
      if (!left.bundle || !left.novel) continue;

      for (
        let rightIndex = leftIndex + 1;
        rightIndex < results.length;
        rightIndex += 1
      ) {
        const right = results[rightIndex];
        if (!right.bundle || !right.novel) continue;

        if (left.bundle.bundleId === right.bundle.bundleId) {
          addReason(left, "DUPLICATE_BUNDLE");
          addReason(right, "DUPLICATE_BUNDLE");

          const sameDocuments =
            left.bundle.translationDocumentId ===
              right.bundle.translationDocumentId &&
            left.bundle.sourceDocumentId === right.bundle.sourceDocumentId;
          if (!sameDocuments) {
            addReason(left, "BUNDLE_DOCUMENT_DRIFT");
            addReason(right, "BUNDLE_DOCUMENT_DRIFT");
          }
          continue;
        }

        if (
          left.bundle.novelId === right.bundle.novelId &&
          overlaps(
            left.bundle.rangeStart,
            left.bundle.rangeEnd,
            right.bundle.rangeStart,
            right.bundle.rangeEnd
          )
        ) {
          addReason(left, "OVERLAPPING_BUNDLE_RANGE");
          addReason(right, "OVERLAPPING_BUNDLE_RANGE");
        }

        const reusedDocument =
          left.bundle.translationDocumentId ===
            right.bundle.translationDocumentId ||
          left.bundle.sourceDocumentId === right.bundle.sourceDocumentId;
        if (reusedDocument) {
          addReason(left, "DOCUMENT_REUSED_ACROSS_BUNDLES");
          addReason(right, "DOCUMENT_REUSED_ACROSS_BUNDLES");
        }
      }
    }
  }

  checkRows(rows: NqaGoogleBulkRowSnapshot[]): NqaIntakeCheckResult[] {
    const results = rows.map(row => this.checkBase(row));

    for (const result of results) {
      this.applyCatalogChecks(result);
    }
    this.applyBatchChecks(results);

    return results;
  }

  checkRow(row: NqaGoogleBulkRowSnapshot): NqaIntakeCheckResult {
    return this.checkRows([row])[0];
  }
}
