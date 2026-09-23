import { describe, expect, it } from "vitest";

import { makeBundleIdentity, makeNovelCandidateIdentity } from "../core";
import type { NqaGoogleBulkRowSnapshot } from "../google/contracts";
import { parseIntakeRow } from "../intake";
import type { NqaIdentityCatalog } from "./contracts";
import { NqaIntakeChecker } from "./checker";

function readableDocument(documentId: string) {
  return {
    status: "READABLE" as const,
    documentId,
    metadata: {
      documentId,
      title: "Document",
      revisionId: "rev-1",
      tabs: [],
    },
    errorCode: null,
  };
}

function snapshot(input: {
  row: number;
  title?: string;
  rangeStart?: number;
  rangeEnd?: number;
  translationId?: string;
  sourceId?: string;
  translationReadable?: boolean;
  sourceReadable?: boolean;
  invalidSource?: boolean;
}): NqaGoogleBulkRowSnapshot {
  const title = input.title ?? "เรื่องทดสอบ";
  const start = input.rangeStart ?? 1;
  const end = input.rangeEnd ?? 30;
  const translationId = input.translationId ?? `translationDoc${input.row}ABC`;
  const sourceId = input.sourceId ?? `sourceDocument${input.row}ABC`;

  const parse = parseIntakeRow({
    locator: {
      spreadsheetId: "spreadsheet-12345",
      sheetName: "Sheet",
      sheetId: 1,
      row: input.row,
    },
    novelDisplayTitle: `${title} ${String(start).padStart(3, "0")} - ${String(
      end
    ).padStart(3, "0")}`,
    translationUrl:
      "https://docs.google.com/document/d/" + translationId + "/edit",
    webSourceUrl: "https://example.com/source",
    preparedSourceUrl: input.invalidSource
      ? "not-a-doc-url"
      : "https://docs.google.com/document/d/" + sourceId + "/edit",
  });

  return {
    row: input.row,
    raw: {
      novelTitle: `${title} ${String(start).padStart(3, "0")} - ${String(
        end
      ).padStart(3, "0")}`,
      translationUrl:
        "https://docs.google.com/document/d/" + translationId + "/edit",
      webSourceUrl: "https://example.com/source",
      preparedSourceUrl: input.invalidSource
        ? "not-a-doc-url"
        : "https://docs.google.com/document/d/" + sourceId + "/edit",
    },
    parse,
    documents: {
      translation:
        parse.status === "PASS"
          ? input.translationReadable === false
            ? {
                status: "UNREADABLE",
                documentId: translationId,
                metadata: null,
                errorCode: "PERMISSION_DENIED",
              }
            : readableDocument(translationId)
          : null,
      preparedSource:
        parse.status === "PASS"
          ? input.sourceReadable === false
            ? {
                status: "UNREADABLE",
                documentId: sourceId,
                metadata: null,
                errorCode: "NOT_FOUND",
              }
            : readableDocument(sourceId)
          : null,
    },
  };
}
describe("NQA intake checker", () => {
  it("passes a readable, unique, unambiguous new bundle", () => {
    const checker = new NqaIntakeChecker();
    const result = checker.checkRow(
      snapshot({
        row: 10,
        title: "เรื่องใหม่",
        rangeStart: 1,
        rangeEnd: 30,
      })
    );

    expect(result).toMatchObject({
      row: 10,
      status: "INTAKE_PASS",
      reasonCodes: [],
      identityResolution: {
        status: "NEW",
        kind: "STRUCTURED_NEW",
      },
    });
    expect(result.novel?.novelId).toMatch(/^novel_[a-f0-9]{16}$/);
    expect(result.bundle?.bundleId).toContain("_1_30");
  });

  it("fails a malformed Source Contract", () => {
    const checker = new NqaIntakeChecker();
    const result = checker.checkRow(
      snapshot({
        row: 11,
        invalidSource: true,
      })
    );

    expect(result).toMatchObject({
      status: "INTAKE_FAIL",
      reasonCodes: ["CONTRACT_INVALID"],
      novel: null,
      bundle: null,
    });
  });

  it("fails when the translation document is unreadable", () => {
    const checker = new NqaIntakeChecker();
    const result = checker.checkRow(
      snapshot({
        row: 12,
        translationReadable: false,
      })
    );

    expect(result).toMatchObject({
      status: "INTAKE_FAIL",
      reasonCodes: ["TRANSLATION_DOC_UNREADABLE"],
    });
  });

  it("fails when the prepared source document is unreadable", () => {
    const checker = new NqaIntakeChecker();
    const result = checker.checkRow(
      snapshot({
        row: 13,
        sourceReadable: false,
      })
    );

    expect(result).toMatchObject({
      status: "INTAKE_FAIL",
      reasonCodes: ["SOURCE_DOC_UNREADABLE"],
    });
  });
  it("fails when C and K point to the same Google Doc", () => {
    const checker = new NqaIntakeChecker();
    const same = "sameDocument12345";
    const result = checker.checkRow(
      snapshot({
        row: 14,
        translationId: same,
        sourceId: same,
      })
    );

    expect(result).toMatchObject({
      status: "INTAKE_FAIL",
      reasonCodes: ["SOURCE_TRANSLATION_SAME_DOCUMENT"],
    });
  });

  it("reviews fuzzy identity candidates without auto-merging", () => {
    const canonical = "วันพีซ ความทรงจำเนื้อเรื่องถูกลบ แต่ผมมีระบบนินจา";
    const novel = makeNovelCandidateIdentity(canonical);
    const catalog: NqaIdentityCatalog = {
      novels: [
        {
          novel,
          translationDocumentIds: [],
          sourceDocumentIds: [],
        },
      ],
      bundles: [],
    };
    const checker = new NqaIntakeChecker(catalog);
    const result = checker.checkRow(
      snapshot({
        row: 15,
        title: "วันพีซ ความทรงจำเนื้อเรื่องถูกลบ แต่ผมมีระบบนินจ",
      })
    );

    expect(result).toMatchObject({
      status: "INTAKE_REVIEW",
      reasonCodes: ["FUZZY_IDENTITY_REVIEW"],
      novel: null,
      bundle: null,
      identityResolution: {
        status: "REVIEW",
        kind: "FUZZY_REVIEW",
      },
    });
  });

  it("reviews duplicate logical bundles in the same batch", () => {
    const checker = new NqaIntakeChecker();
    const rows = [
      snapshot({
        row: 20,
        title: "เรื่องเดียวกัน",
        rangeStart: 1,
        rangeEnd: 30,
        translationId: "translationDupA123",
        sourceId: "sourceDupA12345",
      }),
      snapshot({
        row: 21,
        title: "เรื่องเดียวกัน",
        rangeStart: 1,
        rangeEnd: 30,
        translationId: "translationDupB123",
        sourceId: "sourceDupB12345",
      }),
    ];

    const results = checker.checkRows(rows);

    expect(results).toHaveLength(2);
    expect(
      results.every(result => result.reasonCodes.includes("DUPLICATE_BUNDLE"))
    ).toBe(true);
    expect(
      results.every(result =>
        result.reasonCodes.includes("BUNDLE_DOCUMENT_DRIFT")
      )
    ).toBe(true);
    expect(results.every(result => result.status === "INTAKE_REVIEW")).toBe(
      true
    );
  });
  it("reviews overlapping ranges for the same novel", () => {
    const checker = new NqaIntakeChecker();
    const results = checker.checkRows([
      snapshot({
        row: 30,
        title: "เรื่องช่วงซ้อน",
        rangeStart: 1,
        rangeEnd: 30,
      }),
      snapshot({
        row: 31,
        title: "เรื่องช่วงซ้อน",
        rangeStart: 25,
        rangeEnd: 50,
      }),
    ]);

    expect(
      results.every(result =>
        result.reasonCodes.includes("OVERLAPPING_BUNDLE_RANGE")
      )
    ).toBe(true);
  });

  it("reviews reuse of a document across different bundles", () => {
    const sharedSource = "sharedSourceDocument123";
    const checker = new NqaIntakeChecker();
    const results = checker.checkRows([
      snapshot({
        row: 40,
        title: "เรื่อง reuse",
        rangeStart: 1,
        rangeEnd: 30,
        sourceId: sharedSource,
      }),
      snapshot({
        row: 41,
        title: "เรื่อง reuse",
        rangeStart: 31,
        rangeEnd: 60,
        sourceId: sharedSource,
      }),
    ]);

    expect(
      results.every(result =>
        result.reasonCodes.includes("DOCUMENT_REUSED_ACROSS_BUNDLES")
      )
    ).toBe(true);
  });

  it("accepts the same known bundle after row drift when documents are unchanged", () => {
    const novel = makeNovelCandidateIdentity("เรื่องย้ายแถว");
    const knownBundle = makeBundleIdentity({
      novel,
      rangeStart: 1,
      rangeEnd: 30,
      locator: {
        spreadsheetId: "spreadsheet-12345",
        sheetName: "Sheet",
        sheetId: 1,
        row: 100,
      },
      translationDocumentId: "translationStable123",
      sourceDocumentId: "sourceStableDocument123",
    });
    const catalog: NqaIdentityCatalog = {
      novels: [
        {
          novel,
          translationDocumentIds: ["translationStable123"],
          sourceDocumentIds: ["sourceStableDocument123"],
        },
      ],
      bundles: [{ bundle: knownBundle }],
    };
    const checker = new NqaIntakeChecker(catalog);
    const result = checker.checkRow(
      snapshot({
        row: 200,
        title: "เรื่องย้ายแถว",
        rangeStart: 1,
        rangeEnd: 30,
        translationId: "translationStable123",
        sourceId: "sourceStableDocument123",
      })
    );

    expect(result.status).toBe("INTAKE_PASS");
    expect(result.bundle?.bundleId).toBe(knownBundle.bundleId);
    expect(result.reasonCodes).toEqual([]);
  });
  it("reviews document drift for a known logical bundle", () => {
    const novel = makeNovelCandidateIdentity("เรื่องเอกสารเปลี่ยน");
    const knownBundle = makeBundleIdentity({
      novel,
      rangeStart: 1,
      rangeEnd: 30,
      locator: null,
      translationDocumentId: "translationOld12345",
      sourceDocumentId: "sourceOldDocument123",
    });
    const catalog: NqaIdentityCatalog = {
      novels: [
        {
          novel,
          translationDocumentIds: [],
          sourceDocumentIds: [],
        },
      ],
      bundles: [{ bundle: knownBundle }],
    };
    const checker = new NqaIntakeChecker(catalog);
    const result = checker.checkRow(
      snapshot({
        row: 50,
        title: "เรื่องเอกสารเปลี่ยน",
        rangeStart: 1,
        rangeEnd: 30,
        translationId: "translationNew12345",
        sourceId: "sourceNewDocument123",
      })
    );

    expect(result).toMatchObject({
      status: "INTAKE_REVIEW",
      reasonCodes: ["BUNDLE_DOCUMENT_DRIFT"],
    });
  });

  it("marks the current canonical Row 1562 shape as fail when C is permission denied", () => {
    const checker = new NqaIntakeChecker();
    const result = checker.checkRow(
      snapshot({
        row: 1562,
        title: "วันพีซ: ความทรงจำเนื้อเรื่องถูกลบ แต่ผมมีระบบนินจา",
        rangeStart: 181,
        rangeEnd: 230,
        translationId: "1gRxEHcLI3-e29E0jE0pWtGCGB1HlZm7opL-jcS9IyLQ",
        sourceId: "1wXZBYJ9Eu586XajNw4R-Q768quKzHsJsIlK-KuWTB0Q",
        translationReadable: false,
      })
    );

    expect(result).toMatchObject({
      row: 1562,
      status: "INTAKE_FAIL",
      reasonCodes: ["TRANSLATION_DOC_UNREADABLE"],
    });
  });
});
