import type { QaEvidenceRef } from "../contracts";
import type { NqaSemanticQaStageResult } from "../semantic/contracts";
import {
  NqaShadowMachineResultSchema,
  type NqaShadowEvidenceSummary,
  type NqaShadowMachineResult,
} from "./contracts";

type ShadowStage = NqaShadowEvidenceSummary["stage"];

function evidenceFrom(
  stage: ShadowStage,
  values: readonly QaEvidenceRef[]
): NqaShadowEvidenceSummary[] {
  return values.map(value => ({
    stage,
    evidenceId: value.evidenceId.slice(0, 200),
    sourceHash: value.sourceHash ?? null,
    translationHash: value.translationHash ?? null,
    boundedSummary: value.boundedSummary.slice(0, 1000),
  }));
}

function firstHash(
  evidence: readonly NqaShadowEvidenceSummary[],
  key: "sourceHash" | "translationHash"
): string | null {
  for (const item of evidence) {
    if (item[key]) return item[key];
  }
  return null;
}

function providerVersion(
  providerId: string | null | undefined,
  modelVersion: string | null | undefined
): string | null {
  if (!providerId && !modelVersion) return null;
  return [providerId, modelVersion].filter(Boolean).join("@");
}

export function buildNqaShadowMachineResult(
  result: NqaSemanticQaStageResult
): NqaShadowMachineResult {
  const evidence = [
    ...evidenceFrom("M08_DETERMINISTIC", result.deterministic.evidence),
    ...evidenceFrom("M09_GLOBAL_SEARCH", result.globalSearch?.evidence ?? []),
    ...evidenceFrom("M10_ALIGNMENT", result.alignment?.evidence ?? []),
    ...evidenceFrom("M11_ADJUDICATION", result.adjudication?.evidence ?? []),
    ...evidenceFrom("M12_STRUCTURE", result.structure?.evidence ?? []),
  ].slice(0, 40);

  const machine: NqaShadowMachineResult = {
    decision: result.decision,
    reasonCodes: Array.from(new Set(result.reasonCodes)).slice(0, 80),
    stageDecisions: {
      deterministic: result.deterministic.decision,
      globalSearch: result.globalSearch?.decision ?? null,
      alignment: result.alignment?.decision ?? null,
      adjudication: result.adjudication?.decision ?? null,
      structure: result.structure?.decision ?? null,
    },
    scores: {
      expectedRank: result.globalSearch?.expectedRank ?? null,
      expectedSimilarity: result.globalSearch?.expectedSimilarity ?? null,
      expectedLeadOverAlternate:
        result.globalSearch?.expectedLeadOverAlternate ?? null,
      sourceCoverage: result.alignment?.metrics.sourceCoverage ?? null,
      translationCoverage:
        result.alignment?.metrics.translationCoverage ?? null,
      meanRerankScore: result.alignment?.metrics.meanRerankScore ?? null,
      minRerankScore: result.alignment?.metrics.minRerankScore ?? null,
      lowScoreFraction: result.alignment?.metrics.lowScoreFraction ?? null,
      sourceGapFraction: result.alignment?.metrics.sourceGapFraction ?? null,
      translationGapFraction:
        result.alignment?.metrics.translationGapFraction ?? null,
      structuredStrongMismatchCount:
        result.structure?.metrics.strongMismatchCount ?? null,
      structuredStrongMatchCount:
        result.structure?.metrics.strongMatchCount ?? null,
    },
    sourceHash: firstHash(evidence, "sourceHash"),
    translationHash: firstHash(evidence, "translationHash"),
    providerVersions: {
      embedding: providerVersion(
        result.globalSearch?.providerId,
        result.globalSearch?.modelVersion
      ),
      reranker: providerVersion(
        result.alignment?.providerId,
        result.alignment?.modelVersion
      ),
      adjudication:
        result.adjudication?.localLlm?.modelVersion ??
        result.adjudication?.jev?.modelVersion ??
        null,
      structure: providerVersion(
        result.structure?.providerId,
        result.structure?.modelVersion
      ),
    },
    policyVersions: {
      deterministic: result.deterministic.policyVersion,
      semantic: result.policyVersion,
      alignment: result.alignment?.policyVersion ?? null,
      adjudication: result.adjudication?.policyVersion ?? null,
      structure: result.structure?.policyVersion ?? null,
    },
    evidence,
  };

  return NqaShadowMachineResultSchema.parse(machine);
}
