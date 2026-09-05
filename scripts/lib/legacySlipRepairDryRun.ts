import type { RelinkReaders } from "./legacySlipRelinkPlan";
import {
  validateRepairIntent,
  validateOperatorAttestation,
  canonicalRepairJson,
  type RepairIntent,
  type OperatorAttestation,
} from "./legacySlipRepairContract";

export type RepairDryRunCode =
  | "MATCHES_REVIEWED_PLAN"
  | "TARGET_FINGERPRINT_MISMATCH"
  | "SOURCE_DRIFT"
  | "OBJECT_DRIFT"
  | "CROSS_REFERENCE_CONFLICT"
  | "READ_INCOMPLETE"
  | "READ_FAILED"
  | "DEADLINE_EXCEEDED";

/** Read-only readiness check, NOT authorization or a token reusable by a writer.
 * All DB/R2 I/O remains outside transactions. Rechecks only the single source;
 * global indexed/reference SELECTs do not read any other source's object bytes. */
export async function dryRunLegacySlipRepair(
  rawIntent: RepairIntent,
  rawAttestation: OperatorAttestation,
  readers: RelinkReaders,
  options: { targetFingerprint: string; now?: () => number }
) {
  const intent = validateRepairIntent(rawIntent);
  validateOperatorAttestation(rawAttestation, intent);
  const now = options.now ?? (() => performance.now());
  const started = now();
  const checkTime = () => {
    const elapsed = now() - started;
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 60_000)
      throw new Error("DEADLINE_EXCEEDED");
  };
  let code: RepairDryRunCode = "MATCHES_REVIEWED_PLAN";
  try {
    if (options.targetFingerprint !== intent.targetFingerprint)
      code = "TARGET_FINGERPRINT_MISMATCH";
    else {
      checkTime();
      const before = await readers.readSource({
        sourceType: "order_payment",
        sourceId: 11280001,
      });
      checkTime();
      if (canonicalRepairJson(before) !== canonicalRepairJson(intent.before))
        code = "SOURCE_DRIFT";
      else {
        const listed = await readers.listCandidate({
          sourceType: "order_payment",
          sourceId: 11280001,
        });
        checkTime();
        const c = intent.candidate;
        if (
          listed.listing.truncated ||
          listed.listing.unexpectedObjectCount !== 0 ||
          listed.listing.candidateCount !== 1 ||
          !listed.candidate ||
          listed.candidate.key !== c.key ||
          listed.candidate.etag !== c.etag ||
          listed.candidate.size !== c.size
        )
          code = "OBJECT_DRIFT";
        else {
          const bytes = await readers.readCandidate(listed.candidate);
          checkTime();
          if (
            bytes.rawHash !== c.rawHash ||
            bytes.canonicalHash !== c.canonicalHash ||
            bytes.byteLength !== c.size ||
            bytes.mimeType !== c.mimeType
          )
            code = "OBJECT_DRIFT";
          else {
            const cross = await readers.readCrossReferences({
              target: { sourceType: "order_payment", sourceId: 11280001 },
              key: c.key,
              rawHash: c.rawHash,
              canonicalHash: c.canonicalHash,
            });
            checkTime();
            if (cross.truncated) code = "READ_INCOMPLETE";
            else if (
              [
                cross.claims,
                cross.bindings,
                cross.uploads,
                cross.collisions,
                cross.references,
              ].some(rows => rows.length !== 0)
            )
              code = "CROSS_REFERENCE_CONFLICT";
            // Last network operation: recheck the full source/order/related state.
            const after = await readers.readSource({
              sourceType: "order_payment",
              sourceId: 11280001,
            });
            checkTime();
            if (
              canonicalRepairJson(after) !== canonicalRepairJson(intent.before)
            )
              code = "SOURCE_DRIFT";
          }
        }
      }
    }
  } catch (error) {
    code =
      error instanceof Error && error.message === "DEADLINE_EXCEEDED"
        ? "DEADLINE_EXCEEDED"
        : "READ_FAILED";
  }
  return {
    type: "summary",
    mode: "repair-dry-run",
    sourceType: "order_payment",
    sourceId: 11280001,
    status: code === "MATCHES_REVIEWED_PLAN" ? "DRY_RUN_MATCH" : "BLOCKED",
    code,
    databaseWrites: 0,
    objectWrites: 0,
    writeAuthorized: false,
    liveApplyAvailable: false,
    independentReview: "PENDING",
    historicalByteIdentity: "UNPROVEN",
    historicalCoverageComplete: false,
    pointInTimeOnly: true,
    nextAction: "INDEPENDENT_MAPPING_REVIEW_AND_SEPARATE_LIVE_AUTHORIZATION",
  } as const;
}
