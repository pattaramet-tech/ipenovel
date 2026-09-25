import { describe, expect, it } from "vitest";

import { materializeNqaCandidatePolicy } from "./materialize";
import { revalidateNqaCandidatePolicy } from "./revalidate";
import {
  BASE_POLICY,
  buildPromotedFixture,
  makeCuratedCase,
  makeSignedCurationExport,
} from "./testSupport";

describe("NQA M16 controlled shadow revalidation", () => {
  it("revalidates the inactive candidate on a distinct compatible human-confirmed dataset", () => {
    const { promotionGate, promotionExport } = buildPromotedFixture();
    const materializedPolicy = materializeNqaCandidatePolicy({
      promotionGate,
      basePolicy: BASE_POLICY,
    });
    const shadowExport = makeSignedCurationExport({
      runId: "m16-fresh-shadow",
    });

    const result = revalidateNqaCandidatePolicy({
      promotionGate,
      materializedPolicy,
      curationExport: shadowExport,
    });

    expect(result.gateDecision).toBe("PROMOTE");
    expect(result.gateFailureReasons).toEqual([]);
    expect(result.datasetIsDistinctFromPromotion).toBe(true);
    expect(result.shadowSourceDatasetFingerprint).not.toBe(
      promotionExport.datasetFingerprint
    );
    expect(result.criteria).toEqual(promotionGate.criteria);
    expect(result.materializedPolicyFingerprint).toBe(
      materializedPolicy.policyFingerprint
    );
  });

  it("records same-dataset revalidation without disguising it as fresh evidence", () => {
    const { promotionGate, promotionExport } = buildPromotedFixture();
    const materializedPolicy = materializeNqaCandidatePolicy({
      promotionGate,
      basePolicy: BASE_POLICY,
    });

    const result = revalidateNqaCandidatePolicy({
      promotionGate,
      materializedPolicy,
      curationExport: promotionExport,
    });

    expect(result.gateDecision).toBe("PROMOTE");
    expect(result.datasetIsDistinctFromPromotion).toBe(false);
  });

  it("returns a shadow HOLD when the fresh evidence violates the original M15 criteria", () => {
    const { promotionGate } = buildPromotedFixture();
    const materializedPolicy = materializeNqaCandidatePolicy({
      promotionGate,
      basePolicy: BASE_POLICY,
    });
    const cases = [
      makeCuratedCase({
        caseId: "pass-a",
        row: 1,
        truth: "PASS",
        meanRerankScore: 0.85,
        sourceCoverage: 0.95,
        translationCoverage: 0.95,
      }),
      makeCuratedCase({
        caseId: "pass-borderline",
        row: 2,
        truth: "PASS",
        meanRerankScore: 0.72,
        sourceCoverage: 0.9,
        translationCoverage: 0.9,
        lowScoreFraction: 0.1,
        sourceGapFraction: 0.1,
        translationGapFraction: 0.1,
      }),
      makeCuratedCase({
        caseId: "fail-a",
        row: 3,
        truth: "FAIL",
        meanRerankScore: 0.3,
        sourceCoverage: 0.4,
        translationCoverage: 0.4,
        sourceGapFraction: 0.6,
        translationGapFraction: 0.6,
      }),
      makeCuratedCase({
        caseId: "fail-b",
        row: 4,
        truth: "FAIL",
        meanRerankScore: 0.35,
        sourceCoverage: 0.45,
        translationCoverage: 0.45,
        sourceGapFraction: 0.55,
        translationGapFraction: 0.55,
      }),
    ];

    const result = revalidateNqaCandidatePolicy({
      promotionGate,
      materializedPolicy,
      curationExport: makeSignedCurationExport({
        runId: "m16-regression-shadow",
        cases,
      }),
    });

    expect(result.gateDecision).toBe("HOLD");
    expect(result.gateFailureReasons).toContain(
      "CANDIDATE_REVIEW_RATE_EXCEEDED"
    );
    expect(result.gateFailureReasons).toContain(
      "CANDIDATE_EXACT_MATCH_RATE_BELOW_MINIMUM"
    );
  });

  it("rejects a tampered M14 curation export before shadow replay", () => {
    const { promotionGate } = buildPromotedFixture();
    const materializedPolicy = materializeNqaCandidatePolicy({
      promotionGate,
      basePolicy: BASE_POLICY,
    });
    const shadowExport = makeSignedCurationExport({
      runId: "m16-tampered-shadow",
    });

    expect(() =>
      revalidateNqaCandidatePolicy({
        promotionGate,
        materializedPolicy,
        curationExport: {
          ...shadowExport,
          datasetFingerprint: "0".repeat(64),
        },
      })
    ).toThrow("M14 curation export fingerprint mismatch.");
  });

  it("rejects materialized-policy threshold drift from the M15 candidate", () => {
    const { promotionGate } = buildPromotedFixture();
    const materializedPolicy = materializeNqaCandidatePolicy({
      promotionGate,
      basePolicy: BASE_POLICY,
    });

    expect(() =>
      revalidateNqaCandidatePolicy({
        promotionGate,
        materializedPolicy: {
          ...materializedPolicy,
          policy: {
            ...materializedPolicy.policy,
            minPassMeanScore: 0.8,
          },
        },
        curationExport: makeSignedCurationExport({
          runId: "m16-policy-drift",
        }),
      })
    ).toThrow("M16 materialized candidate policy fingerprint mismatch.");
  });
});
