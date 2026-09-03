import { describe, expect, it } from "vitest";
import { evaluateV2SubjectEvidenceEligibility } from "./paymentApprovalV2ReadinessService";

const HASH = "a".repeat(64);
const KEY = `payment-slips/11/${HASH}/immutable-slip.png`;
const REF = `r2p:${KEY}`;

function readySubject(overrides: Record<string, unknown> = {}) {
  return {
    status: "pending_review",
    slipImageUrl: REF,
    extractedData: JSON.stringify({ fileHash: HASH, reference: "TX-001" }),
    evidenceVersion: 3,
    evidenceClass: "modern_immutable",
    evidenceObjectKey: KEY,
    evidenceFileHash: HASH,
    extractedDataEvidenceVersion: 3,
    ...overrides,
  };
}

function readyRegistry(overrides: Record<string, unknown> = {}) {
  return {
    objectKey: KEY,
    ownerUserId: 11,
    fileHash: HASH,
    byteSize: 2048,
    contentType: "image/png",
    ...overrides,
  };
}

describe("Payment Approval V2 subject evidence eligibility", () => {
  it("accepts a reviewable immutable subject whose version, extraction and registry all bind to the same exact bytes", () => {
    expect(
      evaluateV2SubjectEvidenceEligibility({
        subject: readySubject(),
        ownerUserId: 11,
        registry: readyRegistry(),
      })
    ).toEqual({ ready: true, code: "READY", evidenceVersion: 3, evidenceClass: "modern_immutable" });
  });

  it("rejects legacy compatibility evidence even when the row has a strong file hash", () => {
    expect(
      evaluateV2SubjectEvidenceEligibility({
        subject: readySubject({ evidenceClass: "legacy_compatibility_required" }),
        ownerUserId: 11,
        registry: readyRegistry(),
      })
    ).toMatchObject({ ready: false, code: "EVIDENCE_NOT_IMMUTABLE" });
  });

  it("rejects a finalized subject before V2 can prepare anything", () => {
    expect(
      evaluateV2SubjectEvidenceEligibility({
        subject: readySubject({ status: "approved" }),
        ownerUserId: 11,
        registry: readyRegistry(),
      })
    ).toMatchObject({ ready: false, code: "SUBJECT_NOT_REVIEWABLE" });
  });

  it("rejects a stale extraction that belongs to another evidenceVersion", () => {
    expect(
      evaluateV2SubjectEvidenceEligibility({
        subject: readySubject({ extractedDataEvidenceVersion: 2 }),
        ownerUserId: 11,
        registry: readyRegistry(),
      })
    ).toMatchObject({ ready: false, code: "EVIDENCE_EXTRACTION_NOT_VERSION_BOUND" });
  });

  it("rejects same-looking row fields when the stored reference does not name the registered immutable object", () => {
    expect(
      evaluateV2SubjectEvidenceEligibility({
        subject: readySubject({ slipImageUrl: "r2p:payment-slips/11/other.png" }),
        ownerUserId: 11,
        registry: readyRegistry(),
      })
    ).toMatchObject({ ready: false, code: "EVIDENCE_REFERENCE_MISMATCH" });
  });

  it("rejects extraction/file-hash disagreement", () => {
    expect(
      evaluateV2SubjectEvidenceEligibility({
        subject: readySubject({ extractedData: JSON.stringify({ fileHash: "b".repeat(64) }) }),
        ownerUserId: 11,
        registry: readyRegistry(),
      })
    ).toMatchObject({ ready: false, code: "EVIDENCE_HASH_MISMATCH" });
  });

  it("rejects a registry owned by another account", () => {
    expect(
      evaluateV2SubjectEvidenceEligibility({
        subject: readySubject(),
        ownerUserId: 11,
        registry: readyRegistry({ ownerUserId: 99 }),
      })
    ).toMatchObject({ ready: false, code: "EVIDENCE_REGISTRY_MISMATCH" });
  });

  it("rejects a missing durable registry row instead of assuming r2p syntax means immutable", () => {
    expect(
      evaluateV2SubjectEvidenceEligibility({
        subject: readySubject(),
        ownerUserId: 11,
        registry: undefined,
      })
    ).toMatchObject({ ready: false, code: "EVIDENCE_OBJECT_MISSING" });
  });
});
