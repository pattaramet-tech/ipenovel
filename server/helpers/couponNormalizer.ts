/**
 * Coupon Normalizer Helper
 * Ensures consistent serialization of decimal fields from DB to client
 */

export interface NormalizedCoupon {
  id: number;
  code: string;
  discountType: "flat" | "percentage";
  discountValue: string;
  minPurchaseAmount: string | null;
  maxUsageCount: number | null;
  usageCount: number;
  isActive: boolean;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Normalize coupon from DB to ensure all decimal fields are strings
 * and all fields are present (not undefined)
 */
export function normalizeCoupon(coupon: any): NormalizedCoupon {
  return {
    id: coupon.id,
    code: coupon.code,
    discountType: coupon.discountType,
    // Ensure discountValue is always a string, never null/undefined
    discountValue: coupon.discountValue
      ? String(coupon.discountValue).trim()
      : "0.00",
    // Ensure minPurchaseAmount is string or null
    minPurchaseAmount: coupon.minPurchaseAmount
      ? String(coupon.minPurchaseAmount).trim()
      : null,
    maxUsageCount: coupon.maxUsageCount || null,
    usageCount: coupon.usageCount || 0,
    isActive: coupon.isActive ?? true,
    expiresAt: coupon.expiresAt || null,
    createdAt: coupon.createdAt,
    updatedAt: coupon.updatedAt,
  };
}

/**
 * Normalize array of coupons
 */
export function normalizeCoupons(coupons: any[]): NormalizedCoupon[] {
  return coupons.map(normalizeCoupon);
}

/**
 * Validate coupon discount value is numeric
 */
export function isValidDiscountValue(value: any): boolean {
  if (!value) return false;
  const num = parseFloat(String(value));
  return !isNaN(num) && num >= 0;
}
