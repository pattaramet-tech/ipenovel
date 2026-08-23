/**
 * Admin resolution of a LEGACY REFERENCE CASE AMBIGUITY.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * Some pre-migration approvals kept only an upper-cased `reference`, so their
 * true casing is unrecoverable. A new submission whose reference folds to the
 * same value MIGHT be that same transaction replayed - or might be a
 * genuinely different reference that merely folds together, because
 * upper-casing is lossy.
 *
 * Nothing automated can tell those apart. So auto-approval stops and the
 * decision comes here. Without this path the ambiguity was a dead end: normal
 * Approve re-ran the same check and failed forever, leaving a legitimate
 * distinct payment permanently unapprovable.
 *
 * ── What this is NOT ──────────────────────────────────────────────────────
 * NOT the generic break-glass override for NO_STRONG_IDENTIFIER. It applies
 * only to a live, server-revalidated legacy case ambiguity, and it still
 * requires a REAL strong identifier and still runs the normal atomic claim.
 * It bypasses exactly one thing: the advisory alias check a human has now
 * adjudicated.
 */

import * as db from "../db";
import { TRPCError } from "@trpc/server";
import { paymentSlipReviewResolutions } from "../../drizzle/schema";
import {
  deriveStrongIdentifiersFromExtractedData,
  getRawReferenceForLegacyLookup,
  hasStrongIdentifier,
  hashSlipReference,
} from "./slipIdentifierService";
import { findClaimByLegacyAlias } from "./slipClaimService";
import * as orderService from "./orderService";

export type LegacyCaseDecision = "confirmed_distinct" | "confirmed_duplicate";

export interface ResolveLegacyCaseInput {
  paymentId: number;
  adminUserId: number;
  adminLabel?: string;
  decision: LegacyCaseDecision;
  /** Mandatory, non-empty operator justification. */
  reason: string;
}

export interface ResolveLegacyCaseResult {
  paymentId: number;
  decision: LegacyCaseDecision;
  resolved: true;
  /** Present when the decision approved the payment. */
  approved?: boolean;
}

const MIN_REASON_LENGTH = 10;

/**
 * Re-derives the live ambiguity server-side.
 *
 * Never trusts the admin's browser: the panel may have been open for a long
 * time, and the matching claim could have changed. Everything below is read
 * from persisted state at decision time.
 */
export async function describeLegacyCaseAmbiguity(
  paymentId: number,
  tx?: any
): Promise<
  | {
      present: true;
      legacyAliasHash: string;
      matchedSourceType: "order_payment" | "wallet_topup";
      matchedSourceId: number;
    }
  | { present: false }
> {
  const payment = await db.getPaymentById(paymentId, tx);
  if (!payment?.extractedData) return { present: false };

  const rawReference = getRawReferenceForLegacyLookup(payment.extractedData as string);
  if (!rawReference) return { present: false };

  const legacyAliasHash = hashSlipReference(rawReference.toUpperCase());
  if (!legacyAliasHash) return { present: false };

  const database = tx ?? (await db.getDb());
  if (!database) return { present: false };

  const match = await findClaimByLegacyAlias(
    legacyAliasHash,
    { sourceType: "order_payment", sourceId: paymentId },
    database
  );
  if (!match) return { present: false };

  return {
    present: true,
    legacyAliasHash,
    matchedSourceType: match.sourceType,
    matchedSourceId: match.sourceId,
  };
}

/**
 * Records an admin decision on a legacy case ambiguity.
 *
 * `confirmed_duplicate` routes to the existing reject flow - no new rejection
 * mechanism is invented here.
 *
 * `confirmed_distinct` approves, but only through the NORMAL atomic claim:
 * the exact referenceHash / fileHash / qrPayloadHash are still claimed inside
 * the financial transaction, so if the real reference or file was taken in the
 * meantime this fails exactly like any other approval. The lossy alias itself
 * is never claimed - many legitimate payments may share one.
 */
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

  const payment = await db.getPaymentById(input.paymentId);
  if (!payment) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Payment not found" });
  }

  if (payment.status === "approved" || payment.status === "rejected") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `This payment is already ${payment.status}. There is nothing to resolve.`,
    });
  }

  // Revalidate the ambiguity SERVER-SIDE. If it has gone away (for example the
  // matching claim was removed), the normal Approve path is the right tool and
  // this override must not be used.
  const ambiguity = await describeLegacyCaseAmbiguity(input.paymentId);
  if (!ambiguity.present) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "No legacy case ambiguity is currently present for this payment. Use the normal " +
        "Approve or Reject action instead.",
    });
  }

  // A distinct-transaction approval still requires a REAL identifier - this is
  // not a route around NO_STRONG_IDENTIFIER.
  const { identifiers } = deriveStrongIdentifiersFromExtractedData(
    payment.extractedData as string | null
  );
  if (input.decision === "confirmed_distinct" && !hasStrongIdentifier(identifiers)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "NO_STRONG_IDENTIFIER: this payment has no transaction reference and no readable " +
        "slip file, so it cannot be protected against replay even after resolving the case " +
        "ambiguity. Run Recheck OCR first.",
    });
  }

  if (input.decision === "confirmed_duplicate") {
    await recordResolution({
      subjectId: input.paymentId,
      resolutionType: "legacy_case_confirmed_duplicate",
      ambiguity,
      adminUserId: input.adminUserId,
      reason,
    });

    // Reuse the existing reject flow rather than inventing a second one.
    await orderService.rejectPayment(
      input.paymentId,
      String(input.adminUserId),
      `Legacy reference case ambiguity confirmed as duplicate: ${reason}`
    );

    return { paymentId: input.paymentId, decision: input.decision, resolved: true, approved: false };
  }

  // confirmed_distinct: audit FIRST, so the override is recorded even if the
  // approval then loses a race on a real identifier. The unique index on the
  // subject makes a second attempt fail rather than double-recording.
  await recordResolution({
    subjectId: input.paymentId,
    resolutionType: "legacy_case_confirmed_distinct",
    ambiguity,
    adminUserId: input.adminUserId,
    reason,
  });

  // Approve through the normal path, passing the resolution so the advisory
  // alias check is skipped - and ONLY that check. Every exact UNIQUE
  // identifier is still claimed atomically inside the financial transaction.
  await orderService.approvePayment(
    input.paymentId,
    String(input.adminUserId),
    input.adminLabel || "Admin",
    undefined,
    { legacyCaseAmbiguityResolved: true }
  );

  return { paymentId: input.paymentId, decision: input.decision, resolved: true, approved: true };
}

async function recordResolution(args: {
  subjectId: number;
  resolutionType: "legacy_case_confirmed_distinct" | "legacy_case_confirmed_duplicate";
  ambiguity: { legacyAliasHash: string; matchedSourceType: "order_payment" | "wallet_topup"; matchedSourceId: number };
  adminUserId: number;
  reason: string;
}): Promise<void> {
  const database = await db.getDb();
  if (!database) throw new Error("Database not available");

  try {
    await database.insert(paymentSlipReviewResolutions).values({
      subjectType: "order_payment",
      subjectId: args.subjectId,
      resolutionType: args.resolutionType,
      matchedSourceType: args.ambiguity.matchedSourceType,
      matchedSourceId: args.ambiguity.matchedSourceId,
      legacyAliasHash: args.ambiguity.legacyAliasHash,
      adminUserId: args.adminUserId,
      reason: args.reason,
    });
  } catch (error) {
    const duplicate =
      (error as any)?.code === "ER_DUP_ENTRY" || (error as any)?.errno === 1062;
    if (duplicate) {
      // The subject-level unique index did its job: two concurrent resolution
      // attempts for the SAME payment cannot both proceed.
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "This payment has already been resolved by another admin. Refresh to see the " +
          "current decision.",
      });
    }
    throw error;
  }
}
