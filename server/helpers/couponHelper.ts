/**
 * Coupon normalizer - ensures consistent data format across DB, server, and client
 */

export interface NormalizedCoupon {
  id: number;
  code: string;
  discountType: "flat" | "percentage";
  discountValue: string;
  minPurchaseAmount: string;
  maxUsageCount: number | null;
  usageCount: number;
  isActive: boolean;
  expiresAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Normalize a coupon from DB to ensure all fields are safe and consistent
 */
export function normalizeCoupon(coupon: any): NormalizedCoupon {
  if (!coupon) {
    throw new Error("Coupon is null or undefined");
  }

  return {
    id: coupon.id,
    code: String(coupon.code || "").trim().toUpperCase(),
    discountType: coupon.discountType || "flat",
    discountValue: String(coupon.discountValue || "0").trim(),
    minPurchaseAmount: String(coupon.minPurchaseAmount || "0").trim(),
    maxUsageCount: coupon.maxUsageCount ?? null,
    usageCount: coupon.usageCount ?? 0,
    isActive: coupon.isActive ?? true,
    expiresAt: coupon.expiresAt ? new Date(coupon.expiresAt) : null,
    createdAt: coupon.createdAt ? new Date(coupon.createdAt) : undefined,
    updatedAt: coupon.updatedAt ? new Date(coupon.updatedAt) : undefined,
  };
}

/**
 * Normalize coupon code for lookup (trim, uppercase)
 */
export function normalizeCouponCode(code: string): string {
  return String(code || "").trim().toUpperCase();
}

/**
 * Validate that a normalized coupon has valid discount value
 */
export function validateCouponDiscountValue(discountValue: string): boolean {
  const num = parseFloat(discountValue);
  return !isNaN(num) && num > 0;
}

/**
 * Validate percentage discount is in valid range (0-100)
 */
export function validatePercentageDiscount(discountValue: string): boolean {
  const num = parseFloat(discountValue);
  return !isNaN(num) && num > 0 && num <= 100;
}

/**
 * Normalize coupon input for create/update operations
 */
export function normalizeCouponInput(input: any) {
  return {
    code: normalizeCouponCode(input.code),
    discountType: input.discountType || "flat",
    discountValue: String(input.discountValue || "0").trim(),
    minPurchaseAmount: input.minPurchaseAmount ? String(input.minPurchaseAmount).trim() : "0",
    maxUsageCount: input.maxUsageCount ? parseInt(String(input.maxUsageCount)) : null,
    isActive: input.isActive ?? true,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
  };
}
