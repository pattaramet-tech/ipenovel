/**
 * Wallet Service Layer
 * Handles wallet top-up and checkout business logic
 */

import * as db from "../db";
import { TRPCError } from "@trpc/server";
import { verifyWalletTopupWithProvider } from "./paymentProviderVerificationService";
import { eq } from "drizzle-orm";
import { walletAccounts, walletTransactions } from "../../drizzle/schema";
import { decimalToMinorUnits, minorUnitsToDecimal } from "./accountMergeFinancialMath";

export async function createWalletTopupRequest(userId: number, requestedAmount: string, slipImageUrl?: string) {
  // STRICT validation: must be a valid positive number only
  // Reject: "100abc", "NaN", "-100", "0", "", null, undefined, etc.
  const trimmed = String(requestedAmount || "").trim();
  
  // Check if it's a valid number format (digits and optional decimal point)
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Top-up amount must be a valid positive number (e.g., 100 or 100.50)",
    });
  }
  
  const amount = parseFloat(trimmed);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Top-up amount must be greater than 0",
    });
  }

  // New flow: slip must be uploaded first before creating the request
  if (!slipImageUrl) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Payment slip is required",
    });
  }

  let topup: any;
  try {
    topup = await db.createWalletTopup(userId, requestedAmount, slipImageUrl);
    if (!topup) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to create wallet top-up request",
      });
    }
  } catch (createError: any) {
    // createWalletTopup failed - this is a critical error that should be surfaced
    console.error("[Wallet] Create topup failed:", {
      message: createError?.message,
      code: createError?.code,
      userId,
      requestedAmount,
      hasSlipImageUrl: !!slipImageUrl,
      error: createError,
    });
    // Wrap error for user - don't expose SQL details
    if (createError instanceof TRPCError) {
      throw createError;
    }
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "บันทึกรายการเติมเงินไม่สำเร็จ กรุณาลองใหม่อีกครั้ง",
    });
  }

  // Provider-only verification. Storage is used only to obtain the submitted
  // bytes; no legacy/R2 identity, OCR, local hash, or Payment V2 gate decides
  // whether this request may reach the payment provider.
  try {
    const providerVerification = await verifyWalletTopupWithProvider(topup.id);
    return {
      ...topup,
      providerVerification,
    };
  } catch {
    // The top-up request is durable even when the external provider is down.
    // Leave it pending for a later provider retry or explicit admin review.
    return {
      ...topup,
      providerVerification: {
        provider: "slip2go" as const,
        outcome: "ERROR" as const,
        recipientCheckApplied: false,
      },
    };
  }
}

export async function uploadWalletTopupSlip(topupId: number, userId: number, slipImageUrl: string) {
  const topup = await db.getWalletTopupById(topupId);
  if (!topup) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Wallet top-up request not found",
    });
  }

  if (topup.userId !== userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You can only upload slip for your own top-up request",
    });
  }

  if (topup.status !== "pending") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Cannot upload slip for a ${topup.status} top-up request`,
    });
  }

  await db.updateWalletTopupSlip(topupId, slipImageUrl);
  const providerVerification = await verifyWalletTopupWithProvider(topupId);
  return { success: true, topupId, slipImageUrl, providerVerification };
}

export async function adminApproveWalletTopup(topupId: number, adminUserId: number) {
  const topup = await db.getWalletTopupById(topupId);
  if (!topup) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Wallet top-up request not found",
    });
  }

  if (!topup.slipImageUrl) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Cannot approve top-up without slip image",
    });
  }

  // CRITICAL: Check if topup is already approved/rejected (prevent re-approval)
  // Allow both pending and pending_review statuses for admin approval
  if (topup.status !== "pending" && topup.status !== "pending_review") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Cannot approve a ${topup.status} top-up request`,
    });
  }

  try {
    return await db.approveWalletTopup(topupId, adminUserId);
  } catch (error) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: error instanceof Error ? error.message : "Failed to approve wallet top-up",
    });
  }
}

export async function adminRejectWalletTopup(
  topupId: number,
  adminUserId: number,
  reason: string
) {
  const topup = await db.getWalletTopupById(topupId);
  if (!topup) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Wallet top-up request not found",
    });
  }

  if (!reason || reason.trim().length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Rejection reason is required",
    });
  }

  try {
    return await db.rejectWalletTopup(topupId, adminUserId, reason);
  } catch (error) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: error instanceof Error ? error.message : "Failed to reject wallet top-up",
    });
  }
}

const ADMIN_WALLET_SPEC = { precision: 12, scale: 2 } as const;

/** Canonical fixed-decimal, locked admin wallet mutation primitive for IPE-048. */
export async function adminWalletLedgerAdjustment(input: {
  tx: any;
  userId: number;
  delta: string;
  expectedBalance: string;
  referenceType: "admin_wallet_credit" | "admin_wallet_clawback";
  referenceId: number;
  note: string;
}) {
  const wallet = (await input.tx.select().from(walletAccounts)
    .where(eq(walletAccounts.userId, input.userId)).limit(1).for("update"))[0];
  if (!wallet) throw new Error("Wallet account unavailable");
  const beforeMinor = decimalToMinorUnits(String(wallet.balance), "walletBalance", ADMIN_WALLET_SPEC);
  const expectedMinor = decimalToMinorUnits(input.expectedBalance, "expectedBalance", ADMIN_WALLET_SPEC);
  if (beforeMinor !== expectedMinor) throw new Error("STALE_PREVIEW");
  const deltaMinor = decimalToMinorUnits(input.delta, "delta", ADMIN_WALLET_SPEC, { allowNegative: true });
  const afterMinor = beforeMinor + deltaMinor;
  if (afterMinor < 0) throw new Error("INSUFFICIENT_WALLET");
  const before = minorUnitsToDecimal(beforeMinor, 2);
  const after = minorUnitsToDecimal(afterMinor, 2);
  await input.tx.update(walletAccounts).set({ balance: after, updatedAt: new Date() })
    .where(eq(walletAccounts.userId, input.userId));
  const result: any = await input.tx.insert(walletTransactions).values({
    userId: input.userId, type: "adjust" as any, amount: input.delta,
    balanceBefore: before, balanceAfter: after, referenceType: input.referenceType,
    referenceId: input.referenceId, note: input.note,
  });
  const walletTransactionId = Number((Array.isArray(result) ? result[0] : result)?.insertId);
  if (!Number.isInteger(walletTransactionId) || walletTransactionId <= 0) throw new Error("Failed to create wallet ledger entry");
  return { before, after, walletTransactionId };
}