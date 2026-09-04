import { describe, expect, it } from "vitest";
import {
  classifySlipEvidence,
  evaluateV2ApprovalReadiness,
  isPreparedEvidenceSnapshotCurrent,
  type ApprovalEvidenceSnapshot,
  type ImmutableEvidenceProof,
} from "./slipEvidenceReadinessService";

const HASH = "a".repeat(64);
const NOW = new Date("2026-09-05T00:00:00.000Z");

function subject(overrides: Partial<ApprovalEvidenceSnapshot> = {}): ApprovalEvidenceSnapshot {
  return {
    sourceType: "order_payment",
    sourceId: 41,
    ownerUserId: 7,
    status: "pending_review",
    slipImageUrl: "r2p:payment-slips/7/a/object.png",
    slipSubmittedAt: NOW,
    evidenceVersion: 2,
    slipEvidenceClass: "modern_immutable",
    slipEvidenceId: 91,
    extractedEvidenceVersion: 2,
    extractedData: JSON.stringify({ fileHash: HASH }),
    ...overrides,
  };
}

function proof(overrides: Partial<ImmutableEvidenceProof> = {}): ImmutableEvidenceProof {
  return {
    id: 91,
    sourceType: "order_payment",
    sourceId: 41,
    ownerUserId: 7,
    evidenceVersion: 2,
    evidenceClass: "modern_immutable",
    objectIdentity: "r2p:payment-slips/7/a/object.png",
    fileHash: HASH,
    ...overrides,
  };
}

describe("immutable/versioned slip evidence eligibility", () => {
  it("classifies a fully bound modern upload as modern_immutable", () => {
    expect(classifySlipEvidence(subject(), proof())).toEqual({
      classification: "modern_immutable",
      eligible: true,
      reason: "READY",
      evidenceVersion: 2,
    });
  });

  it("classifies a verified migrated object separately", () => {
    const migratedSubject = subject({ slipEvidenceClass: "legacy_migrated_immutable" });
    const migratedProof = proof({ evidenceClass: "legacy_migrated_immutable" });
    expect(classifySlipEvidence(migratedSubject, migratedProof)).toMatchObject({
      classification: "legacy_migrated_immutable",
      eligible: true,
    });
  });

  it("never promotes an unbound legacy row", () => {
    expect(classifySlipEvidence(subject({
      evidenceVersion: 0,
      slipEvidenceClass: "legacy_compatibility_required",
      slipEvidenceId: null,
      extractedEvidenceVersion: null,
    }), null)).toMatchObject({
      classification: "legacy_compatibility_required",
      eligible: false,
      reason: "LEGACY_EVIDENCE_REQUIRES_COMPATIBILITY",
    });
  });

  it.each([
    ["owner", subject({ ownerUserId: 8 }), proof()],
    ["source", subject({ sourceId: 42 }), proof()],
    ["object identity", subject({ slipImageUrl: "r2p:payment-slips/7/b.png" }), proof()],
    ["file hash", subject({ extractedData: JSON.stringify({ fileHash: "b".repeat(64) }) }), proof()],
    ["extraction version", subject({ extractedEvidenceVersion: 1 }), proof()],
    ["missing binding", subject(), null],
    ["unknown class", subject({ slipEvidenceClass: "future_unreviewed_class" }), proof()],
  ])("fails closed for inconsistent %s binding", (_label, snapshot, binding) => {
    expect(classifySlipEvidence(snapshot, binding)).toMatchObject({
      eligible: false,
      reason: "EVIDENCE_STATE_INCONSISTENT",
    });
  });

  it("requires both trusted anti-replay readiness and immutable evidence", async () => {
    await expect(evaluateV2ApprovalReadiness(subject(), proof(), true)).resolves.toMatchObject({
      ready: false,
      trustedAntiReplayReady: false,
      reason: "TRUSTED_ANTI_REPLAY_NOT_READY",
    });
    await expect(evaluateV2ApprovalReadiness(subject(), proof(), false)).resolves.toMatchObject({
      ready: true,
      trustedAntiReplayReady: true,
      reason: "READY",
    });
  });

  it("still refuses legacy evidence after anti-replay becomes ready", async () => {
    const legacy = subject({
      evidenceVersion: 4,
      slipEvidenceClass: "legacy_compatibility_required",
      slipEvidenceId: null,
      extractedEvidenceVersion: null,
    });
    await expect(evaluateV2ApprovalReadiness(legacy, null, false)).resolves.toMatchObject({
      ready: false,
      reason: "LEGACY_EVIDENCE_REQUIRES_COMPATIBILITY",
    });
  });

  it("rejects a prepared snapshot after every genuine replacement increments the version", () => {
    const prepared = subject({ evidenceVersion: 2 });
    const current = subject({
      evidenceVersion: 3,
      slipEvidenceId: 92,
      slipImageUrl: "r2p:payment-slips/7/replacement.png",
    });
    expect(isPreparedEvidenceSnapshotCurrent(prepared, current)).toBe(false);
    expect(isPreparedEvidenceSnapshotCurrent(current, current)).toBe(true);
  });
});
