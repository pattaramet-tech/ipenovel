/**
 * Core validation utilities for the Ipenovel application
 * Shared between client and server for consistency
 */

import { z } from "zod";

// ============ COMMON SCHEMAS ============

export const episodeIdSchema = z.number().int().positive();
export const novelIdSchema = z.number().int().positive();
export const userIdSchema = z.number().int().positive();
export const categoryIdSchema = z.number().int().positive();
export const couponCodeSchema = z.string().min(1).max(50);
export const pointsAmountSchema = z.number().int().min(0);
export const priceSchema = z.number().positive();
export const percentageSchema = z.number().min(0).max(100);

// ============ ORDER VALIDATION ============

export const createOrderInputSchema = z.object({
  couponCode: couponCodeSchema.optional(),
  pointsToRedeem: pointsAmountSchema.optional(),
});

export const orderNumberSchema = z.string().regex(/^ORD-\d{8}-[A-Z0-9]{6}$/);

// ============ PAYMENT VALIDATION ============

export const paymentSlipInputSchema = z.object({
  orderId: z.number().int().positive(),
  slipImageBase64: z.string().min(100), // At least 100 chars of base64
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
});

export const approvePaymentInputSchema = z.object({
  paymentId: z.number().int().positive(),
});

export const rejectPaymentInputSchema = z.object({
  paymentId: z.number().int().positive(),
  rejectionReason: z.string().min(5).max(500),
});

// ============ COUPON VALIDATION ============

export const validateCouponInputSchema = z.object({
  couponCode: couponCodeSchema,
  subtotalAmount: priceSchema,
});

export const createCouponInputSchema = z.object({
  code: couponCodeSchema,
  discountType: z.enum(["flat", "percentage"]),
  discountValue: priceSchema,
  minPurchaseAmount: priceSchema.optional(),
  maxUsageCount: z.number().int().positive().optional(),
  expiresAt: z.date().optional(),
});

// ============ POINTS VALIDATION ============

export const redeemPointsInputSchema = z.object({
  pointsAmount: pointsAmountSchema,
});

// ============ EPISODE VALIDATION ============

export const episodeNumberSchema = z.string().regex(/^\d+(-\d+)?$/); // "1" or "581-619"

export const createEpisodeInputSchema = z.object({
  novelId: novelIdSchema,
  episodeNumber: episodeNumberSchema,
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  isFree: z.boolean().default(false),
  price: priceSchema.optional(),
  fileUrl: z.string().url().optional(),
});

// ============ CONSTANTS ============

export const POINTS_CONVERSION_RATE = 100; // 100 currency units = 1 point (earn)
export const POINTS_REDEMPTION_RATE = 1; // 1 point = 1 currency unit (redeem)
export const MAX_FILE_SIZE_MB = 100;
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// ============ HELPER FUNCTIONS ============

/**
 * Calculate points earned from purchase amount
 * 100 currency units = 1 point
 */
export function calculatePointsEarned(amount: number): number {
  return Math.floor(amount / POINTS_CONVERSION_RATE);
}

/**
 * Calculate currency discount from points
 * 1 point = 1 currency unit
 */
export function calculateCurrencyFromPoints(points: number): number {
  return points * POINTS_REDEMPTION_RATE;
}

/**
 * Validate order total calculation
 */
export function validateOrderTotal(
  subtotal: number,
  discountAmount: number,
  pointsDiscount: number
): number {
  const total = subtotal - discountAmount - pointsDiscount;
  if (total < 0) {
    throw new Error("Order total cannot be negative");
  }
  return total;
}

/**
 * Generate unique order number
 * Format: ORD-YYYYMMDD-XXXXXX
 */
export function generateOrderNumber(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `ORD-${year}${month}${day}-${random}`;
}

/**
 * Validate episode number format
 * Supports: "1", "581", "581-619"
 */
export function validateEpisodeNumber(episodeNumber: string): boolean {
  return /^\d+(-\d+)?$/.test(episodeNumber);
}

/**
 * Parse episode number range
 * Returns [start, end] or [single, single]
 */
export function parseEpisodeRange(episodeNumber: string): [number, number] {
  const parts = episodeNumber.split("-").map((p) => parseInt(p.trim(), 10));
  if (parts.length === 1) {
    return [parts[0], parts[0]];
  }
  return [parts[0], parts[1]];
}

/**
 * Format episode number for display
 * "1" -> "Episode 1"
 * "581-619" -> "Episodes 581-619"
 */
export function formatEpisodeNumber(episodeNumber: string): string {
  const [start, end] = parseEpisodeRange(episodeNumber);
  if (start === end) {
    return `Episode ${start}`;
  }
  return `Episodes ${start}-${end}`;
}
