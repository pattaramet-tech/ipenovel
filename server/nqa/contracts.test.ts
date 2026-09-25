import { describe, expect, it } from "vitest";

import {
  BundleIdentitySchema,
  QaResultSchema,
  SourceContractSchema,
} from "./contracts";

describe("NQA data contracts", () => {
  it("accepts the typed C/K/E intake contract", () => {
    const parsed = SourceContractSchema.parse({
      contractVersion: "nqa-source-contract-v1",
      locator: {
        spreadsheetId: "1uUzDUt4McCQFADr4WFZ5NiRTUlg1hOafMLIyljzec7Y",
        sheetName: "นิยายยังไม่จบ/ยังไม่ยื่น",
        sheetId: 0,
        row: 1562,
      },
      novelDisplayTitle:
        "วันพีซ: ความทรงจำเนื้อเรื่องถูกลบ แต่ผมมีระบบนินจา 181 - 230",
      translationRef: {
        kind: "google_doc",
        column: "C",
        documentId: "1gRxEHcLI3-e29E0jE0pWtGCGB1HlZm7opL-jcS9IyLQ",
      },
      preparedSourceRef: {
        kind: "google_doc",
        column: "K",
        documentId: "1wXZBYJ9Eu586XajNw4R-Q768quKzHsJsIlK-KuWTB0Q",
      },
      webSourceRef: {
        column: "E",
        url: "https://www.webnovel.com/th/book/the-shinobi-of-straw-hats_19016984905951905",
      },
      routingPolicy: "K_PRIMARY_E_FALLBACK_METADATA",
    });

    expect(parsed.preparedSourceRef.column).toBe("K");
    expect(parsed.translationRef.column).toBe("C");
  });

  it("rejects a bundle whose end precedes its start", () => {
    expect(() =>
      BundleIdentitySchema.parse({
        bundleId: "bundle_0123456789abcdef_230_181",
        novelId: "novel_0123456789abcdef",
        rangeStart: 230,
        rangeEnd: 181,
        locator: null,
        translationDocumentId: "translation-document-123",
        sourceDocumentId: "source-document-12345",
      })
    ).toThrow(/rangeEnd/);
  });

  it("requires dimensioned QA output rather than one overall score", () => {
    const base = {
      contractVersion: "nqa-result-v1",
      runId: "run-1",
      inputFingerprint: "a".repeat(64),
      identity: {
        novelId: "novel_0123456789abcdef",
        bundleId: "bundle_0123456789abcdef_181_230",
        sourceInternalSequence: 198,
        sourceChapter: 197,
        sourceTitle: "Possessing",
        translationChapter: 197,
        translationTitle: "การสิงร่าง",
        translationVariant: "corrected_candidate",
      },
      decision: "PASS",
      reasonCodes: [],
      dimensions: {
        meaning: 0.95,
        events: 0.95,
        entities: 0.95,
        relationships: 0.95,
        causality: 0.95,
        chronology: 0.95,
        sourceCoverage: 0.95,
        translationCoverage: 0.95,
        fabricationRisk: 0.01,
        wrongChapterRisk: 0.01,
      },
      confidence: 0.95,
      evidence: [],
      policyVersion: "policy-v1",
      modelSetVersion: "models-v1",
      createdAt: "2026-09-24T00:00:00+07:00",
    };

    expect(QaResultSchema.parse(base).decision).toBe("PASS");
    expect(() =>
      QaResultSchema.parse({ ...base, overallScore: 0.95 })
    ).toThrow();
  });
});
