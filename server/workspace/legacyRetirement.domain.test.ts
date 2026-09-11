import { describe, expect, it } from "vitest";
import { buildLegacyRetirementCandidatePackage } from "./legacyRetirement.domain";

const passingEvidence = {
  sustainedParity: { passed: true, evidenceRef: "parity-window-2026w36" },
  slo: { passed: true, evidenceRef: "workspace-publish-slo-2026w36" },
  rollbackDrill: { passed: true, evidenceRef: "preview-m05d-cutover-rollback" },
  legacyActionFreeze: { passed: true, evidenceRef: "legacy-write-freeze-audit-1" },
};

function build(overrides: Partial<Parameters<typeof buildLegacyRetirementCandidatePackage>[0]> = {}) {
  return buildLegacyRetirementCandidatePackage({
    workspaceId: 1,
    workspaceNovelId: 2,
    ownership: { owner: "workspace", cutoverEpoch: 1, version: 2 },
    latestTransition: { id: 7, direction: "cutover", toOwner: "workspace", toEpoch: 1, toVersion: 2 },
    publishRunId: 9,
    items: [{ itemKey: "chapter-1", status: "published", providerReceipt: "receipt-1" }],
    outbox: [],
    evidence: passingEvidence,
    ...overrides,
  });
}

describe("workspace M06 legacy retirement candidate domain", () => {
  it("builds a deterministic candidate-only package while retaining legacy and ZIP fallbacks", () => {
    const first = build();
    const second = build();

    expect(first.retirementCandidateReady).toBe(true);
    expect(first.blockers).toEqual([]);
    expect(first.packageDigest).toBe(second.packageDigest);
    expect(first.separateHumanApprovalRequired).toBe(true);
    expect(first.retirementApplied).toBe(false);
    expect(first.automaticRetirement).toBe(false);
    expect(first.safety).toEqual({
      legacyPathsRetained: true,
      zipFallbackRetained: true,
      readExportFallbackRetained: true,
      noLegacyMutationApplied: true,
      noZipMutationApplied: true,
    });
    expect(first.nextDecision).toEqual({ type: "separate_human_approval", executable: false });
  });

  it("fails closed on ownership/history, publish completion, backlog, and required evidence gaps", () => {
    const blocked = build({
      ownership: { owner: "sheets", cutoverEpoch: 2, version: 3 },
      latestTransition: { id: 8, direction: "rollback", toOwner: "sheets", toEpoch: 2, toVersion: 3 },
      items: [
        { itemKey: "chapter-1", status: "pending", providerReceipt: null },
        { itemKey: "chapter-2", status: "published", providerReceipt: null },
      ],
      outbox: [{ id: 4, status: "pending" }],
      evidence: {
        sustainedParity: { passed: false, evidenceRef: "parity-gap" },
        slo: { passed: false, evidenceRef: "slo-gap" },
        rollbackDrill: { passed: false, evidenceRef: "rollback-gap" },
        legacyActionFreeze: { passed: false, evidenceRef: "freeze-gap" },
      },
    });

    expect(blocked.retirementCandidateReady).toBe(false);
    expect(blocked.blockers).toEqual([
      "LEGACY_ACTION_FREEZE_EVIDENCE_MISSING",
      "OUTBOX_BACKLOG_PRESENT",
      "OWNERSHIP_HISTORY_MISMATCH",
      "PUBLISHED_ITEM_MISSING_RECEIPT",
      "PUBLISH_NOT_WORKSPACE_PRIMARY",
      "ROLLBACK_DRILL_EVIDENCE_MISSING",
      "SLO_EVIDENCE_MISSING",
      "SUSTAINED_PARITY_EVIDENCE_MISSING",
      "UNRESOLVED_PUBLISH_ITEMS",
    ]);
  });

  it("requires non-empty publish and operator evidence references", () => {
    const noRun = build({ publishRunId: null, items: [] });
    expect(noRun.blockers).toContain("NO_PUBLISH_RUN_EVIDENCE");

    const emptyRun = build({ publishRunId: 9, items: [] });
    expect(emptyRun.blockers).toContain("EMPTY_PUBLISH_RUN_EVIDENCE");

    const emptyEvidenceRef = build({
      evidence: {
        ...passingEvidence,
        sustainedParity: { passed: true, evidenceRef: "   " },
      },
    });
    expect(emptyEvidenceRef.blockers).toContain("SUSTAINED_PARITY_EVIDENCE_MISSING");
  });
});
