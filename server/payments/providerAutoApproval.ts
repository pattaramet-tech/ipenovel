import { eq } from "drizzle-orm";
import { payments, walletTopups, orders } from "../../drizzle/schema";
import * as db from "../db";
import { approvePayment } from "../services/orderService";
import { readAutoPolicy } from "./autoApprovalSettings";
import type { PaymentProviderVerificationResult } from "../services/paymentProviderVerificationService";

type Subject = "order" | "wallet";
export const pending = (status: string) => status === "pending" || status === "pending_review";
export function autoApprovalEligibility(result: PaymentProviderVerificationResult) {
 return result.outcome === "VERIFIED" && result.code === "200200" && result.amountMatches === true
  && result.recipientCheckApplied === true && !!result.occurredAt && !!result.bankTransactionReference;
}
function safeReason(error: unknown) {
 return error instanceof Error && ["PROVIDER_TRANSACTION_ALREADY_USED", "PROVIDER_REFERENCE_REQUIRED"].includes(error.message)
  ? error.message : "AUTO_APPROVAL_FAILED";
}
export async function persistAndAutoApprove(type: Subject, initial: any, result: PaymentProviderVerificationResult) {
 let approvalPolicyRevision: number | undefined;
 const table = type === "order" ? payments : walletTopups;
 const guard = type === "order" ? db.withAccountMergePaymentMutationGuard : db.withAccountMergeWalletTopupMutationGuard;
 const sameSubmission = (row: any) => row.slipImageUrl === initial.slipImageUrl
  && String(row.slipSubmittedAt) === String(initial.slipSubmittedAt);
 const write = async (tx: any, value: PaymentProviderVerificationResult) => {
  await tx.update(table).set({ extractedData: JSON.stringify({providerVerification: value}),
   reviewReason: value.approvalReason ?? "PROVIDER_REVIEW_REQUIRED" }).where(eq(table.id, initial.id));
 };
 try {
  return await guard(initial.id, undefined, async tx => {
   const [row] = await tx.select().from(table).where(eq(table.id, initial.id)).limit(1).for("update");
   if (!row || !pending(row.status)) return { ...result, approvalOutcome: "SKIPPED", approvalReason: "ALREADY_PROCESSED" };
   // Optimistic submission check only; never a legacy/R2 URL identity policy.
   if (!sameSubmission(row)) return { ...result, approvalOutcome: "SKIPPED", approvalReason: "SUBMISSION_CHANGED" };
   const [order] = type === "order"
    ? await tx.select().from(orders).where(eq(orders.id, row.orderId)).limit(1).for("update") : [];
   if (type === "order" && (!order || ["approved", "completed", "cancelled", "rejected"].includes(order.status)))
    return { ...result, approvalOutcome: "SKIPPED", approvalReason: "ORDER_ALREADY_PROCESSED" };
   const expected = type === "order" ? order.totalAmount : row.requestedAmount;
   if (result.amount !== undefined && result.amount !== Number(expected).toFixed(2)) {
    result = { ...result, outcome: "REVIEW_REQUIRED", amountMatches: false, reason: "AMOUNT_CHANGED" };
   }
   const policy = await readAutoPolicy(tx);
   approvalPolicyRevision = policy.revision;
   const next = { ...result, approvalOutcome: "SKIPPED", approvalReason: !policy.enabled ? "AUTO_APPROVE_DISABLED" : "VERIFICATION_NOT_ELIGIBLE", approvalPolicyRevision: policy.revision, approvalCheckedAt: new Date().toISOString() };
   await tx.update(table).set({ status: "pending_review" }).where(eq(table.id, initial.id));
   await write(tx, next);
   if (!policy.enabled || !autoApprovalEligibility(result)) return next;
   // Existing services own approval, purchases, points, bonus and credit.
   if (type === "order") await approvePayment(initial.id, "provider_auto", undefined, tx);
   else await db.approveWalletTopup(initial.id, null, tx);
   const approved = { ...next, approvalOutcome: "APPROVED", approvalReason: "PROVIDER_AUTO_APPROVED", approvalCheckedAt: new Date().toISOString() };
   await write(tx, approved);
   return approved;
  });
 } catch (error) {
  // Approval transaction rolled back. Keep verification separate from financial failure.
  const failed = { ...result, approvalPolicyRevision, approvalOutcome: "ERROR", approvalReason: safeReason(error), approvalCheckedAt: new Date().toISOString() };
  await guard(initial.id, undefined, async tx => {
   const [row] = await tx.select().from(table).where(eq(table.id, initial.id)).limit(1).for("update");
   if (row && pending(row.status) && sameSubmission(row)) await write(tx, failed);
  });
  return failed;
 }
}
