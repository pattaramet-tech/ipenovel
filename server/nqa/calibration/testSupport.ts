import type { NqaDecision, GoldLabelStatus } from "../contracts";
import type { NqaCurationExport, NqaCuratedCase } from "../review/contracts";
import type { NqaAlignmentThresholdProfile } from "./contracts";

export const TEST_POLICY_VERSION = "nqa-alignment-v1";
export const TEST_RERANKER_VERSION = "local@test-reranker-v1";

export const BASELINE_PROFILE: NqaAlignmentThresholdProfile = {
  profileId: "baseline",
  sourcePolicyVersion: TEST_POLICY_VERSION,
  rerankerVersion: TEST_RERANKER_VERSION,
  thresholds: {
    minPassMeanScore: 0.7,
    minPassTranslationCoverage: 0.85,
    minPassSourceCoverage: 0.8,
    minReviewMeanScore: 0.45,
    minReviewTranslationCoverage: 0.6,
    minReviewSourceCoverage: 0.55,
    majorGapFraction: 0.3,
    maxLowScoreFractionPass: 0.3,
  },
};

export function makeCuratedCase(input: {
  caseId: string;
  row: number;
  truth?: NqaDecision | null;
  truthStatus?: GoldLabelStatus;
  reviewStatus?: NqaCuratedCase["reviewStatus"];
  machineDecision?: NqaDecision;
  alignmentDecision?: NqaDecision | null;
  policyVersion?: string | null;
  rerankerVersion?: string | null;
  meanRerankScore?: number | null;
  sourceCoverage?: number | null;
  translationCoverage?: number | null;
  lowScoreFraction?: number | null;
  sourceGapFraction?: number | null;
  translationGapFraction?: number | null;
}): NqaCuratedCase {
  const truth = input.truth === undefined ? "PASS" : input.truth;
  const finalGroundTruth =
    truth === null
      ? null
      : {
          decision: truth,
          reasonCodes: [],
          status: input.truthStatus ?? "HUMAN_CONFIRMED",
          labeledBy: "reviewer-test",
          labeledAt: "2026-09-24T20:00:00+07:00",
          notes: [],
        };

  const meanRerankScore =
    input.meanRerankScore === undefined ? 0.8 : input.meanRerankScore;
  const sourceCoverage =
    input.sourceCoverage === undefined ? 0.9 : input.sourceCoverage;
  const translationCoverage =
    input.translationCoverage === undefined ? 0.9 : input.translationCoverage;
  const lowScoreFraction =
    input.lowScoreFraction === undefined ? 0.1 : input.lowScoreFraction;
  const sourceGapFraction =
    input.sourceGapFraction === undefined ? 0.1 : input.sourceGapFraction;
  const translationGapFraction =
    input.translationGapFraction === undefined
      ? 0.1
      : input.translationGapFraction;

  let historicalAlignmentDecision: NqaDecision = "REVIEW";
  if (
    meanRerankScore !== null &&
    sourceCoverage !== null &&
    translationCoverage !== null &&
    lowScoreFraction !== null &&
    sourceGapFraction !== null &&
    translationGapFraction !== null
  ) {
    if (
      meanRerankScore >= BASELINE_PROFILE.thresholds.minPassMeanScore &&
      translationCoverage >=
        BASELINE_PROFILE.thresholds.minPassTranslationCoverage &&
      sourceCoverage >= BASELINE_PROFILE.thresholds.minPassSourceCoverage &&
      lowScoreFraction <= BASELINE_PROFILE.thresholds.maxLowScoreFractionPass
    ) {
      historicalAlignmentDecision = "PASS";
    } else if (
      sourceGapFraction >= BASELINE_PROFILE.thresholds.majorGapFraction ||
      translationGapFraction >= BASELINE_PROFILE.thresholds.majorGapFraction ||
      meanRerankScore < BASELINE_PROFILE.thresholds.minReviewMeanScore ||
      translationCoverage <
        BASELINE_PROFILE.thresholds.minReviewTranslationCoverage ||
      sourceCoverage < BASELINE_PROFILE.thresholds.minReviewSourceCoverage
    ) {
      historicalAlignmentDecision = "FAIL";
    }
  }

  return {
    caseId: input.caseId,
    row: input.row,
    chapter: 100 + input.row,
    inputFingerprint: "c".repeat(64),
    subjectFingerprint: "d".repeat(64),
    baselineGroundTruth: null,
    machineSnapshot: {
      decision: input.machineDecision ?? "REVIEW",
      reasonCodes: [],
      stageDecisions: {
        deterministic: "PASS",
        globalSearch: "PASS",
        alignment:
          input.alignmentDecision === undefined
            ? historicalAlignmentDecision
            : input.alignmentDecision,
        adjudication: null,
        structure: null,
      },
      scores: {
        expectedRank: 1,
        expectedSimilarity: 0.8,
        expectedLeadOverAlternate: 0.08,
        sourceCoverage,
        translationCoverage,
        meanRerankScore,
        minRerankScore: 0.6,
        lowScoreFraction,
        sourceGapFraction,
        translationGapFraction,
        structuredStrongMismatchCount: null,
        structuredStrongMatchCount: null,
      },
      sourceHash: "a".repeat(64),
      translationHash: "b".repeat(64),
      providerVersions: {
        embedding: "local@test-embedding",
        reranker:
          input.rerankerVersion === undefined
            ? TEST_RERANKER_VERSION
            : input.rerankerVersion,
        adjudication: null,
        structure: null,
      },
      policyVersions: {
        deterministic: "nqa-deterministic-v1",
        semantic: "nqa-semantic-global-v1",
        alignment:
          input.policyVersion === undefined
            ? TEST_POLICY_VERSION
            : input.policyVersion,
        adjudication: null,
        structure: null,
      },
      evidence: [],
    },
    reviewStatus:
      input.reviewStatus ?? (truth === null ? "PENDING" : "CONFIRMED"),
    candidateLabel: null,
    finalGroundTruth,
    actionTrail: [],
  };
}

export function makeCurationExport(cases: NqaCuratedCase[]): NqaCurationExport {
  const finalLabelCount = cases.filter(
    item => item.finalGroundTruth !== null
  ).length;
  return {
    exportVersion: "nqa-curation-export-v1",
    runId: "run-calibration",
    batchFingerprint: "e".repeat(64),
    caseCount: cases.length,
    finalLabelCount,
    unresolvedCount: cases.length - finalLabelCount,
    cases,
    datasetFingerprint: "f".repeat(64),
  };
}
