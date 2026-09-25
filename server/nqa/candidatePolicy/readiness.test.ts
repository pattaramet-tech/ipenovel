import { describe, expect, it } from "vitest";

import { hashCanonicalJson } from "../core";
import { materializeNqaCandidatePolicy } from "./materialize";
import { buildNqaActivationReadiness } from "./readiness";
import { revalidateNqaCandidatePolicy } from "./revalidate";
import {
  BASE_POLICY,
  buildPromotedFixture,
  makeCuratedCase,
  makeSignedCurationExport,
} from "./testSupport";

describe("NQA M16 activation-readiness gate", () => {
  it("freezes the fixed readiness criteria", async () => {
    const { DEFAULT_NQA_ACTIVATION_READINESS_CRITERIA } =
      await import("./readiness");
    expect(Object.isFrozen(DEFAULT_NQA_ACTIVATION_READINESS_CRITERIA)).toBe(
      true
    );
  });

  it("marks a fresh passing shadow as ready only for explicit activation review", () => {
    const { promotionGate } = buildPromotedFixture();
    const materializedPolicy = materializeNqaCandidatePolicy({
      promotionGate,
      basePolicy: BASE_POLICY,
    });
    const shadowRevalidation = revalidateNqaCandidatePolicy({
      promotionGate,
      materializedPolicy,
      curationExport: makeSignedCurationExport({
        runId: "m16-fresh-ready",
      }),
    });

    const readiness = buildNqaActivationReadiness({
      promotionGate,
      materializedPolicy,
      shadowRevalidation,
    });

    expect(readiness.decision).toBe("READY_FOR_EXPLICIT_ACTIVATION_REVIEW");
    expect(readiness.failureReasons).toEqual([]);
    expect(materializedPolicy.state).toBe("INACTIVE");
  });

  it("HOLDs when shadow revalidation reuses the original M15 dataset", () => {
    const { promotionGate, promotionExport } = buildPromotedFixture();
    const materializedPolicy = materializeNqaCandidatePolicy({
      promotionGate,
      basePolicy: BASE_POLICY,
    });
    const shadowRevalidation = revalidateNqaCandidatePolicy({
      promotionGate,
      materializedPolicy,
      curationExport: promotionExport,
    });

    const readiness = buildNqaActivationReadiness({
      promotionGate,
      materializedPolicy,
      shadowRevalidation,
    });

    expect(readiness.decision).toBe("HOLD");
    expect(readiness.failureReasons).toContain("SHADOW_DATASET_NOT_DISTINCT");
  });

  it("HOLDs when a distinct shadow gate fails the unchanged M15 criteria", () => {
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
    const shadowRevalidation = revalidateNqaCandidatePolicy({
      promotionGate,
      materializedPolicy,
      curationExport: makeSignedCurationExport({
        runId: "m16-hold-shadow",
        cases,
      }),
    });

    const readiness = buildNqaActivationReadiness({
      promotionGate,
      materializedPolicy,
      shadowRevalidation,
    });

    expect(readiness.decision).toBe("HOLD");
    expect(readiness.failureReasons).toContain("SHADOW_GATE_NOT_PROMOTE");
    expect(readiness.shadowGateFailureReasons.length).toBeGreaterThan(0);
  });

  it("detects artifact linkage mismatch even when the shadow artifact hash is internally valid", () => {
    const { promotionGate } = buildPromotedFixture();
    const materializedPolicy = materializeNqaCandidatePolicy({
      promotionGate,
      basePolicy: BASE_POLICY,
    });
    const shadowRevalidation = revalidateNqaCandidatePolicy({
      promotionGate,
      materializedPolicy,
      curationExport: makeSignedCurationExport({
        runId: "m16-linkage-shadow",
      }),
    });
    const { artifactFingerprint: _ignored, ...shadowPayload } =
      shadowRevalidation;
    const relinkedPayload = {
      ...shadowPayload,
      materializedPolicyArtifactFingerprint: "0".repeat(64),
    };
    const relinkedShadow = {
      ...relinkedPayload,
      artifactFingerprint: hashCanonicalJson({
        scope: "nqa:candidate-shadow-revalidation:v1",
        ...relinkedPayload,
      }),
    };

    const readiness = buildNqaActivationReadiness({
      promotionGate,
      materializedPolicy,
      shadowRevalidation: relinkedShadow,
    });

    expect(readiness.decision).toBe("HOLD");
    expect(readiness.failureReasons).toContain("ARTIFACT_LINKAGE_MISMATCH");
  });
});
