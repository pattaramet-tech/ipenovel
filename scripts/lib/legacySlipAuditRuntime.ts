import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  type ListObjectsV2CommandOutput,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import {
  inspectLegacySlipBytes,
  LegacySlipAuditBytesError,
  LEGACY_SLIP_AUDIT_MAX_BYTES,
} from "../../server/helpers/legacySlipAuditBytes";
import {
  buildLegacySlipReconciliationPlan,
  isAuditTrustedLegacyReference,
  type AuditSource,
  type CandidateBytes,
  type CandidateListing,
  type SourceType,
} from "../../server/helpers/legacySlipReconciliationPlan";
import {
  PREVIEW_AUDIT_TARGETS,
  type LegacySlipAuditEnvironment,
} from "./legacySlipAuditOptions";

export type AuditTarget = Readonly<{
  sourceType: SourceType;
  sourceId: number;
}>;
export type AuditReport = ReturnType<typeof buildLegacySlipReconciliationPlan>;
const RELATED_LIMIT = 20;
const LIST_LIMIT = 20;
const IO_TIMEOUT_MS = 10_000;
const RUN_BUDGET_MS = 180_000;

/** Internal only: never serialize this value or the connection configuration. */
export interface ListedCandidate {
  key: string;
  etag: string | undefined;
  size: number;
}
export interface ListedCandidates {
  listing: CandidateListing;
  candidate?: ListedCandidate;
}
export class AuditReadError extends Error {
  constructor(readonly code: string) {
    super("LEGACY_SLIP_AUDIT_READ_FAILED");
  }
}
export interface AuditReaders {
  readSource(target: AuditTarget): Promise<AuditSource | null>;
  listCandidate(target: AuditTarget): Promise<ListedCandidates>;
  readCandidate(candidate: ListedCandidate): Promise<CandidateBytes>;
}

function allowedTarget(target: AuditTarget): boolean {
  return PREVIEW_AUDIT_TARGETS.some(
    t => t.sourceType === target.sourceType && t.sourceId === target.sourceId
  );
}
function requireTarget(target: AuditTarget): void {
  if (!allowedTarget(target)) throw new AuditReadError("SOURCE_READ_FAILED");
}
function safeInteger(value: unknown): number | null {
  if (typeof value === "string" && !/^(0|[1-9][0-9]*)$/.test(value))
    return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
function requiredId(value: unknown): number {
  const parsed = safeInteger(value);
  if (parsed === null || parsed === 0)
    throw new AuditReadError("SOURCE_READ_FAILED");
  return parsed;
}
function nullableText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new AuditReadError("SOURCE_READ_FAILED");
  return value;
}

/** Only SELECTs, no open transaction, fresh connection for EACH snapshot.
 * Connection is destroyed before any object-store I/O can start. */
export function createSourceReader(
  config: LegacySlipAuditEnvironment["db"],
  connect: (
    config: LegacySlipAuditEnvironment["db"]
  ) => Promise<Connection> = mysql.createConnection
): AuditReaders["readSource"] {
  return async target => {
    requireTarget(target);
    let connection: Connection | undefined;
    try {
      connection = await connect(config);
      const query = async (sql: string, values: unknown[]) => {
        const [rows] = await connection!.query<RowDataPacket[]>({
          sql,
          values,
          timeout: 5_000,
        });
        return rows;
      };
      const [row] = await query(
        target.sourceType === "order_payment"
          ? `SELECT p.id, o.userId AS ownerUserId, p.status, p.slipImageUrl,
             p.slipEvidenceClass, p.evidenceVersion, p.slipEvidenceId,
             p.extractedEvidenceVersion, p.extractedData
           FROM payments p LEFT JOIN orders o ON o.id = p.orderId WHERE p.id = ? LIMIT 1`
          : `SELECT id, userId AS ownerUserId, status, slipImageUrl,
             slipEvidenceClass, evidenceVersion, slipEvidenceId,
             extractedEvidenceVersion, extractedData
           FROM walletTopups WHERE id = ? LIMIT 1`,
        [target.sourceId]
      );
      if (!row) return null;
      if (requiredId(row.id) !== target.sourceId)
        throw new AuditReadError("SOURCE_READ_FAILED");
      const bindings = await query(
        `SELECT id FROM slipEvidenceBindings WHERE sourceType = ? AND sourceId = ? ORDER BY id LIMIT 21`,
        [target.sourceType, target.sourceId]
      );
      const claims = await query(
        `SELECT id, userId, fileHash FROM paymentSlipClaims WHERE sourceType = ? AND sourceId = ? ORDER BY id LIMIT 21`,
        [target.sourceType, target.sourceId]
      );
      if (
        typeof row.status !== "string" ||
        typeof row.slipEvidenceClass !== "string"
      ) {
        throw new AuditReadError("SOURCE_READ_FAILED");
      }
      // Invalid non-null versions/bindings fail rather than looking absent.
      for (const field of [
        "evidenceVersion",
        "slipEvidenceId",
        "extractedEvidenceVersion",
      ] as const) {
        if (row[field] !== null && safeInteger(row[field]) === null)
          throw new AuditReadError("SOURCE_READ_FAILED");
      }
      return {
        ...target,
        ownerUserId: safeInteger(row.ownerUserId),
        status: row.status,
        slipImageUrl: nullableText(row.slipImageUrl),
        slipEvidenceClass: row.slipEvidenceClass,
        evidenceVersion: safeInteger(row.evidenceVersion),
        slipEvidenceId: safeInteger(row.slipEvidenceId),
        extractedEvidenceVersion: safeInteger(row.extractedEvidenceVersion),
        extractedData: nullableText(row.extractedData),
        bindings: bindings.map(b => ({ id: requiredId(b.id) })),
        claims: claims.map(c => ({
          id: requiredId(c.id),
          userId: requiredId(c.userId),
          fileHash: nullableText(c.fileHash),
        })),
        relatedReadTruncated:
          bindings.length > RELATED_LIMIT || claims.length > RELATED_LIMIT,
      };
    } catch {
      throw new AuditReadError("SOURCE_READ_FAILED");
    } finally {
      try {
        connection?.destroy();
      } catch {
        throw new AuditReadError("SOURCE_READ_FAILED");
      }
    }
  };
}

function targetPrefix(target: AuditTarget): string {
  requireTarget(target);
  const folder =
    target.sourceType === "order_payment" ? "payments" : "wallet-topups";
  return `payment-slips/legacy/${folder}/${target.sourceId}/`;
}

/** Never paginate or search by filename alone; incomplete listings block. */
export function classifyCandidateListing(
  target: AuditTarget,
  result: ListObjectsV2CommandOutput
): ListedCandidates {
  const prefix = targetPrefix(target);
  if (
    !result ||
    typeof result.IsTruncated !== "boolean" ||
    (result.Contents !== undefined && !Array.isArray(result.Contents))
  ) {
    throw new AuditReadError("INVALID_OBJECT_LISTING");
  }
  const contents = result.Contents ?? [];
  const candidates: ListedCandidate[] = [];
  let unexpectedObjectCount = 0;
  for (const object of contents) {
    if (!object || typeof object !== "object")
      throw new AuditReadError("INVALID_OBJECT_LISTING");
    if (object.Key === prefix && object.Size === 0) continue; // Directory marker only.
    if (
      typeof object.Key !== "string" ||
      !object.Key.startsWith(prefix) ||
      !/^\d+-[a-z0-9]+\.(jpg|png|pdf)$/.test(object.Key.slice(prefix.length)) ||
      !Number.isSafeInteger(object.Size) ||
      object.Size! <= 0
    ) {
      unexpectedObjectCount++;
      continue;
    }
    candidates.push({ key: object.Key, etag: object.ETag, size: object.Size! });
  }
  const listing = {
    candidateCount: candidates.length,
    unexpectedObjectCount,
    truncated: result.IsTruncated || contents.length > LIST_LIMIT,
  };
  return {
    listing,
    ...(candidates.length === 1 &&
    unexpectedObjectCount === 0 &&
    !listing.truncated
      ? { candidate: candidates[0] }
      : {}),
  };
}

type S3ReadClient = Pick<S3Client, "send">;
function destroyBody(body: unknown): void {
  try {
    (body as { destroy?: () => void } | undefined)?.destroy?.();
  } catch {
    /* Fixed error output only. */
  }
}

/** Race read-only I/O as well as aborting it; observe late failures/results. */
function abortableRead<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  lateCleanup?: (value: T) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const onAbort = () => {
      timedOut = true;
      signal.removeEventListener("abort", onAbort);
      reject(new AuditReadError("OBJECT_READ_TIMEOUT"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        if (timedOut) lateCleanup?.(value);
        else resolve(value);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        if (!timedOut) reject(new AuditReadError("CANDIDATE_READ_FAILED"));
      }
    );
  });
}

export function createObjectReaders(
  client: S3ReadClient,
  bucket: string
): Pick<AuditReaders, "listCandidate" | "readCandidate"> {
  return {
    async listCandidate(target) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), IO_TIMEOUT_MS);
      try {
        const result = (await abortableRead(
          client.send(
            new ListObjectsV2Command({
              Bucket: bucket,
              Prefix: targetPrefix(target),
              MaxKeys: LIST_LIMIT,
            }),
            { abortSignal: controller.signal }
          ),
          controller.signal
        )) as ListObjectsV2CommandOutput;
        return classifyCandidateListing(target, result);
      } catch (error) {
        if (controller.signal.aborted)
          throw new AuditReadError("OBJECT_READ_TIMEOUT");
        if (
          error instanceof AuditReadError &&
          error.code === "INVALID_OBJECT_LISTING"
        )
          throw error;
        throw new AuditReadError("CANDIDATE_LIST_FAILED");
      } finally {
        clearTimeout(timer);
      }
    },
    async readCandidate(candidate) {
      // An ETag is used ONLY for conditional access, never as a file digest.
      if (!candidate.etag || !/^"[A-Za-z0-9._-]+"$/.test(candidate.etag)) {
        throw new AuditReadError("OBJECT_VERSION_UNAVAILABLE");
      }
      if (candidate.size > LEGACY_SLIP_AUDIT_MAX_BYTES)
        throw new AuditReadError("OBJECT_TOO_LARGE");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), IO_TIMEOUT_MS);
      let result: GetObjectCommandOutput | undefined;
      try {
        const request = client
          .send(
            new GetObjectCommand({
              Bucket: bucket,
              Key: candidate.key,
              IfMatch: candidate.etag,
            }),
            { abortSignal: controller.signal }
          )
          .catch(error => {
            if (error?.$metadata?.httpStatusCode === 412)
              throw new AuditReadError("OBJECT_VERSION_CHANGED");
            throw new AuditReadError("CANDIDATE_READ_FAILED");
          });
        // Retain only fixed error codes when abortableRead observes rejection.
        const outcome = await abortableRead(
          request.then(
            value => ({ ok: true as const, value }),
            error => ({ ok: false as const, error })
          ),
          controller.signal,
          late => {
            if (late.ok) destroyBody(late.value.Body);
          }
        );
        if (!outcome.ok) throw outcome.error;
        result = outcome.value;
        if (
          result.ETag !== candidate.etag ||
          result.ContentLength !== candidate.size
        ) {
          throw new AuditReadError("OBJECT_VERSION_CHANGED");
        }
        const bytes = await inspectLegacySlipBytes(result.Body, {
          signal: controller.signal,
        });
        if (bytes.byteLength !== candidate.size)
          throw new AuditReadError("OBJECT_VERSION_CHANGED");
        return bytes;
      } catch (error) {
        destroyBody(result?.Body);
        if (controller.signal.aborted)
          throw new AuditReadError("OBJECT_READ_TIMEOUT");
        if (error instanceof AuditReadError) throw error;
        if (error instanceof LegacySlipAuditBytesError) {
          const codes: Record<string, string> = {
            ABORTED: "OBJECT_READ_TIMEOUT",
            TOO_LARGE: "OBJECT_TOO_LARGE",
            UNSUPPORTED_SIGNATURE: "UNSUPPORTED_FILE_TYPE",
            EMPTY_BODY: "EMPTY_OBJECT",
          };
          throw new AuditReadError(codes[error.code] ?? "INVALID_OBJECT_BODY");
        }
        throw new AuditReadError("CANDIDATE_READ_FAILED");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Strict allowlist, sequential, at most one object body per target. No writes. */
export async function auditPreviewLegacySlips(
  readers: AuditReaders,
  emit: (report: AuditReport) => void,
  now: () => number = () => performance.now()
): Promise<AuditReport[]> {
  const deadline = now() + RUN_BUDGET_MS;
  const reports: AuditReport[] = [];
  for (const target of PREVIEW_AUDIT_TARGETS) {
    let before: AuditSource | null = null;
    let after: AuditSource | null = null;
    let listing: CandidateListing | null = null;
    let bytes: CandidateBytes | null = null;
    let operationalError: string | undefined;
    try {
      if (now() >= deadline) throw new AuditReadError("RUN_DEADLINE_EXCEEDED");
      before = await readers.readSource(target);
      const canInspect =
        before &&
        before.status === "approved" &&
        before.slipEvidenceClass === "legacy_compatibility_required" &&
        before.slipEvidenceId === null &&
        before.bindings.length === 0 &&
        !before.relatedReadTruncated &&
        isAuditTrustedLegacyReference(before.slipImageUrl);
      if (canInspect) {
        if (now() >= deadline)
          throw new AuditReadError("RUN_DEADLINE_EXCEEDED");
        const listed = await readers.listCandidate(target);
        listing = listed.listing;
        if (listed.candidate) {
          if (now() >= deadline)
            throw new AuditReadError("RUN_DEADLINE_EXCEEDED");
          bytes = await readers.readCandidate(listed.candidate);
        }
        // New connection/current reads, not a snapshot held across the GET.
        after = await readers.readSource(target);
      } else {
        after = before; // Skipped/blocked; no external I/O or identity assertion.
      }
    } catch (error) {
      operationalError =
        error instanceof AuditReadError ? error.code : "OPERATION_FAILED";
      if (before && now() < deadline) {
        try {
          after = await readers.readSource(target);
        } catch {
          operationalError = "SOURCE_READ_FAILED";
        }
      }
    }
    const report = buildLegacySlipReconciliationPlan({
      ...target,
      before,
      after,
      listing,
      bytes,
      operationalError,
    });
    reports.push(report);
    emit(report);
  }
  return reports;
}

export function createPreviewAuditReaders(
  config: LegacySlipAuditEnvironment
): AuditReaders & { close(): void } {
  const { bucket, ...clientConfig } = config.r2;
  const client = new S3Client(clientConfig);
  return {
    readSource: createSourceReader(config.db),
    ...createObjectReaders(client, bucket),
    close: () => client.destroy(),
  };
}
