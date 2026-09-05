/** Synthetic only. Never read the operator's actual private plan or database. */
import { createHash } from "node:crypto";
import { PREVIEW_AUDIT_TARGETS } from "../../scripts/lib/legacySlipAuditOptions";
import {
  createOperatorAttestation,
  parseRepairPlan,
  PINNED_REPAIR_RUN_ID,
} from "../../scripts/lib/legacySlipRepairContract";
import type { RelinkSourceSnapshot } from "../../scripts/lib/legacySlipRelinkRead";

const TIME = "2026-09-05 09:18:15.123456";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function snapshot(
  target: (typeof PREVIEW_AUDIT_TARGETS)[number]
): RelinkSourceSnapshot {
  const slipImageUrl = `https://d2xsxph8kpxj0f.cloudfront.net/private-fixture/${target.sourceId}.jpg`;
  const common = {
    id: target.sourceId,
    slipImageUrl,
    slipSubmittedAt: TIME,
    evidenceVersion: 0,
    slipEvidenceClass: "legacy_compatibility_required",
    slipEvidenceId: null,
    extractedEvidenceVersion: null,
    status: "approved",
    rejectionReason: null,
    reviewedByUserId: null,
    reviewedAt: null,
    extractedData: null,
    reviewReason: null,
    approvalSource: "legacy",
    approvedByAdminId: null,
    approvedAt: TIME,
    createdAt: TIME,
    updatedAt: TIME,
  };
  const payment = target.sourceType === "order_payment";
  return {
    source: {
      ...target,
      ownerUserId: 3001,
      status: "approved",
      slipImageUrl,
      slipEvidenceClass: "legacy_compatibility_required",
      evidenceVersion: 0,
      slipEvidenceId: null,
      extractedEvidenceVersion: null,
      extractedData: null,
      bindings: [],
      claims: [],
      relatedReadTruncated: false,
    },
    record: payment
      ? {
          ...common,
          orderId: target.sourceId + 100,
          fingerprint: null,
          autoApprovedAt: null,
          linkedOrderId: null,
          linkedPaymentId: null,
          ocrConfidence: 0,
          ocrDecision: "needs_review",
          approvedByLabel: "PRIVATE_FIXTURE_LABEL",
        }
      : {
          ...common,
          userId: 3001,
          requestedAmount: "100.00",
          bonusAmount: "0.00",
          creditedAmount: "100.00",
          rejectedAt: null,
          ocrConfidence: null,
          visionConfidence: null,
          structuredConfidence: null,
          finalConfidence: null,
          duplicateStatus: null,
          ocrDecision: null,
        },
    order: payment
      ? {
          id: target.sourceId + 100,
          orderNumber: "PRIVATE_FIXTURE_ORDER",
          userId: 3001,
          subtotal: "100.00",
          discountAmount: "0.00",
          pointsDiscountAmount: "0.00",
          totalAmount: "100.00",
          status: "approved",
          paymentStatus: "approved",
          couponCodeSnapshot: null,
          notes: "PRIVATE_FIXTURE_NOTES",
          createdAt: TIME,
          updatedAt: TIME,
        }
      : null,
    related: { claims: [], bindings: [], unknowns: [], collisions: [] },
    truncated: false,
  };
}

/** Mutable plan is intentionally exposed so rejection tests can tamper fixtures. */
export function createRepairFixture() {
  const plan = {
    schema: "legacy-slip-reference-review-plan/v1",
    mode: "PREPARE_ONLY",
    runId: PINNED_REPAIR_RUN_ID,
    preparedAt: "2026-09-05T12:00:00.000Z",
    declaredCodeSha: "a".repeat(40),
    toolSourceDigest: "b".repeat(64),
    targetFingerprint: "c".repeat(64),
    codeShaVerification: "OPERATOR_DECLARED_NOT_VERIFIED",
    toolSourceDigestPurpose:
      "EXACT_LOCAL_SOURCE_FINGERPRINT_NOT_DEPLOYMENT_ATTESTATION",
    targetScope: "PINNED_PREVIEW_TEN_LEGACY_RECORDS",
    collisionCoverage: "KNOWN_REGISTRIES_OBJECT_REFERENCES_AND_THIS_BATCH_ONLY",
    historicalCoverageComplete: false,
    snapshotTimestampSemantics:
      "DATABASE_SESSION_WALL_TIME_NOT_NORMALIZED_TO_UTC",
    rows: PREVIEW_AUDIT_TARGETS.map(target => {
      const before = snapshot(target);
      const key = `payment-slips/legacy/${target.sourceType === "order_payment" ? "payments" : "wallet-topups"}/${target.sourceId}/1780000000000-fixture.jpg`;
      return {
        ...target,
        status: "NEEDS_ATTESTATION",
        blockers: [] as string[],
        snapshot: { before, after: structuredClone(before) },
        candidate: {
          listing: {
            candidateCount: 1,
            unexpectedObjectCount: 0,
            truncated: false,
          },
          candidate: { key, etag: '"privatefixtureetag"', size: 193902 },
          bytes: {
            rawHash: digest(`raw-${key}`),
            canonicalHash: digest(`canonical-${key}`),
            byteLength: 193902,
            mimeType: "image/jpeg",
          },
        },
        crossReferences: {
          claims: [],
          collisions: [],
          bindings: [],
          uploads: [],
          references: [],
          truncated: false,
        },
        proposal: {
          field: "slipImageUrl",
          before: before.source.slipImageUrl,
          after: `r2p:${key}`,
          referenceOnly: true,
          preserveAllOtherFields: true,
          updatedAtMayChangeAutomatically: true,
        },
        mappingProvenance: "UNREVIEWED",
        historicalByteIdentity: "UNPROVEN",
        approval: null,
        writeAuthorized: false,
        pointInTimeOnly: true,
      };
    }),
    writeAuthorized: false,
    isApplyManifest: false,
    pointInTimeOnly: true,
    requiredNextAction:
      "HUMAN_MAPPING_REVIEW_THEN_SEPARATE_IMPLEMENTATION_AUTHORIZATION",
  };
  const planBytes = Buffer.from(JSON.stringify(plan));
  const planSha256 = createHash("sha256").update(planBytes).digest("hex");
  const intent = parseRepairPlan(planBytes, planSha256);
  const attestation = createOperatorAttestation(intent, {
    reviewer: "fixture-first-reviewer",
    reason:
      "Operator confirms matching transaction using private supporting evidence.",
    evidenceReference: "private-fixture-evidence-record-1",
    recordedAt: "2026-09-05T13:00:00.000Z",
  });
  return { plan, planBytes, planSha256, intent, attestation };
}
