import { describe, expect, it } from "vitest";
import {
  buildLegacySlipReconciliationPlan,
  LEGACY_SLIP_RECONCILIATION_OPERATIONAL_CODES,
  type AuditSource,
  type CandidateBytes,
  type CandidateListing,
} from "./helpers/legacySlipReconciliationPlan";

const CANONICAL = "a".repeat(64);
const RAW = "b".repeat(64);
const OTHER = "c".repeat(64);
const bytes: CandidateBytes = {
  rawHash: RAW,
  canonicalHash: CANONICAL,
  byteLength: 128,
  mimeType: "image/png",
};
const listing: CandidateListing = {
  candidateCount: 1,
  unexpectedObjectCount: 0,
  truncated: false,
};

function approvedLegacy(overrides: Partial<AuditSource> = {}): AuditSource {
  return {
    sourceType: "order_payment",
    sourceId: 77,
    ownerUserId: 123456789,
    status: "approved",
    slipImageUrl:
      "https://d2xsxph8kpxj0f.cloudfront.net/private-secret-folder/slip.png?signature=secret",
    slipEvidenceClass: "legacy_compatibility_required",
    evidenceVersion: 2,
    slipEvidenceId: null,
    extractedEvidenceVersion: 2,
    extractedData: JSON.stringify({
      fileHash: CANONICAL,
      rawText: "private OCR text",
    }),
    bindings: [],
    claims: [{ id: 10, userId: 123456789, fileHash: CANONICAL }],
    relatedReadTruncated: false,
    ...overrides,
  };
}

function plan(
  overrides: Partial<
    Parameters<typeof buildLegacySlipReconciliationPlan>[0]
  > = {},
  source = approvedLegacy()
) {
  return buildLegacySlipReconciliationPlan({
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    before: source,
    after: structuredClone(source),
    bytes,
    listing,
    ...overrides,
  });
}

describe("read-only legacy slip reference reconciliation plan", () => {
  it.each(["order_payment", "wallet_topup"] as const)(
    "requires canonical version-bound identity for %s review only",
    sourceType => {
      const report = plan({}, approvedLegacy({ sourceType }));
      expect(report).toMatchObject({
        statusCategory: "REVIEW_REQUIRED",
        identityVerification: "VERIFIED",
        hashComparison: "CANONICAL_MATCH",
        blockers: [],
        action: "REVIEW_REFERENCE_REPAIR",
        writeAuthorized: false,
        pointInTimeOnly: true,
      });
    }
  );

  it.each([1, 2, 3])(
    "recognizes a bounded %i-decode JSON wrapper without rewriting extraction",
    depth => {
      let extractedData = JSON.stringify({ fileHash: CANONICAL });
      for (let i = 1; i < depth; i += 1)
        extractedData = JSON.stringify(extractedData);
      const source = approvedLegacy({ extractedData });
      const report = plan({}, source);
      expect(report.action).toBe("REVIEW_REFERENCE_REPAIR");
      expect(report.snapshot.before.parseDepth).toBe(depth);
      expect(source.extractedData).toBe(extractedData);
    }
  );

  it.each([
    null,
    "not JSON",
    "[]",
    "null",
    "{}",
    '{"fileHash":"short"}',
    JSON.stringify({ fileHash: "z".repeat(64) }),
    JSON.stringify({ fileHash: ` ${CANONICAL}` }),
    JSON.stringify(
      JSON.stringify(JSON.stringify(JSON.stringify({ fileHash: CANONICAL })))
    ),
  ])(
    "candidate bytes alone cannot establish source identity for invalid/missing extraction %#",
    extractedData => {
      const report = plan({}, approvedLegacy({ extractedData }));
      expect(report.action).toBe("NONE");
      expect(report.identityVerification).toBe("UNPROVEN");
      expect(report.snapshot.before.parseDepth).toBeLessThanOrEqual(3);
    }
  );

  it("does not convert raw-only agreement to an eligible canonical identity", () => {
    const report = plan(
      {},
      approvedLegacy({ extractedData: JSON.stringify({ fileHash: RAW }) })
    );
    expect(report).toMatchObject({
      action: "NONE",
      identityVerification: "HASH_FORMAT_REVIEW",
      hashComparison: "RAW_ONLY_MATCH",
    });
    expect(report.blockers).toContain("HASH_FORMAT_REVIEW");
  });

  it("reports mismatched identity without leaking either hash", () => {
    const report = plan(
      {},
      approvedLegacy({ extractedData: JSON.stringify({ fileHash: OTHER }) })
    );
    expect(report).toMatchObject({
      action: "NONE",
      identityVerification: "IDENTITY_MISMATCH",
    });
    expect(report.blockers).toContain("IDENTITY_MISMATCH");
    expect(JSON.stringify(report)).not.toMatch(
      new RegExp(`${CANONICAL}|${RAW}|${OTHER}`)
    );
  });

  it.each([null, 0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unproven evidence version %s",
    evidenceVersion => {
      const report = plan(
        {},
        approvedLegacy({
          evidenceVersion,
          extractedEvidenceVersion: evidenceVersion,
        })
      );
      expect(report.action).toBe("NONE");
      expect(report.identityVerification).toBe("UNPROVEN");
      expect(report.blockers).toContain("EVIDENCE_VERSION_UNPROVEN");
    }
  );

  it.each([null, 0, 1, 3])(
    "rejects extraction from a different or unknown evidence version %s",
    extractedEvidenceVersion => {
      const report = plan({}, approvedLegacy({ extractedEvidenceVersion }));
      expect(report.action).toBe("NONE");
      expect(report.blockers).toContain("EXTRACTED_VERSION_MISMATCH");
    }
  );

  it.each([
    { candidateCount: 0, unexpectedObjectCount: 0, truncated: false },
    { candidateCount: 2, unexpectedObjectCount: 0, truncated: false },
    { candidateCount: 1, unexpectedObjectCount: 1, truncated: false },
    { candidateCount: 1, unexpectedObjectCount: 0, truncated: true },
    { candidateCount: 1, unexpectedObjectCount: 0, truncated: null },
    { candidateCount: -1, unexpectedObjectCount: 0, truncated: false },
    { candidateCount: 1.5, unexpectedObjectCount: 0, truncated: false },
    { candidateCount: 1, unexpectedObjectCount: NaN, truncated: false },
  ])("requires one complete unambiguous listing %#", candidateListing => {
    expect(plan({ listing: candidateListing }).action).toBe("NONE");
  });

  it("classifies multiple candidates as ambiguous even when one candidate's bytes match", () => {
    expect(
      plan({ listing: { ...listing, candidateCount: 2 } }).blockers
    ).toContain("AMBIGUOUS_CANDIDATES");
  });

  it.each([
    { status: "pending_review" },
    { status: "rejected" },
    { slipEvidenceClass: "unknown" },
    { ownerUserId: null },
    { ownerUserId: 0 },
    { ownerUserId: Number.MAX_SAFE_INTEGER + 1 },
    { slipEvidenceId: 3 },
    { bindings: [{ id: 3 }] },
    { relatedReadTruncated: true },
  ])("fails closed on ineligible source metadata %#", change => {
    expect(plan({}, approvedLegacy(change)).action).toBe("NONE");
  });

  it.each([
    { id: 10, userId: 123456788, fileHash: CANONICAL },
    { id: 10, userId: 123456788, fileHash: null },
    { id: 10, userId: 123456789, fileHash: RAW },
    { id: 10, userId: 123456789, fileHash: "bad hash" },
  ])("blocks any same-source claim owner/hash conflict %#", claim => {
    const report = plan({}, approvedLegacy({ claims: [claim] }));
    expect(report.action).toBe("NONE");
    expect(report.blockers).toContain("CLAIM_CONFLICT");
  });

  it("allows an owner-matching null claim file hash without inventing or updating it", () => {
    const source = approvedLegacy({
      claims: [{ id: 10, userId: 123456789, fileHash: null }],
    });
    expect(plan({}, source).action).toBe("REVIEW_REFERENCE_REPAIR");
    expect(source.claims[0].fileHash).toBeNull();
  });

  it.each([
    { ownerUserId: 9 },
    { status: "pending" },
    { slipImageUrl: "different-reference" },
    { slipEvidenceClass: "legacy_migrated_immutable" },
    { evidenceVersion: 3 },
    { slipEvidenceId: 1 },
    { extractedEvidenceVersion: 3 },
    { extractedData: JSON.stringify({ fileHash: CANONICAL }) },
    { bindings: [{ id: 1 }] },
    { claims: [] },
    { relatedReadTruncated: true },
  ])("detects every snapshot change, not only a hash change %#", change => {
    const source = approvedLegacy();
    const report = plan(
      { before: source, after: { ...structuredClone(source), ...change } },
      source
    );
    expect(report.action).toBe("NONE");
    expect(report.blockers).toContain("SOURCE_CHANGED");
  });

  it("skips already-private control sources regardless of listing ambiguity", () => {
    const source = approvedLegacy({
      sourceId: 10020002,
      slipImageUrl: "r2p:control-private-key",
    });
    const report = plan(
      {
        listing: {
          candidateCount: 9,
          unexpectedObjectCount: 5,
          truncated: true,
        },
        bytes: null,
      },
      source
    );
    expect(report).toMatchObject({ statusCategory: "SKIPPED", action: "NONE" });
    expect(report.blockers).toContain("SKIP_ALREADY_PRIVATE");
    expect(report.blockers).not.toContain("AMBIGUOUS_CANDIDATES");
  });

  it.each(["modern_immutable", "legacy_migrated_immutable"])(
    "never proposes repairs of protected class %s",
    slipEvidenceClass => {
      expect(plan({}, approvedLegacy({ slipEvidenceClass }))).toMatchObject({
        statusCategory: "SKIPPED",
        action: "NONE",
      });
    }
  );

  it.each([
    null,
    "",
    "https://untrusted.example/slip.png",
    "http://d2xsxph8kpxj0f.cloudfront.net/slip.png",
    "https://user:secret@d2xsxph8kpxj0f.cloudfront.net/slip.png",
    "https://d2xsxph8kpxj0f.cloudfront.net:444/slip.png",
    "https://d2xsxph8kpxj0f.cloudfront.net.evil.example/slip.png",
  ])("blocks unsupported or missing source references %#", slipImageUrl => {
    const report = plan({}, approvedLegacy({ slipImageUrl }));
    expect(report.action).toBe("NONE");
    expect(report.blockers).toContain("SOURCE_REFERENCE_NOT_TRUSTED_LEGACY");
  });

  it("requires both snapshots and exact target identity", () => {
    expect(plan({ before: null }).blockers).toContain("SOURCE_NOT_FOUND");
    expect(plan({ after: null }).blockers).toContain("SOURCE_NOT_FOUND");
    const wrong = approvedLegacy({ sourceId: 78 });
    expect(plan({ before: wrong, after: wrong }).blockers).toContain(
      "SOURCE_TARGET_MISMATCH"
    );
    expect(plan({ sourceId: -1 }).action).toBe("NONE");
  });

  it.each([
    null,
    { ...bytes, canonicalHash: "wrong" },
    { ...bytes, rawHash: "wrong" },
    { ...bytes, byteLength: 0 },
    { ...bytes, mimeType: "application/octet-stream" as any },
  ])(
    "requires complete validated candidate byte evidence %#",
    candidateBytes => {
      expect(plan({ bytes: candidateBytes }).action).toBe("NONE");
    }
  );

  it("maps only allowlisted operational codes, never the original error details", () => {
    for (const operationalError of LEGACY_SLIP_RECONCILIATION_OPERATIONAL_CODES) {
      const report = plan({ operationalError });
      expect(report.blockers).toContain(operationalError);
      expect(report.action).toBe("NONE");
    }
    const secret =
      "SQL objectkey https://secret.example/signature?token=secret";
    const report = plan({ operationalError: secret });
    expect(report.blockers).toContain("OPERATION_FAILED");
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("never emits source URLs, keys, hashes, OCR data or owner/claim user IDs", () => {
    const source = approvedLegacy();
    const report = plan({}, source);
    const output = JSON.stringify(report);
    for (const forbidden of [
      source.slipImageUrl!,
      "private-secret-folder",
      CANONICAL,
      RAW,
      "private OCR text",
      "123456789",
    ]) {
      expect(output).not.toContain(forbidden);
    }
    expect(output).not.toContain("apply");
    expect(report.writeAuthorized).toBe(false);
    expect(report.pointInTimeOnly).toBe(true);
    expect(
      plan(
        {},
        approvedLegacy({
          slipEvidenceClass: source.slipImageUrl!,
          status: "private OCR text",
        })
      ).snapshot.after
    ).toMatchObject({ evidenceClass: "UNRECOGNIZED", status: "UNRECOGNIZED" });
  });

  it("does not mutate either snapshot or candidate inputs", () => {
    const before = approvedLegacy();
    const after = structuredClone(before);
    const input = {
      sourceType: before.sourceType,
      sourceId: before.sourceId,
      before,
      after,
      bytes,
      listing,
    };
    const original = JSON.stringify(input);
    buildLegacySlipReconciliationPlan(input);
    expect(JSON.stringify(input)).toBe(original);
  });
});
