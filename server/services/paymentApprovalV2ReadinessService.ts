import * as db from "../db";
import { toPrivateObjectRef } from "@shared/privateFileRef";
import { fileHashFromExtractedData } from "./legacySlipCompatibilityService";
import {
  getTrustedSlipBackfillReadiness,
  type TrustedSlipBackfillReadinessReason,
} from "./slipBackfillStateService";

export type PaymentApprovalV2ReadinessCode =
  | "READY"
  | "LEGACY_COMPATIBILITY_NOT_READY"
  | "SUBJECT_NOT_FOUND"
  | "SUBJECT_NOT_REVIEWABLE"
  | "EVIDENCE_NOT_IMMUTABLE"
  | "EVIDENCE_VERSION_INVALID"
  | "EVIDENCE_OBJECT_MISSING"
  | "EVIDENCE_REFERENCE_MISMATCH"
  | "EVIDENCE_HASH_MISMATCH"
  | "EVIDENCE_EXTRACTION_NOT_VERSION_BOUND"
  | "EVIDENCE_REGISTRY_MISMATCH"
  | "READINESS_CHECK_FAILED";

export interface PaymentApprovalV2Readiness {
  ready: boolean;
  code: PaymentApprovalV2ReadinessCode;
  backfillReason?: TrustedSlipBackfillReadinessReason;
  evidenceVersion?: number;
  evidenceClass?: string;
}

type FinancialSlipSubject = {
  status?: string | null;
  slipImageUrl?: string | null;
  extractedData?: string | null;
  evidenceVersion?: number | bigint | null;
  evidenceClass?: string | null;
  evidenceObjectKey?: string | null;
  evidenceFileHash?: string | null;
  extractedDataEvidenceVersion?: number | bigint | null;
};

type EvidenceRegistryRow = {
  objectKey?: string | null;
  ownerUserId?: number | bigint | null;
  fileHash?: string | null;
  byteSize?: number | bigint | null;
  contentType?: string | null;
};

const IMMUTABLE_EVIDENCE_CLASSES = new Set(["modern_immutable", "legacy_migrated_immutable"]);
const REVIEWABLE_STATUSES = new Set(["pending", "pending_review"]);
const SHA256_HEX = /^[a-f0-9]{64}$/;

function fail(
  code: Exclude<PaymentApprovalV2ReadinessCode, "READY">,
  subject?: FinancialSlipSubject
): PaymentApprovalV2Readiness {
  return {
    ready: false,
    code,
    evidenceVersion:
      subject?.evidenceVersion !== undefined && subject?.evidenceVersion !== null
        ? Number(subject.evidenceVersion)
        : undefined,
    evidenceClass: subject?.evidenceClass ?? undefined,
  };
}

/**
 * Pure subject/evidence gate used by Order and Wallet V2 PREPARE.
 * No network I/O is allowed here. The registry row is already a database-local
 * durable proof that the object identity was created write-once and bound to
 * exact bytes before publication.
 */
export function evaluateV2SubjectEvidenceEligibility(input: {
  subject: FinancialSlipSubject;
  ownerUserId: number;
  registry: EvidenceRegistryRow | undefined;
}): PaymentApprovalV2Readiness {
  const { subject, ownerUserId, registry } = input;

  if (!REVIEWABLE_STATUSES.has(String(subject.status ?? ""))) {
    return fail("SUBJECT_NOT_REVIEWABLE", subject);
  }
  if (!IMMUTABLE_EVIDENCE_CLASSES.has(String(subject.evidenceClass ?? ""))) {
    return fail("EVIDENCE_NOT_IMMUTABLE", subject);
  }

  const evidenceVersion = Number(subject.evidenceVersion);
  if (!Number.isSafeInteger(evidenceVersion) || evidenceVersion <= 0) {
    return fail("EVIDENCE_VERSION_INVALID", subject);
  }

  const objectKey = String(subject.evidenceObjectKey ?? "");
  if (!objectKey || !registry) {
    return fail("EVIDENCE_OBJECT_MISSING", subject);
  }
  if (subject.slipImageUrl !== toPrivateObjectRef(objectKey)) {
    return fail("EVIDENCE_REFERENCE_MISMATCH", subject);
  }

  const evidenceFileHash = String(subject.evidenceFileHash ?? "").toLowerCase();
  if (!SHA256_HEX.test(evidenceFileHash)) {
    return fail("EVIDENCE_HASH_MISMATCH", subject);
  }

  if (Number(subject.extractedDataEvidenceVersion) !== evidenceVersion) {
    return fail("EVIDENCE_EXTRACTION_NOT_VERSION_BOUND", subject);
  }
  const extractedFileHash = fileHashFromExtractedData(subject.extractedData ?? null);
  if (!extractedFileHash || extractedFileHash.toLowerCase() !== evidenceFileHash) {
    return fail("EVIDENCE_HASH_MISMATCH", subject);
  }

  if (
    registry.objectKey !== objectKey ||
    Number(registry.ownerUserId) !== ownerUserId ||
    String(registry.fileHash ?? "").toLowerCase() !== evidenceFileHash ||
    !Number.isSafeInteger(Number(registry.byteSize)) ||
    Number(registry.byteSize) <= 0 ||
    typeof registry.contentType !== "string" ||
    registry.contentType.length === 0
  ) {
    return fail("EVIDENCE_REGISTRY_MISMATCH", subject);
  }

  return {
    ready: true,
    code: "READY",
    evidenceVersion,
    evidenceClass: String(subject.evidenceClass),
  };
}

export async function getPaymentApprovalV2GlobalReadiness(): Promise<PaymentApprovalV2Readiness> {
  const backfill = await getTrustedSlipBackfillReadiness();
  if (!backfill.ready) {
    return {
      ready: false,
      code: "LEGACY_COMPATIBILITY_NOT_READY",
      backfillReason: backfill.reason,
    };
  }
  return { ready: true, code: "READY" };
}

export async function getOrderPaymentV2Eligibility(paymentId: number): Promise<PaymentApprovalV2Readiness> {
  try {
    const global = await getPaymentApprovalV2GlobalReadiness();
    if (!global.ready) return global;

    const payment = await db.getPaymentById(paymentId);
    if (!payment) return fail("SUBJECT_NOT_FOUND");
    const order = await db.getOrderById(payment.orderId);
    if (!order?.userId) return fail("SUBJECT_NOT_FOUND", payment);

    const objectKey = payment.evidenceObjectKey ? String(payment.evidenceObjectKey) : "";
    const registry = objectKey ? await db.getSlipEvidenceObjectByKey(objectKey) : undefined;
    return evaluateV2SubjectEvidenceEligibility({
      subject: payment,
      ownerUserId: Number(order.userId),
      registry,
    });
  } catch {
    return { ready: false, code: "READINESS_CHECK_FAILED" };
  }
}

export async function getWalletTopupV2Eligibility(topupId: number): Promise<PaymentApprovalV2Readiness> {
  try {
    const global = await getPaymentApprovalV2GlobalReadiness();
    if (!global.ready) return global;

    const topup = await db.getWalletTopupById(topupId);
    if (!topup) return fail("SUBJECT_NOT_FOUND");

    const objectKey = topup.evidenceObjectKey ? String(topup.evidenceObjectKey) : "";
    const registry = objectKey ? await db.getSlipEvidenceObjectByKey(objectKey) : undefined;
    return evaluateV2SubjectEvidenceEligibility({
      subject: topup,
      ownerUserId: Number(topup.userId),
      registry,
    });
  } catch {
    return { ready: false, code: "READINESS_CHECK_FAILED" };
  }
}
