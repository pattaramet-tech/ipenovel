/** Pure, read-only eligibility report. This is not an apply manifest. */
export type SourceType = "order_payment" | "wallet_topup";

export type AuditSource = {
  sourceType: SourceType;
  sourceId: number;
  ownerUserId: number | null;
  status: string;
  slipImageUrl: string | null;
  slipEvidenceClass: string;
  evidenceVersion: number | null;
  slipEvidenceId: number | null;
  extractedEvidenceVersion: number | null;
  extractedData: string | null;
  bindings: Array<{ id: number }>;
  claims: Array<{ id: number; userId: number; fileHash: string | null }>;
  relatedReadTruncated: boolean;
};

export type CandidateListing = {
  candidateCount: number;
  unexpectedObjectCount: number;
  truncated: boolean | null;
};

export type CandidateBytes = {
  rawHash: string;
  canonicalHash: string;
  byteLength: number;
  mimeType: "image/jpeg" | "image/png" | "application/pdf";
};

export const LEGACY_SLIP_RECONCILIATION_OPERATIONAL_CODES = [
  "SOURCE_READ_FAILED",
  "CANDIDATE_LIST_FAILED",
  "CANDIDATE_READ_FAILED",
  "OBJECT_READ_TIMEOUT",
  "OBJECT_TOO_LARGE",
  "UNSUPPORTED_FILE_TYPE",
  "OBJECT_VERSION_CHANGED",
  "OBJECT_VERSION_UNAVAILABLE",
  "INVALID_OBJECT_LISTING",
  "RUN_DEADLINE_EXCEEDED",
  "EMPTY_OBJECT",
  "INVALID_OBJECT_BODY",
] as const;

type OperationalCode =
  (typeof LEGACY_SLIP_RECONCILIATION_OPERATIONAL_CODES)[number];
const OPERATIONAL_CODES = new Set<string>(
  LEGACY_SLIP_RECONCILIATION_OPERATIONAL_CODES
);

type Blocker =
  | OperationalCode
  | "OPERATION_FAILED"
  | "INVALID_TARGET"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_TARGET_MISMATCH"
  | "SOURCE_CHANGED"
  | "SKIP_ALREADY_PRIVATE"
  | "SKIP_PROTECTED_EVIDENCE"
  | "SOURCE_NOT_APPROVED"
  | "SOURCE_CLASS_NOT_LEGACY"
  | "EXISTING_EVIDENCE_BINDING"
  | "SOURCE_REFERENCE_NOT_TRUSTED_LEGACY"
  | "RELATED_READ_TRUNCATED"
  | "OWNER_UNPROVEN"
  | "EVIDENCE_VERSION_UNPROVEN"
  | "EXTRACTED_VERSION_MISMATCH"
  | "EXTRACTED_DATA_UNREADABLE"
  | "SOURCE_HASH_MISSING"
  | "SOURCE_HASH_INVALID"
  | "CANDIDATE_LIST_UNAVAILABLE"
  | "NO_CANDIDATE"
  | "AMBIGUOUS_CANDIDATES"
  | "UNEXPECTED_OBJECTS"
  | "CANDIDATE_LIST_INCOMPLETE"
  | "CANDIDATE_BYTES_UNAVAILABLE"
  | "CANDIDATE_BYTES_INVALID"
  | "HASH_FORMAT_REVIEW"
  | "IDENTITY_MISMATCH"
  | "CLAIM_CONFLICT";

const HEX_64 = /^[a-f0-9]{64}$/i;
const SAFE_EVIDENCE_CLASSES = new Set([
  "modern_immutable",
  "legacy_migrated_immutable",
  "legacy_compatibility_required",
]);
const SAFE_STATUSES = new Set([
  "approved",
  "pending",
  "pending_review",
  "rejected",
  "cancelled",
]);

/** Same origin restrictions as legacy slip hashing; classification only, no fetch. */
export function isAuditTrustedLegacyReference(value: string | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "d2xsxph8kpxj0f.cloudfront.net" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443")
    );
  } catch {
    return false;
  }
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isHex64(value: unknown): value is string {
  return typeof value === "string" && HEX_64.test(value);
}

/** At most three JSON decodes, including recognized string wrappers. */
function parseSourceHash(raw: string | null) {
  let value: unknown = raw;
  let parseDepth = 0;
  if (raw === null)
    return {
      parseDepth,
      readable: false,
      hash: undefined,
      issue: "SOURCE_HASH_MISSING" as const,
    };
  while (typeof value === "string" && parseDepth < 3) {
    try {
      value = JSON.parse(value);
      parseDepth += 1;
    } catch {
      return {
        parseDepth,
        readable: false,
        hash: undefined,
        issue: "EXTRACTED_DATA_UNREADABLE" as const,
      };
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      parseDepth,
      readable: false,
      hash: undefined,
      issue: "EXTRACTED_DATA_UNREADABLE" as const,
    };
  }
  if (!Object.hasOwn(value, "fileHash")) {
    return {
      parseDepth,
      readable: true,
      hash: undefined,
      issue: "SOURCE_HASH_MISSING" as const,
    };
  }
  const hash = (value as { fileHash?: unknown }).fileHash;
  if (!isHex64(hash))
    return {
      parseDepth,
      readable: true,
      hash: undefined,
      issue: "SOURCE_HASH_INVALID" as const,
    };
  return {
    parseDepth,
    readable: true,
    hash: hash.toLowerCase(),
    issue: undefined,
  };
}

function summarize(source: AuditSource | null) {
  const parsed = source ? parseSourceHash(source.extractedData) : undefined;
  return {
    present: source !== null,
    status: source
      ? SAFE_STATUSES.has(source.status)
        ? source.status
        : "UNRECOGNIZED"
      : null,
    evidenceClass: source
      ? SAFE_EVIDENCE_CLASSES.has(source.slipEvidenceClass)
        ? source.slipEvidenceClass
        : "UNRECOGNIZED"
      : null,
    evidenceVersion: nonNegativeSafeInteger(source?.evidenceVersion)
      ? source.evidenceVersion
      : null,
    evidenceId: positiveSafeInteger(source?.slipEvidenceId)
      ? source.slipEvidenceId
      : null,
    extractedEvidenceVersion: nonNegativeSafeInteger(
      source?.extractedEvidenceVersion
    )
      ? source.extractedEvidenceVersion
      : null,
    claimCount: source?.claims.length ?? 0,
    bindingCount: source?.bindings.length ?? 0,
    parseDepth: parsed?.parseDepth ?? 0,
    extractionReadable: parsed?.readable ?? false,
  };
}

/**
 * Compares the adapter's deterministic, complete before/after snapshots.
 * Content identity alone is insufficient: its persisted hash must belong to
 * the same positive evidence version, and every safety gate must also pass.
 * No raw URL, object key, hash, OCR data or owner/claim user ID is returned.
 */
export function buildLegacySlipReconciliationPlan(input: {
  sourceType: SourceType;
  sourceId: number;
  before: AuditSource | null;
  after: AuditSource | null;
  listing: CandidateListing | null;
  bytes: CandidateBytes | null;
  operationalError?: string;
}) {
  const blockers: Blocker[] = [];
  const add = (blocker: Blocker) => {
    if (!blockers.includes(blocker)) blockers.push(blocker);
  };
  let skipped = false;
  let identityVerification:
    "VERIFIED" | "UNPROVEN" | "HASH_FORMAT_REVIEW" | "IDENTITY_MISMATCH" =
    "UNPROVEN";
  let hashComparison:
    "NOT_COMPARED" | "CANONICAL_MATCH" | "RAW_ONLY_MATCH" | "MISMATCH" =
    "NOT_COMPARED";
  const source = input.after ?? input.before;
  const targetTypeValid =
    input.sourceType === "order_payment" || input.sourceType === "wallet_topup";

  const finish = () => {
    const eligible =
      blockers.length === 0 && identityVerification === "VERIFIED";
    return {
      sourceType: targetTypeValid
        ? input.sourceType
        : ("UNRECOGNIZED" as const),
      sourceId: positiveSafeInteger(input.sourceId) ? input.sourceId : null,
      statusCategory: skipped
        ? ("SKIPPED" as const)
        : eligible
          ? ("REVIEW_REQUIRED" as const)
          : ("BLOCKED" as const),
      identityVerification,
      hashComparison,
      blockers,
      snapshot: {
        before: summarize(input.before),
        after: summarize(input.after),
      },
      candidates: {
        candidateCount: nonNegativeSafeInteger(input.listing?.candidateCount)
          ? input.listing.candidateCount
          : null,
        unexpectedObjectCount: nonNegativeSafeInteger(
          input.listing?.unexpectedObjectCount
        )
          ? input.listing.unexpectedObjectCount
          : null,
        truncated:
          typeof input.listing?.truncated === "boolean"
            ? input.listing.truncated
            : null,
      },
      candidateBytes: {
        inspected: input.bytes !== null,
        byteLength: positiveSafeInteger(input.bytes?.byteLength)
          ? input.bytes.byteLength
          : null,
        mimeType:
          input.bytes &&
          ["image/jpeg", "image/png", "application/pdf"].includes(
            input.bytes.mimeType
          )
            ? input.bytes.mimeType
            : null,
        formatValidation: "SIGNATURE_ONLY" as const,
      },
      action: eligible
        ? ("REVIEW_REFERENCE_REPAIR" as const)
        : ("NONE" as const),
      writeAuthorized: false as const,
      pointInTimeOnly: true as const,
      claimCheckScope: "SAME_SOURCE_ONLY" as const,
    };
  };

  if (!targetTypeValid || !positiveSafeInteger(input.sourceId))
    add("INVALID_TARGET");
  if (!input.before || !input.after) add("SOURCE_NOT_FOUND");
  if (JSON.stringify(input.before) !== JSON.stringify(input.after))
    add("SOURCE_CHANGED");
  for (const snapshot of [input.before, input.after]) {
    if (
      snapshot &&
      (snapshot.sourceType !== input.sourceType ||
        snapshot.sourceId !== input.sourceId)
    )
      add("SOURCE_TARGET_MISMATCH");
  }
  if (input.operationalError !== undefined) {
    add(
      OPERATIONAL_CODES.has(input.operationalError)
        ? (input.operationalError as OperationalCode)
        : "OPERATION_FAILED"
    );
  }
  if (!source) return finish();

  // Already-private/protected sources are never reference-repair candidates,
  // even if an independent object listing happens to contain duplicates.
  if (
    [input.before, input.after].some(snapshot =>
      snapshot?.slipImageUrl?.startsWith("r2p:")
    )
  ) {
    skipped = true;
    add("SKIP_ALREADY_PRIVATE");
    return finish();
  }
  if (
    source.slipEvidenceClass === "modern_immutable" ||
    source.slipEvidenceClass === "legacy_migrated_immutable"
  ) {
    skipped = true;
    add("SKIP_PROTECTED_EVIDENCE");
    return finish();
  }

  if (source.status !== "approved") add("SOURCE_NOT_APPROVED");
  if (!isAuditTrustedLegacyReference(source.slipImageUrl))
    add("SOURCE_REFERENCE_NOT_TRUSTED_LEGACY");
  if (source.slipEvidenceClass !== "legacy_compatibility_required")
    add("SOURCE_CLASS_NOT_LEGACY");
  if (source.slipEvidenceId !== null || source.bindings.length !== 0)
    add("EXISTING_EVIDENCE_BINDING");
  if (source.relatedReadTruncated !== false) add("RELATED_READ_TRUNCATED");
  if (!positiveSafeInteger(source.ownerUserId)) add("OWNER_UNPROVEN");
  const versionProven = positiveSafeInteger(source.evidenceVersion);
  if (!versionProven) add("EVIDENCE_VERSION_UNPROVEN");
  const extractionBound =
    versionProven && source.extractedEvidenceVersion === source.evidenceVersion;
  if (!extractionBound) add("EXTRACTED_VERSION_MISMATCH");

  const parsed = parseSourceHash(source.extractedData);
  if (parsed.issue) add(parsed.issue);

  if (!input.listing) add("CANDIDATE_LIST_UNAVAILABLE");
  else {
    if (
      !nonNegativeSafeInteger(input.listing.candidateCount) ||
      !nonNegativeSafeInteger(input.listing.unexpectedObjectCount)
    )
      add("INVALID_OBJECT_LISTING");
    if (input.listing.candidateCount === 0) add("NO_CANDIDATE");
    if (input.listing.candidateCount > 1) add("AMBIGUOUS_CANDIDATES");
    if (input.listing.unexpectedObjectCount > 0) add("UNEXPECTED_OBJECTS");
    if (input.listing.truncated !== false) add("CANDIDATE_LIST_INCOMPLETE");
  }

  const bytesValid =
    input.bytes !== null &&
    isHex64(input.bytes.rawHash) &&
    isHex64(input.bytes.canonicalHash) &&
    positiveSafeInteger(input.bytes.byteLength) &&
    ["image/jpeg", "image/png", "application/pdf"].includes(
      input.bytes.mimeType
    );
  if (!input.bytes) add("CANDIDATE_BYTES_UNAVAILABLE");
  else if (!bytesValid) add("CANDIDATE_BYTES_INVALID");

  if (parsed.hash && bytesValid && input.bytes) {
    if (parsed.hash === input.bytes.canonicalHash.toLowerCase()) {
      hashComparison = "CANONICAL_MATCH";
      if (extractionBound) identityVerification = "VERIFIED";
    } else if (parsed.hash === input.bytes.rawHash.toLowerCase()) {
      hashComparison = "RAW_ONLY_MATCH";
      identityVerification = "HASH_FORMAT_REVIEW";
      add("HASH_FORMAT_REVIEW");
    } else {
      hashComparison = "MISMATCH";
      identityVerification = "IDENTITY_MISMATCH";
      add("IDENTITY_MISMATCH");
    }
  }
  for (const claim of source.claims) {
    if (
      !positiveSafeInteger(claim.userId) ||
      claim.userId !== source.ownerUserId ||
      (claim.fileHash !== null &&
        (!isHex64(claim.fileHash) ||
          (bytesValid &&
            input.bytes &&
            claim.fileHash.toLowerCase() !==
              input.bytes.canonicalHash.toLowerCase())))
    ) {
      add("CLAIM_CONFLICT");
    }
  }
  return finish();
}

export type LegacySlipReconciliationPlan = ReturnType<
  typeof buildLegacySlipReconciliationPlan
>;
