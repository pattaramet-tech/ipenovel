/**
 * Admin resolution of a LEGACY REFERENCE CASE AMBIGUITY.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * Some pre-migration approvals kept only an upper-cased `reference`, so their
 * true casing is unrecoverable. A new submission whose reference folds to the
 * same value MIGHT be that transaction replayed - or might be a genuinely
 * different reference that merely folds together, because upper-casing is
 * lossy. Nothing automated can tell those apart, so auto-approval stops and
 * the decision comes here.
 *
 * Without this path the ambiguity is a dead end: normal Approve re-runs the
 * same check and fails forever, leaving a legitimate distinct payment
 * permanently unapprovable.
 *
 * ── Subject-agnostic ──────────────────────────────────────────────────────
 * Order payments AND wallet top-ups both reach the ambiguity branch, so both
 * need the escape route. An earlier revision implemented only the order path
 * while the wallet path still raised
 * LEGACY_CASE_AMBIGUITY_REQUIRES_RESOLUTION - pointing admins at a route that
 * did not exist, which is worse than the original dead end. The generic layer
 * below therefore hard-codes neither subject; each has a small adapter.
 *
 * ── What this is NOT ──────────────────────────────────────────────────────
 * NOT the generic break-glass for NO_STRONG_IDENTIFIER. It applies only to a
 * live, server-revalidated legacy case ambiguity, still requires a REAL
 * strong identifier, and still runs the normal atomic claim. It bypasses
 * exactly one thing: the advisory alias check a human has adjudicated. It can
 * never bypass DUPLICATE_REFERENCE, DUPLICATE_FILE, DUPLICATE_QR or
 * NO_STRONG_IDENTIFIER.
 */

import * as db from "../db";
import { TRPCError } from "@trpc/server";
import { paymentSlipReviewResolutions } from "../../drizzle/schema";
import {
  deriveStrongIdentifiersFromExtractedData,
  getRawReferenceForLegacyLookup,
  hasStrongIdentifier,
} from "./slipIdentifierService";
import { evaluateSlipConflict } from "./slipConflictEvaluator";
import * as orderService from "./orderService";

export type LegacyCaseSubjectType = "order_payment" | "wallet_topup";
export type LegacyCaseDecision = "confirmed_distinct" | "confirmed_duplicate";

export interface ResolveLegacyCaseInput {
  subjectType: LegacyCaseSubjectType;
  subjectId: number;
  adminUserId: number;
  adminLabel?: string;
  decision: LegacyCaseDecision;
  /** Mandatory, non-empty operator justification. */
  reason: string;
}

export interface ResolveLegacyCaseResult {
  subjectType: LegacyCaseSubjectType;
  subjectId: number;
  decision: LegacyCaseDecision;
  resolved: true;
  approved: boolean;
}

const MIN_REASON_LENGTH = 10;

/** Per-subject adapter. Keeps the generic layer free of subject specifics. */
interface SubjectAdapter {
  load(): Promise<{ status: string; extractedData: string | null } | undefined>;
  approveWithResolution(args: {
    adminUserId: number;
    adminLabel?: string;
    auditResolution: (tx: any) => Promise<void>;
  }): Promise<void>;
  /**
   * Rejects the subject and writes the resolution record in ONE transaction.
   *
   * `auditResolution` is invoked only AFTER a CONDITIONAL rejection has been
   * confirmed to have won the race, and inside the same transaction - so the
   * record can never outlive a rejection that did not happen.
   */
  rejectWithResolution(args: {
    adminUserId: number;
    reason: string;
    auditResolution: (tx: any) => Promise<void>;
  }): Promise<void>;
}

function adapterFor(input: ResolveLegacyCaseInput): SubjectAdapter {
  if (input.subjectType === "order_payment") {
    return {
      async load() {
        const payment = await db.getPaymentById(input.subjectId);
        if (!payment) return undefined;
        return {
          status: payment.status as string,
          extractedData: (payment.extractedData as string | null) ?? null,
        };
      },
      async approveWithResolution({ adminUserId, adminLabel, auditResolution }) {
        await orderService.approvePayment(input.subjectId, String(adminUserId), adminLabel, undefined, {
          legacyCaseAmbiguityResolved: true,
          auditResolution,
        });
      },
      async rejectWithResolution({ adminUserId, reason, auditResolution }) {
        const database = await requireDb();
        await database.transaction(async (tx: any) => {
          // 1. Reload INSIDE the transaction - never trust the pre-check.
          const payment = await db.getPaymentById(input.subjectId, tx);
          if (!payment) {
            throw new TRPCError({ code: "NOT_FOUND", message: "Payment not found" });
          }

          // 2. Still reviewable?
          if (!isReviewable(payment.status as string)) {
            throw new TRPCError({
              code: "CONFLICT",
              message: `This payment is already ${payment.status}. Refresh to see the current decision.`,
            });
          }

          // 3. The conditional rejection is the ARBITER of the race. Losing
          //    it rolls the resolution record back with everything else.
          const won = await db.rejectPaymentIfReviewable(
            input.subjectId,
            adminUserId,
            reason,
            tx
          );
          if (!won) {
            throw new TRPCError({
              code: "CONFLICT",
              message:
                "This payment was finalized by another action while you were deciding. " +
                "Nothing was changed - refresh to see the current state.",
            });
          }

          // 4. Reuse the existing rejection flow for its side effects (order
          //    status, order history, approval metadata) rather than
          //    inventing a second one - inside THIS transaction.
          await orderService.rejectPayment(input.subjectId, String(adminUserId), reason, tx);

          // 5. Audit last, same transaction.
          await auditResolution(tx);
        });
      },
    };
  }

  return {
    async load() {
      const topup = await db.getWalletTopupById(input.subjectId);
      if (!topup) return undefined;
      return {
        status: topup.status as string,
        extractedData: (topup.extractedData as string | null) ?? null,
      };
    },
    async approveWithResolution({ adminUserId, auditResolution }) {
      await db.approveWalletTopup(input.subjectId, adminUserId, {
        legacyCaseAmbiguityResolved: true,
        auditResolution,
      });
    },
    async rejectWithResolution({ adminUserId, reason, auditResolution }) {
      // rejectWalletTopup already reloads inside its own transaction and
      // rejects CONDITIONALLY, throwing when it loses the race. The audit
      // callback runs inside that same transaction, after the win.
      await db.rejectWalletTopup(input.subjectId, adminUserId, reason, {
        auditResolution,
      });
    },
  };
}

/** Statuses from which a subject may still be resolved. */
function isReviewable(status: string): boolean {
  return status === "pending" || status === "pending_review";
}

/**
 * Re-derives the live ambiguity SERVER-SIDE.
 *
 * Never trusts the admin's browser: the panel may have been open a long time
 * and the matching claim could have changed. Everything is read from
 * persisted state at decision time.
 */
export async function describeLegacyCaseAmbiguity(
  subjectType: LegacyCaseSubjectType,
  subjectId: number,
  extractedData: string | null,
  tx?: any
): Promise<
  | {
      present: true;
      legacyAliasHash?: string;
      matchedSourceType: LegacyCaseSubjectType;
      matchedSourceId: number;
    }
  | { present: false }
> {
  if (!extractedData) return { present: false };

  const { identifiers } = deriveStrongIdentifiersFromExtractedData(extractedData);
  const rawReference = getRawReferenceForLegacyLookup(extractedData);
  if (!rawReference) return { present: false };

  const database = tx ?? (await db.getDb());
  if (!database) return { present: false };

  const conflict = await evaluateSlipConflict(
    { identifiers, rawReference, sourceType: subjectType, sourceId: subjectId },
    database
  );

  if (conflict.kind !== "legacy_case_ambiguity") return { present: false };

  return {
    present: true,
    legacyAliasHash: conflict.legacyAliasHash,
    matchedSourceType: conflict.matchedSourceType,
    matchedSourceId: conflict.matchedSourceId,
  };
}

export async function resolveLegacyCaseAmbiguity(
  input: ResolveLegacyCaseInput
): Promise<ResolveLegacyCaseResult> {
  const reason = (input.reason ?? "").trim();
  if (reason.length < MIN_REASON_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `A written justification of at least ${MIN_REASON_LENGTH} characters is required. ` +
        `This decision overrides an automated anti-replay signal and is permanently audited.`,
    });
  }

  const adapter = adapterFor(input);
  const subject = await adapter.load();
  if (!subject) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Subject not found" });
  }

  if (!isReviewable(subject.status)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `This record is already ${subject.status}. There is nothing to resolve.`,
    });
  }

  // Revalidate the ambiguity SERVER-SIDE. If it has gone away, the normal
  // Approve/Reject actions are the right tools and this override must not be
  // used as a shortcut around them.
  const ambiguity = await describeLegacyCaseAmbiguity(
    input.subjectType,
    input.subjectId,
    subject.extractedData
  );
  if (!ambiguity.present) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "No legacy case ambiguity is currently present for this record. Use the normal " +
        "Approve or Reject action instead.",
    });
  }

  if (input.decision === "confirmed_duplicate") {
    // The RECORD AND THE REJECTION COMMIT TOGETHER.
    //
    // Writing the record first meant a rejection that then lost a status
    // race or failed transiently left the subject reviewable while the
    // subject-unique row was permanently committed - so retrying returned
    // CONFLICT and the record was stuck exactly as before. The audit is now
    // a callback invoked inside the rejection transaction, after the
    // conditional rejection has been confirmed to have won.
    await adapter.rejectWithResolution({
      adminUserId: input.adminUserId,
      reason: `Legacy reference case ambiguity confirmed as duplicate: ${reason}`,
      auditResolution: async (tx: any) => {
        // Revalidate against state visible INSIDE the transaction: a fold
        // adjudicated on a stale read must not produce a record.
        const live = await describeLegacyCaseAmbiguity(
          input.subjectType,
          input.subjectId,
          subject.extractedData,
          tx
        );
        if (!live.present) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "No legacy case ambiguity is currently present for this record. Use the normal " +
              "Approve or Reject action instead.",
          });
        }

        await insertResolution(tx, {
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          resolutionType: "legacy_case_confirmed_duplicate",
          ambiguity: live,
          adminUserId: input.adminUserId,
          reason,
        });
      },
    });

    return {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      decision: input.decision,
      resolved: true,
      approved: false,
    };
  }

  // confirmed_distinct still requires a REAL identifier - this is not a route
  // around NO_STRONG_IDENTIFIER.
  const { identifiers } = deriveStrongIdentifiersFromExtractedData(subject.extractedData);
  if (!hasStrongIdentifier(identifiers)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "NO_STRONG_IDENTIFIER: this record has no transaction reference and no readable " +
        "slip file, so it cannot be protected against replay even after resolving the " +
        "case ambiguity. Run Recheck OCR first.",
    });
  }

  // The audit is written INSIDE the approval transaction, after the exact
  // atomic claim and the financial finalization. If any of that fails, the
  // resolution row rolls back with it - so a failed attempt never consumes
  // the subject-unique slot and the admin can retry.
  await adapter.approveWithResolution({
    adminUserId: input.adminUserId,
    adminLabel: input.adminLabel,
    auditResolution: async (tx: any) => {
      await insertResolution(tx, {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        resolutionType: "legacy_case_confirmed_distinct",
        ambiguity,
        adminUserId: input.adminUserId,
        reason,
      });
    },
  });

  return {
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    decision: input.decision,
    resolved: true,
    approved: true,
  };
}

async function requireDb(): Promise<any> {
  const database = await db.getDb();
  if (!database) throw new Error("Database not available");
  return database;
}

async function insertResolution(
  executor: any,
  args: {
    subjectType: LegacyCaseSubjectType;
    subjectId: number;
    resolutionType: "legacy_case_confirmed_distinct" | "legacy_case_confirmed_duplicate";
    ambiguity: { legacyAliasHash?: string; matchedSourceType: LegacyCaseSubjectType; matchedSourceId: number };
    adminUserId: number;
    reason: string;
  }
): Promise<void> {
  try {
    await executor.insert(paymentSlipReviewResolutions).values({
      subjectType: args.subjectType,
      subjectId: args.subjectId,
      resolutionType: args.resolutionType,
      matchedSourceType: args.ambiguity.matchedSourceType,
      matchedSourceId: args.ambiguity.matchedSourceId,
      legacyAliasHash: args.ambiguity.legacyAliasHash ?? null,
      adminUserId: args.adminUserId,
      reason: args.reason,
    });
  } catch (error) {
    const duplicate =
      (error as any)?.code === "ER_DUP_ENTRY" || (error as any)?.errno === 1062;
    if (duplicate) {
      // The subject-level unique index did its job: two concurrent
      // resolutions of the SAME subject cannot both commit. Because the
      // insert runs inside the approval transaction, the loser's claim and
      // finalization roll back with it.
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "This record has already been resolved by another admin. Refresh to see the " +
          "current decision.",
      });
    }
    throw error;
  }
}
