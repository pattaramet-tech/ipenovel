/**
 * Wallet Service Layer
 * Handles wallet top-up and checkout business logic
 */

import * as db from "../db";
import { TRPCError } from "@trpc/server";

export async function createWalletTopupRequest(userId: number, requestedAmount: string, slipImageUrl?: string) {
  const amount = parseFloat(requestedAmount);
  if (isNaN(amount) || amount <= 0) {
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

  const topup = await db.createWalletTopup(userId, requestedAmount, slipImageUrl);
  if (!topup) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to create wallet top-up request",
    });
  }

  return topup;
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

  return db.updateWalletTopupSlip(topupId, slipImageUrl);
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
