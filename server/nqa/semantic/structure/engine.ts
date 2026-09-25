import type { NqaReasonCode, QaEvidenceRef } from "../../contracts";
import type {
  NqaStructureDimension,
  NqaStructurePairAssessment,
  NqaStructurePolicy,
  NqaStructureResult,
  NqaStructureVerificationProvider,
  NqaStructureEvidenceItem,
} from "./contracts";
import { mergeNqaStructurePolicy } from "./policy";

const DIMENSION_REASON: Record<NqaStructureDimension, NqaReasonCode> = {
  EVENT: "EVENT_MISMATCH",
  ENTITY: "ENTITY_MISMATCH",
  RELATIONSHIP: "RELATIONSHIP_MISMATCH",
  CAUSALITY: "CAUSALITY_MISMATCH",
  CHRONOLOGY: "CHRONOLOGY_MISMATCH",
};

function addReason(reasons: NqaReasonCode[], reason: NqaReasonCode): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function boundedEvidence(input: {
  result: Omit<NqaStructureResult, "evidence">;
}): QaEvidenceRef[] {
  const metrics = input.result.metrics;
  const refs: QaEvidenceRef[] = [
    {
      evidenceId: "structured-verification-summary",
      kind: "POLICY",
      boundedSummary: [
        "Structured verification.",
        "decision=" + input.result.decision,
        "items=" + metrics.itemCount,
        "assessed=" + metrics.assessedItemCount,
        "strongMismatch=" + metrics.strongMismatchCount,
        "strongMatch=" + metrics.strongMatchCount,
        "provider=" + input.result.providerId,
        "model=" + input.result.modelVersion,
      ]
        .join(" ")
        .slice(0, 1000),
    },
  ];

  for (const assessment of input.result.assessments.slice(0, 6)) {
    const mismatches = assessment.dimensions
      .filter(dimension => dimension.status === "MISMATCH")
      .map(
        dimension => dimension.dimension + ":" + dimension.confidence.toFixed(3)
      );

    refs.push({
      evidenceId: "structured-assessment-" + assessment.evidenceId,
      kind: "POLICY",
      boundedSummary: [
        "Structured item",
        assessment.evidenceId,
        "mismatches=" + (mismatches.length > 0 ? mismatches.join(",") : "none"),
      ]
        .join(" ")
        .slice(0, 1000),
    });
  }

  return refs;
}

function emptyResult(input: {
  policy: NqaStructurePolicy;
  provider: NqaStructureVerificationProvider;
  itemCount: number;
}): NqaStructureResult {
  const withoutEvidence = {
    decision: "REVIEW" as const,
    reasonCodes: ["INSUFFICIENT_EVIDENCE" as const],
    metrics: {
      itemCount: input.itemCount,
      assessedItemCount: 0,
      strongMismatchCount: 0,
      strongMismatchItemCount: 0,
      strongMatchCount: 0,
      mismatchByDimension: {},
      matchByDimension: {},
    },
    assessments: [],
    providerId: input.provider.providerId,
    modelVersion: input.provider.modelVersion,
    policyVersion: input.policy.version,
  };

  return {
    ...withoutEvidence,
    evidence: boundedEvidence({ result: withoutEvidence }),
  };
}

export async function runStructuredVerification(input: {
  items: NqaStructureEvidenceItem[];
  provider: NqaStructureVerificationProvider;
  policy?: Partial<NqaStructurePolicy>;
}): Promise<NqaStructureResult> {
  const policy = mergeNqaStructurePolicy(input.policy);
  const items = input.items.slice(0, Math.max(0, policy.maxItems));

  if (items.length === 0) {
    return emptyResult({
      policy,
      provider: input.provider,
      itemCount: 0,
    });
  }

  let assessments: NqaStructurePairAssessment[];
  try {
    assessments = await input.provider.verify(items);
  } catch {
    return emptyResult({
      policy,
      provider: input.provider,
      itemCount: items.length,
    });
  }

  const mismatchByDimension: Partial<Record<NqaStructureDimension, number>> =
    {};
  const matchByDimension: Partial<Record<NqaStructureDimension, number>> = {};
  const strongMismatchDimensions: NqaStructureDimension[] = [];
  let strongMismatchCount = 0;
  let strongMismatchItemCount = 0;
  let strongMatchCount = 0;
  let assessedItemCount = 0;

  for (const assessment of assessments) {
    const hasAssessedDimension = assessment.dimensions.some(
      dimension => dimension.status !== "INSUFFICIENT"
    );
    if (hasAssessedDimension) assessedItemCount += 1;

    let itemHasStrongMismatch = false;
    for (const dimension of assessment.dimensions) {
      if (
        dimension.status === "MISMATCH" &&
        dimension.confidence >= policy.minMismatchConfidence
      ) {
        strongMismatchCount += 1;
        itemHasStrongMismatch = true;
        mismatchByDimension[dimension.dimension] =
          (mismatchByDimension[dimension.dimension] ?? 0) + 1;
        if (!strongMismatchDimensions.includes(dimension.dimension)) {
          strongMismatchDimensions.push(dimension.dimension);
        }
      }

      if (
        dimension.status === "MATCH" &&
        dimension.confidence >= policy.minMatchConfidence
      ) {
        strongMatchCount += 1;
        matchByDimension[dimension.dimension] =
          (matchByDimension[dimension.dimension] ?? 0) + 1;
      }
    }

    if (itemHasStrongMismatch) {
      strongMismatchItemCount += 1;
    }
  }

  const reasonCodes: NqaReasonCode[] = [];
  for (const dimension of strongMismatchDimensions) {
    addReason(reasonCodes, DIMENSION_REASON[dimension]);
  }

  const eventMismatch = (mismatchByDimension.EVENT ?? 0) > 0;
  const supportingMismatch = strongMismatchDimensions.some(
    dimension => dimension !== "EVENT"
  );

  let decision: "PASS" | "REVIEW" | "FAIL";

  if (
    strongMismatchItemCount >= policy.minFailItems &&
    (strongMismatchCount >= policy.failStrongMismatchCount ||
      (policy.failEventPlusSupportingMismatch &&
        eventMismatch &&
        supportingMismatch))
  ) {
    decision = "FAIL";
  } else if (strongMismatchCount > 0) {
    decision = "REVIEW";
  } else if (
    assessedItemCount >= policy.minAssessedItems &&
    strongMatchCount >= policy.minStrongMatchDimensions
  ) {
    decision = "PASS";
  } else {
    decision = "REVIEW";
    addReason(reasonCodes, "INSUFFICIENT_EVIDENCE");
  }

  const withoutEvidence = {
    decision,
    reasonCodes,
    metrics: {
      itemCount: items.length,
      assessedItemCount,
      strongMismatchCount,
      strongMismatchItemCount,
      strongMatchCount,
      mismatchByDimension,
      matchByDimension,
    },
    assessments,
    providerId: input.provider.providerId,
    modelVersion: input.provider.modelVersion,
    policyVersion: policy.version,
  };

  return {
    ...withoutEvidence,
    evidence: boundedEvidence({ result: withoutEvidence }),
  };
}
