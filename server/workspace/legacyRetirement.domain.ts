import { createHash } from "node:crypto";

export const WORKSPACE_LEGACY_RETIREMENT_CANDIDATE_CONTRACT = "workspace-legacy-retirement-candidate-v1" as const;

export type LegacyRetirementBlocker =
  | "PUBLISH_NOT_WORKSPACE_PRIMARY"
  | "OWNERSHIP_HISTORY_MISMATCH"
  | "NO_PUBLISH_RUN_EVIDENCE"
  | "EMPTY_PUBLISH_RUN_EVIDENCE"
  | "UNRESOLVED_PUBLISH_ITEMS"
  | "PUBLISHED_ITEM_MISSING_RECEIPT"
  | "OUTBOX_BACKLOG_PRESENT"
  | "SUSTAINED_PARITY_EVIDENCE_MISSING"
  | "SLO_EVIDENCE_MISSING"
  | "ROLLBACK_DRILL_EVIDENCE_MISSING"
  | "LEGACY_ACTION_FREEZE_EVIDENCE_MISSING";

export type LegacyRetirementEvidence = {
  sustainedParity: { passed: boolean; evidenceRef: string };
  slo: { passed: boolean; evidenceRef: string };
  rollbackDrill: { passed: boolean; evidenceRef: string };
  legacyActionFreeze: { passed: boolean; evidenceRef: string };
};

export function buildLegacyRetirementCandidatePackage(input: {
  workspaceId: number;
  workspaceNovelId: number;
  ownership: { owner: "sheets" | "workspace" | "paused"; cutoverEpoch: number; version: number } | null;
  latestTransition: {
    id: number;
    direction: "cutover" | "rollback";
    toOwner: "sheets" | "workspace";
    toEpoch: number;
    toVersion: number;
  } | null;
  publishRunId: number | null;
  items: Array<{ itemKey: string; status: "pending" | "publishing" | "published" | "failed" | "skipped"; providerReceipt?: string | null }>;
  outbox: Array<{ id: number; status: "pending" | "claimed" | "delivered" | "failed" | "dead_letter" }>;
  evidence: LegacyRetirementEvidence;
}) {
  const blockers: LegacyRetirementBlocker[] = [];
  const ownership = input.ownership;
  const latestTransition = input.latestTransition;

  if (!ownership || ownership.owner !== "workspace" || ownership.cutoverEpoch < 1) {
    blockers.push("PUBLISH_NOT_WORKSPACE_PRIMARY");
  }
  if (
    !ownership ||
    !latestTransition ||
    latestTransition.direction !== "cutover" ||
    latestTransition.toOwner !== "workspace" ||
    latestTransition.toEpoch !== ownership.cutoverEpoch ||
    latestTransition.toVersion !== ownership.version
  ) {
    blockers.push("OWNERSHIP_HISTORY_MISMATCH");
  }
  if (!input.publishRunId) blockers.push("NO_PUBLISH_RUN_EVIDENCE");
  if (input.publishRunId && input.items.length === 0) blockers.push("EMPTY_PUBLISH_RUN_EVIDENCE");
  if (input.items.some(item => item.status !== "published" && item.status !== "skipped")) {
    blockers.push("UNRESOLVED_PUBLISH_ITEMS");
  }
  if (input.items.some(item => item.status === "published" && !item.providerReceipt?.trim())) {
    blockers.push("PUBLISHED_ITEM_MISSING_RECEIPT");
  }
  if (input.outbox.some(row => row.status !== "delivered")) blockers.push("OUTBOX_BACKLOG_PRESENT");
  if (!input.evidence.sustainedParity.passed || !input.evidence.sustainedParity.evidenceRef.trim()) blockers.push("SUSTAINED_PARITY_EVIDENCE_MISSING");
  if (!input.evidence.slo.passed || !input.evidence.slo.evidenceRef.trim()) blockers.push("SLO_EVIDENCE_MISSING");
  if (!input.evidence.rollbackDrill.passed || !input.evidence.rollbackDrill.evidenceRef.trim()) blockers.push("ROLLBACK_DRILL_EVIDENCE_MISSING");
  if (!input.evidence.legacyActionFreeze.passed || !input.evidence.legacyActionFreeze.evidenceRef.trim()) blockers.push("LEGACY_ACTION_FREEZE_EVIDENCE_MISSING");

  const normalized = {
    contract: WORKSPACE_LEGACY_RETIREMENT_CANDIDATE_CONTRACT,
    workspaceId: input.workspaceId,
    workspaceNovelId: input.workspaceNovelId,
    ownership,
    latestTransition,
    publishRunId: input.publishRunId,
    itemSummary: {
      total: input.items.length,
      unresolved: input.items.filter(item => item.status !== "published" && item.status !== "skipped").length,
      publishedMissingReceipt: input.items.filter(item => item.status === "published" && !item.providerReceipt?.trim()).length,
    },
    outboxSummary: {
      total: input.outbox.length,
      backlog: input.outbox.filter(row => row.status !== "delivered").length,
    },
    evidence: {
      sustainedParity: { passed: input.evidence.sustainedParity.passed, evidenceRef: input.evidence.sustainedParity.evidenceRef.trim() },
      slo: { passed: input.evidence.slo.passed, evidenceRef: input.evidence.slo.evidenceRef.trim() },
      rollbackDrill: { passed: input.evidence.rollbackDrill.passed, evidenceRef: input.evidence.rollbackDrill.evidenceRef.trim() },
      legacyActionFreeze: { passed: input.evidence.legacyActionFreeze.passed, evidenceRef: input.evidence.legacyActionFreeze.evidenceRef.trim() },
    },
    blockers: [...blockers].sort(),
  };
  const packageDigest = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");

  return {
    ...normalized,
    packageDigest,
    retirementCandidateReady: blockers.length === 0,
    separateHumanApprovalRequired: true as const,
    retirementApplied: false as const,
    automaticRetirement: false as const,
    safety: {
      legacyPathsRetained: true as const,
      zipFallbackRetained: true as const,
      readExportFallbackRetained: true as const,
      noLegacyMutationApplied: true as const,
      noZipMutationApplied: true as const,
    },
    nextDecision: {
      type: "separate_human_approval" as const,
      executable: false as const,
    },
  };
}
