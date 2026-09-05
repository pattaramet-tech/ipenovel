import { createHash } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import {
  PREVIEW_AUDIT_TARGETS,
  type LegacySlipAuditEnvironment,
} from "./legacySlipAuditOptions";
import {
  createObjectReaders,
  AuditReadError,
  type AuditTarget,
  type ListedCandidates,
} from "./legacySlipAuditRuntime";
import {
  isAuditTrustedLegacyReference,
  type CandidateBytes,
} from "../../server/helpers/legacySlipReconciliationPlan";
import {
  createRelinkDatabaseReaders,
  RelinkReadError,
  type RelinkSourceSnapshot,
  type RelinkCrossReferences,
} from "./legacySlipRelinkRead";

const DEADLINE_MS = 240_000;
const MAX_BYTES = 5 * 1024 * 1024;
const HEX64 = /^[a-f0-9]{64}$/;
const IO_CODES = new Set([
  "SOURCE_READ_FAILED",
  "CROSS_REFERENCE_READ_FAILED",
  "INVALID_TARGET",
  "CANDIDATE_LIST_FAILED",
  "CANDIDATE_READ_FAILED",
  "OBJECT_READ_TIMEOUT",
  "OBJECT_TOO_LARGE",
  "UNSUPPORTED_FILE_TYPE",
  "OBJECT_VERSION_CHANGED",
  "OBJECT_VERSION_UNAVAILABLE",
  "INVALID_OBJECT_LISTING",
  "EMPTY_OBJECT",
  "INVALID_OBJECT_BODY",
  "RUN_DEADLINE_EXCEEDED",
]);

export interface RelinkReaders {
  readSource(target: AuditTarget): Promise<RelinkSourceSnapshot | null>;
  listCandidate(target: AuditTarget): Promise<ListedCandidates>;
  readCandidate(
    candidate: NonNullable<ListedCandidates["candidate"]>
  ): Promise<CandidateBytes>;
  readCrossReferences(input: {
    target: AuditTarget;
    canonicalHash: string;
    rawHash: string;
    key: string;
  }): Promise<RelinkCrossReferences>;
}

export interface RelinkPlanMetadata {
  runId: string;
  preparedAt: string;
  declaredCodeSha: string;
  toolSourceDigest: string;
  targetFingerprint: string;
}

interface PrivateObservation {
  target: AuditTarget;
  before: RelinkSourceSnapshot | null;
  after: RelinkSourceSnapshot | null;
  listed: ListedCandidates | null;
  bytes: CandidateBytes | null;
  crossReferences: RelinkCrossReferences | null;
  error: string | null;
  blockedByBatchDuplicate: boolean;
}

function sourceBlockers(
  snapshot: RelinkSourceSnapshot | null,
  target: AuditTarget
): string[] {
  if (!snapshot) return ["SOURCE_UNAVAILABLE"];
  const s = snapshot.source;
  const blockers: string[] = [];
  if (s.sourceId !== target.sourceId || s.sourceType !== target.sourceType)
    blockers.push("SOURCE_TARGET_MISMATCH");
  if (s.status !== "approved") blockers.push("SOURCE_NOT_APPROVED");
  if (s.slipImageUrl?.startsWith("r2p:")) blockers.push("SKIP_ALREADY_PRIVATE");
  if (s.slipEvidenceClass !== "legacy_compatibility_required")
    blockers.push("SOURCE_NOT_LEGACY_COMPATIBILITY");
  if (!isAuditTrustedLegacyReference(s.slipImageUrl))
    blockers.push("SOURCE_REFERENCE_NOT_TRUSTED_LEGACY");
  if (s.evidenceVersion !== 0) blockers.push("SOURCE_NOT_VERSION_ZERO");
  if (s.slipEvidenceId !== null || s.bindings.length !== 0)
    blockers.push("EXISTING_EVIDENCE_BINDING");
  if (s.extractedData !== null || s.extractedEvidenceVersion !== null)
    blockers.push("EXTRACTION_STATE_CHANGED");
  if (!Number.isSafeInteger(s.ownerUserId) || s.ownerUserId! <= 0)
    blockers.push("OWNER_UNPROVEN");
  if (s.claims.length !== 0 || snapshot.related.claims.length !== 0)
    blockers.push("SOURCE_CLAIMS_PRESENT");
  if (snapshot.related.bindings.length !== 0)
    blockers.push("EXISTING_EVIDENCE_BINDING");
  if (snapshot.related.collisions.length !== 0)
    blockers.push("KNOWN_SOURCE_COLLISION");
  if (snapshot.truncated || s.relatedReadTruncated)
    blockers.push("RELATED_READ_INCOMPLETE");
  return [...new Set(blockers)];
}

function candidateValid(
  target: AuditTarget,
  listed: ListedCandidates | null
): boolean {
  if (
    !listed?.candidate ||
    listed.listing.candidateCount !== 1 ||
    listed.listing.unexpectedObjectCount !== 0 ||
    listed.listing.truncated !== false
  )
    return false;
  const folder =
    target.sourceType === "order_payment" ? "payments" : "wallet-topups";
  const prefix = `payment-slips/legacy/${folder}/${target.sourceId}/`;
  return (
    listed.candidate.key.startsWith(prefix) &&
    /^\d+-[a-z0-9]+\.(jpg|png|pdf)$/.test(
      listed.candidate.key.slice(prefix.length)
    ) &&
    /^"[A-Za-z0-9._-]+"$/.test(listed.candidate.etag ?? "") &&
    Number.isSafeInteger(listed.candidate.size) &&
    listed.candidate.size > 0 &&
    listed.candidate.size <= MAX_BYTES
  );
}

function bytesValid(
  bytes: CandidateBytes | null,
  listed: ListedCandidates | null
): bytes is CandidateBytes {
  return (
    !!bytes &&
    HEX64.test(bytes.rawHash) &&
    HEX64.test(bytes.canonicalHash) &&
    Number.isSafeInteger(bytes.byteLength) &&
    bytes.byteLength > 0 &&
    bytes.byteLength <= MAX_BYTES &&
    bytes.byteLength === listed?.candidate?.size &&
    ["image/jpeg", "image/png", "application/pdf"].includes(bytes.mimeType)
  );
}

function finishObservation(observation: PrivateObservation) {
  const {
    target,
    before,
    after,
    listed,
    bytes,
    crossReferences: cross,
  } = observation;
  const blockers = new Set([
    ...sourceBlockers(before, target),
    ...sourceBlockers(after, target),
  ]);
  if (before && after && JSON.stringify(before) !== JSON.stringify(after))
    blockers.add("SOURCE_CHANGED");
  if (before && !after && !observation.error) blockers.add("SOURCE_CHANGED");
  if (observation.error)
    blockers.add(
      IO_CODES.has(observation.error) ? observation.error : "OPERATION_FAILED"
    );
  if (!candidateValid(target, listed))
    blockers.add("CANDIDATE_NOT_UNAMBIGUOUS_AND_COMPLETE");
  if (!bytesValid(bytes, listed))
    blockers.add("CANDIDATE_BYTES_UNAVAILABLE_OR_INVALID");
  if (!cross) blockers.add("CROSS_REFERENCE_READ_UNAVAILABLE");
  else {
    if (cross.truncated) blockers.add("CROSS_REFERENCE_READ_INCOMPLETE");
    // Any known match requires separate investigation; never pick an owner/winner.
    if (cross.claims.length) blockers.add("KNOWN_FILE_CLAIM_MATCH");
    if (cross.collisions.length) blockers.add("KNOWN_FILE_COLLISION");
    if (cross.bindings.length || cross.uploads.length)
      blockers.add("PROTECTED_HASH_OR_OBJECT_MATCH");
    if (cross.references.length) blockers.add("EXISTING_OBJECT_REFERENCE");
  }
  if (observation.blockedByBatchDuplicate)
    blockers.add("DUPLICATE_CANDIDATE_IN_BATCH");
  const status = blockers.has("SKIP_ALREADY_PRIVATE")
    ? ("SKIPPED" as const)
    : blockers.size
      ? ("BLOCKED" as const)
      : ("NEEDS_ATTESTATION" as const);
  return {
    ...target,
    status,
    blockers: [...blockers],
    snapshot: { before, after },
    // Runtime candidates may carry etag: undefined (a correctly blocked row).
    // The private format is explicit plain JSON, including blocked observations.
    candidate: listed
      ? {
          listing: {
            candidateCount: listed.listing.candidateCount,
            unexpectedObjectCount: listed.listing.unexpectedObjectCount,
            truncated: listed.listing.truncated,
          },
          candidate: listed.candidate
            ? {
                key: listed.candidate.key,
                etag: listed.candidate.etag ?? null,
                size: listed.candidate.size,
              }
            : null,
          bytes: bytesValid(bytes, listed)
            ? {
                rawHash: bytes.rawHash,
                canonicalHash: bytes.canonicalHash,
                byteLength: bytes.byteLength,
                mimeType: bytes.mimeType,
              }
            : null,
        }
      : null,
    crossReferences: cross,
    proposal:
      status === "NEEDS_ATTESTATION"
        ? {
            field: "slipImageUrl" as const,
            before: before!.source.slipImageUrl,
            after: `r2p:${listed!.candidate!.key}`,
            referenceOnly: true,
            preserveAllOtherFields: true,
            updatedAtMayChangeAutomatically: true,
          }
        : null,
    mappingProvenance: "UNREVIEWED" as const,
    historicalByteIdentity: "UNPROVEN" as const,
    approval: null,
    writeAuthorized: false as const,
    pointInTimeOnly: true as const,
  };
}

export type RelinkPlanRow = ReturnType<typeof finishObservation>;

/** Exact ten targets, no general scans or remote writes; caller persists privately.
 * Missing historical hash is expected, never synthesized into source evidence.
 * Cooperative budget: a bounded in-flight DB/S3 operation may finish after it. */
export async function prepareLegacySlipRelinkPlan(
  readers: RelinkReaders,
  metadata: RelinkPlanMetadata,
  now: () => number = () => performance.now()
) {
  if (
    !/^[a-f0-9-]{36}$/.test(metadata.runId) ||
    !Number.isFinite(Date.parse(metadata.preparedAt)) ||
    !/^[a-f0-9]{40}$/.test(metadata.declaredCodeSha) ||
    !HEX64.test(metadata.toolSourceDigest) ||
    !HEX64.test(metadata.targetFingerprint)
  ) {
    throw new Error("INVALID_PLAN_METADATA");
  }
  const deadline = now() + DEADLINE_MS;
  const requireTime = () => {
    if (now() >= deadline) throw new AuditReadError("RUN_DEADLINE_EXCEEDED");
  };
  const observations: PrivateObservation[] = [];
  for (const target of PREVIEW_AUDIT_TARGETS) {
    const o: PrivateObservation = {
      target,
      before: null,
      after: null,
      listed: null,
      bytes: null,
      crossReferences: null,
      error: null,
      blockedByBatchDuplicate: false,
    };
    try {
      requireTime();
      o.before = await readers.readSource(target);
      if (sourceBlockers(o.before, target).length === 0) {
        requireTime();
        o.listed = await readers.listCandidate(target);
        if (candidateValid(target, o.listed)) {
          requireTime();
          o.bytes = await readers.readCandidate(o.listed!.candidate!);
          if (bytesValid(o.bytes, o.listed)) {
            requireTime();
            o.crossReferences = await readers.readCrossReferences({
              target,
              canonicalHash: o.bytes.canonicalHash,
              rawHash: o.bytes.rawHash,
              key: o.listed!.candidate!.key,
            });
          }
        }
        requireTime();
        // Last I/O for this row: fresh source/order/related read AFTER global lookups too.
        o.after = await readers.readSource(target);
      } else o.after = o.before;
    } catch (error) {
      o.error =
        error instanceof AuditReadError || error instanceof RelinkReadError
          ? error.code
          : "OPERATION_FAILED";
      if (o.before && now() < deadline) {
        try {
          o.after = await readers.readSource(target);
        } catch {
          o.error = "SOURCE_READ_FAILED";
        }
      }
    }
    observations.push(o);
  }
  // Defer all reports until every inspected body has participated in this check.
  for (let i = 0; i < observations.length; i++) {
    for (let j = i + 1; j < observations.length; j++) {
      const a = observations[i],
        b = observations[j];
      if (
        (a.bytes &&
          b.bytes &&
          (a.bytes.canonicalHash === b.bytes.canonicalHash ||
            a.bytes.rawHash === b.bytes.rawHash)) ||
        (a.listed?.candidate &&
          b.listed?.candidate &&
          a.listed.candidate.key === b.listed.candidate.key)
      ) {
        a.blockedByBatchDuplicate = b.blockedByBatchDuplicate = true;
      }
    }
  }
  return {
    schema: "legacy-slip-reference-review-plan/v1" as const,
    mode: "PREPARE_ONLY" as const,
    ...metadata,
    codeShaVerification: "OPERATOR_DECLARED_NOT_VERIFIED" as const,
    toolSourceDigestPurpose:
      "EXACT_LOCAL_SOURCE_FINGERPRINT_NOT_DEPLOYMENT_ATTESTATION" as const,
    targetScope: "PINNED_PREVIEW_TEN_LEGACY_RECORDS" as const,
    collisionCoverage:
      "KNOWN_REGISTRIES_OBJECT_REFERENCES_AND_THIS_BATCH_ONLY" as const,
    historicalCoverageComplete: false as const,
    snapshotTimestampSemantics:
      "DATABASE_SESSION_WALL_TIME_NOT_NORMALIZED_TO_UTC" as const,
    rows: observations.map(finishObservation),
    writeAuthorized: false as const,
    isApplyManifest: false as const,
    pointInTimeOnly: true as const,
    requiredNextAction:
      "HUMAN_MAPPING_REVIEW_THEN_SEPARATE_IMPLEMENTATION_AUTHORIZATION" as const,
  };
}

export type PrivateRelinkPlan = Awaited<
  ReturnType<typeof prepareLegacySlipRelinkPlan>
>;

/** Explicit public allowlist. Never spread a private row/snapshot/error. */
export function summarizeRelinkPlan(plan: PrivateRelinkPlan) {
  return {
    type: "summary",
    mode: "prepare-only",
    runId: plan.runId,
    targetCount: plan.rows.length,
    needsAttestation: plan.rows.filter(
      row => row.status === "NEEDS_ATTESTATION"
    ).length,
    blocked: plan.rows.filter(row => row.status === "BLOCKED").length,
    skipped: plan.rows.filter(row => row.status === "SKIPPED").length,
    rows: plan.rows.map(row => ({
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      status: row.status,
      blockers: row.blockers,
      mappingProvenance: "UNREVIEWED",
      historicalByteIdentity: "UNPROVEN",
      writeAuthorized: false,
    })),
    databaseWrites: 0,
    objectWrites: 0,
    writeAuthorized: false,
    isApplyManifest: false,
    pointInTimeOnly: true,
    historicalCoverageComplete: false,
    nextAction: "REVIEW_PRIVATE_MAPPING_NO_APPLY",
  };
}

export function relinkTargetFingerprint(
  config: LegacySlipAuditEnvironment
): string {
  // Explicit non-credential fields only. Neither key IDs nor secrets enter the artifact.
  return createHash("sha256")
    .update(
      JSON.stringify({
        dbHost: config.db.host,
        dbPort: config.db.port,
        database: config.db.database,
        r2Endpoint: config.r2.endpoint,
        bucket: config.r2.bucket,
      })
    )
    .digest("hex");
}

export function createRelinkReaders(
  config: LegacySlipAuditEnvironment
): RelinkReaders & { close(): void } {
  const { bucket, ...clientConfig } = config.r2;
  const client = new S3Client(clientConfig);
  return {
    ...createRelinkDatabaseReaders(config.db),
    ...createObjectReaders(client, bucket),
    close: () => client.destroy(),
  };
}
