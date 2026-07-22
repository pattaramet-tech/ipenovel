import * as db from "../db";

import { ApprovalService } from "./approvalService";
import { normalizeMoneyAmount, formatMoney } from "../helpers/moneyNormalizer";

/**
 * Generate order number in MMDDNNNNNNN format
 * MM = month, DD = day, NNNNNNN = timestamp-based sequence for uniqueness
 */
export function generateOrderNumber(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  // Use milliseconds + random to ensure uniqueness
  const timestamp = Date.now() % 10000000; // Last 7 digits of timestamp
  const random = String(Math.floor(Math.random() * 100)).padStart(2, "0");
  const sequence = String(timestamp).padStart(7, "0") + random;
  const datePrefix = `${month}${day}`;
  return `ORD-${datePrefix}${sequence}`;
}

/**
 * Validate coupon for an order
 * Returns discount amount or throws error with specific reason
 * If userId is provided, checks that reward coupons belong to the user
 */
export async function validateAndApplyCoupon(couponCode: string, subtotal: string, tx?: any, userId?: number): Promise<{ discountAmount: string; coupon: any; normalizedCode?: string }> {
  // Normalize coupon code: trim and uppercase for consistent lookup
  const normalizedCode = String(couponCode || "").trim().toUpperCase();
  const coupon = await db.getCouponByCode(normalizedCode, tx);

  if (!coupon) {
    throw new Error("Coupon not found");
  }

  // Check if this is a reward coupon (sports match win or daily check-in)
  // and enforce ownership + status. getRewardCouponOwnership checks every
  // known reward-tracking table - see docs/DAILY_CHECKIN_COUPON.md PART A.
  if (userId && coupon.id) {
    const ownership = await db.getRewardCouponOwnership(coupon.id, tx);

    if (ownership) {
      // Enforce ownership: reward coupon must belong to this user
      if (ownership.userId !== userId) {
        throw new Error("This coupon belongs to another user");
      }

      // Enforce one-time use: reward coupon must be in "issued" status
      if (ownership.status !== "issued") {
        if (ownership.status === "used") {
          throw new Error("This reward coupon has already been used");
        } else if (ownership.status === "expired") {
          throw new Error("This reward coupon has expired");
        } else if (ownership.status === "void") {
          throw new Error("This reward coupon has been cancelled");
        } else {
          throw new Error(`Invalid reward coupon status: ${ownership.status}`);
        }
      }
    }
  }

  // Validate discount value first - this is critical
  const discountValue = coupon.discountValue ? parseFloat(String(coupon.discountValue).trim()) : NaN;
  if (isNaN(discountValue) || discountValue <= 0) {
    throw new Error("Coupon has invalid discount value");
  }

  if (!coupon.isActive) {
    throw new Error("Coupon is inactive");
  }

  if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) {
    throw new Error("Coupon has expired");
  }

  if (coupon.maxUsageCount && coupon.usageCount >= coupon.maxUsageCount) {
    throw new Error("Coupon usage limit reached");
  }

  const subtotalNum = normalizeMoneyAmount(subtotal, "subtotal");
  const minPurchase = coupon.minPurchaseAmount ? normalizeMoneyAmount(coupon.minPurchaseAmount, "minPurchaseAmount") : 0;

  if (subtotalNum < minPurchase) {
    throw new Error(`Minimum purchase amount of ฿${minPurchase.toFixed(2)} required`);
  }

  // Validate percentage range
  if (coupon.discountType === "percentage" && (discountValue < 0 || discountValue > 100)) {
    throw new Error("Coupon percentage must be between 0 and 100");
  }

  let discountAmount = "0.00";

  if (coupon.discountType === "flat") {
    discountAmount = formatMoney(Math.min(subtotalNum, discountValue), "discountAmount");
  } else if (coupon.discountType === "percentage") {
    let percentDiscount = (subtotalNum * discountValue) / 100;
    // maxDiscountAmount is nullable - only applied when the coupon actually
    // has a cap set (e.g. the daily check-in reward: "5% off, capped at
    // ฿10"). Every coupon created before this column existed has it as
    // NULL, so this branch never changes their computed discount.
    if (coupon.maxDiscountAmount != null) {
      const cap = normalizeMoneyAmount(coupon.maxDiscountAmount, "maxDiscountAmount");
      percentDiscount = Math.min(percentDiscount, cap);
    }
    discountAmount = formatMoney(percentDiscount, "percentDiscount");
  }

  return { discountAmount, coupon, normalizedCode };
}

/**
 * Check if episode is already purchased by user
 */
export async function isEpisodeAlreadyPurchased(userId: number, episodeId: number, tx?: any): Promise<boolean> {
  const purchase = await db.getPurchaseByUserAndEpisode(userId, episodeId, tx);
  return !!purchase;
}

/**
 * Check if user has access to an episode (via purchase)
 */
export async function hasAccessToEpisode(userId: number, episodeId: number, tx?: any): Promise<boolean> {
  const purchase = await db.getPurchaseByUserAndEpisode(userId, episodeId, tx);
  return !!purchase;
}

/**
 * Create order from cart
 */
export async function createOrderFromCart(
  userId: string,
  cartItems: any[],
  couponCode?: string,
  pointsToRedeem?: string,
  slipImageUrl?: string,
  tx?: any,
  userIdNum?: number
): Promise<any> {
  // Parse userId first
  const userIdNumParsed = userIdNum ?? parseInt(userId, 10);
  if (!Number.isFinite(userIdNumParsed)) {
    throw new Error("Invalid user ID");
  }

  // Check for already purchased episodes
  for (const item of cartItems) {
    if (item.episodeId) {
      const existingPurchase = await db.getPurchaseByUserAndEpisode(userIdNumParsed, item.episodeId, tx);
      if (existingPurchase) {
        throw new Error("Some items in your cart have already been purchased. Please refresh your cart.");
      }
    }
  }

  // Calculate subtotal
  let subtotal = 0;
  for (const item of cartItems) {
    const price = parseFloat(item.price?.toString() || "0");
    subtotal += price;
  }

  // Apply coupon if provided
  let discountAmount = 0;
  let normalizedCouponCode: string | undefined;
  if (couponCode) {
    const userIdForValidation = userIdNum || (userId ? parseInt(userId, 10) : undefined);
    const { discountAmount: discount, normalizedCode } = await validateAndApplyCoupon(couponCode, subtotal.toString(), tx, userIdForValidation);
    discountAmount = parseFloat(discount);
    normalizedCouponCode = normalizedCode;
  }

  // Apply points redemption if provided
  let pointsDiscountAmount = 0;
  
  if (pointsToRedeem) {
    // Strict validation: reject invalid numeric strings like "10abc", "abc", "", "NaN"
    const numericRegex = /^\d+(\.\d+)?$/;
    const pointsStr = (pointsToRedeem || "").trim();
    if (!numericRegex.test(pointsStr)) {
      throw new Error("Invalid points value. Must be a valid number.");
    }
    
    const requestedPoints = parseFloat(pointsStr);
    if (!Number.isFinite(requestedPoints) || requestedPoints < 0) {
      throw new Error("Points must be a finite number >= 0.");
    }
    
    if (requestedPoints > 0) {
      // Validate user has enough points
      const balanceStr = await db.getUserPointsBalance(userIdNumParsed, tx);
      const balance = normalizeMoneyAmount(balanceStr, "pointsBalance");
      if (requestedPoints > balance) {
        throw new Error(`Insufficient points balance. You have ${balance.toFixed(2)} points.`);
      }
      // Points cannot exceed subtotal - couponDiscount
      const subtotalNum = normalizeMoneyAmount(subtotal, "subtotal");
      const discountNum = normalizeMoneyAmount(discountAmount, "discountAmount");
      const maxPointsDiscount = Math.max(0, subtotalNum - discountNum);
      if (requestedPoints > maxPointsDiscount) {
        throw new Error(`Points cannot exceed remaining balance of ${maxPointsDiscount.toFixed(2)}.`);
      }
      // Points: 1 point = 1 currency unit discount
      pointsDiscountAmount = requestedPoints;
    }
  }

  // Calculate total
  const totalAmount = Math.max(0, subtotal - discountAmount - pointsDiscountAmount);

  // Create order
  const orderNumber = generateOrderNumber();
  const result = await db.createOrder({
    userId: userIdNumParsed,
    orderNumber,
    subtotal: subtotal.toString(),
    discountAmount: discountAmount.toString(),
    pointsDiscountAmount: pointsDiscountAmount.toString(),
    totalAmount: totalAmount.toString(),
    couponCodeSnapshot: normalizedCouponCode,
  }, tx);

  if (!result) {
    throw new Error("Failed to create order");
  }

  // Create order items with required fields
  const orderId = (result as any).id;
  if (!orderId) {
    throw new Error("Failed to get order ID after creation");
  }

  const orderItemsData = cartItems.map((item: any) => ({
    orderId: orderId,
    novelId: item.novelId || 0,
    episodeId: item.episodeId,
    unitPrice: item.price?.toString() || "0",
    discountAmount: "0",
    finalPrice: item.price?.toString() || "0",
  }));

  if (orderItemsData.length > 0) {
    await db.createOrderItems(orderItemsData, tx);
  }

  // Create payment record for the order (with slip if provided)
  await db.createPayment(orderId, slipImageUrl, tx);

  // Fetch and return the full order object
  const fullOrder = await db.getOrderById(orderId, tx);
  if (!fullOrder) {
    throw new Error("Failed to fetch created order");
  }
  return fullOrder;
}

/**
 * Approve payment and create purchases
 */
export async function approvePayment(paymentId: number, approvedBy: string, adminLabel?: string, tx?: any): Promise<{ message: string }> {
  const payment = await db.getPaymentById(paymentId, tx);
  if (!payment) {
    throw new Error("Payment not found");
  }

  const order = await db.getOrderById(payment.orderId, tx);
  if (!order) {
    throw new Error("Order not found");
  }

  // Use ApprovalService for manual approval with metadata
  const approvedByNum = parseInt(approvedBy, 10);
  if (!isNaN(approvedByNum)) {
    await ApprovalService.approvePaymentWithSource(paymentId, "manual", {
      adminId: approvedByNum,
      adminLabel: adminLabel || "Admin",
      reviewedAt: new Date(),
    }, tx);
  } else {
    // Fallback if admin ID is invalid
    await db.updatePayment(paymentId, {
      status: "approved",
    }, tx);
  }

  // Update order status and payment status
  await db.updateOrder(order.id, { 
    status: "approved",
    paymentStatus: "approved"
  }, tx);
  
  // Also update reviewedByUserId for backward compatibility
  if (!isNaN(approvedByNum)) {
    await db.approvePayment(paymentId, approvedByNum, tx);
  }

  // Record order history
  await db.recordOrderHistory({
    orderId: order.id,
    action: "payment_approved",
    fromStatus: order.status,
    toStatus: "approved",
    actorUserId: approvedByNum || undefined,
    note: "Payment approved by admin",
  }, tx);

  // Finalize order completion (points, purchases, coupon usage)
  if (order.userId) {
    await finalizeOrderCompletion(order.id, order.userId, tx);
  }

  return { message: `Payment ${paymentId} approved successfully` };
}

/**
 * Finalize order completion: award points, deduct redeemed points, create purchases, record coupon usage
 * This is the single source of truth for all order completion flows (manual slip, wallet, etc.)
 * Idempotent: safe to call multiple times for the same order
 */
export async function finalizeOrderCompletion(orderId: number, userId: number, tx?: any): Promise<void> {
  const order = await db.getOrderById(orderId, tx);
  if (!order) {
    throw new Error(`Order ${orderId} not found`);
  }

  // 1. Deduct redeemed points (if any) - only if not already deducted
  const pointsDiscountNum = normalizeMoneyAmount(order.pointsDiscountAmount?.toString() || "0", "pointsDiscountAmount");
  if (pointsDiscountNum > 0) {
    // Locked read-modify-write: hasPointsBeenRedeemedForOrder has no unique
    // constraint backing it (unlike Daily Check-in's UNIQUE index), so
    // without the lock two concurrent finalizations of the SAME order (a
    // double-webhook, an admin double-click) could both see "not yet
    // deducted" and both insert a redeem row. When this function is called
    // with no outer tx (e.g. OCR auto-approval), withUserPointsLock opens
    // its own transaction scoped to just this section.
    await db.withUserPointsLock(userId, tx, async (lockedTx) => {
      const alreadyDeducted = await db.hasPointsBeenRedeemedForOrder(orderId, lockedTx);
      if (alreadyDeducted) return;
      const currentBalanceStr = await db.getUserPointsBalance(userId, lockedTx);
      const currentBalance = normalizeMoneyAmount(currentBalanceStr, "currentBalance");
      const newBalance = Math.max(0, currentBalance - pointsDiscountNum);
      await db.recordPointsTransaction({
        userId,
        type: "redeem",
        amount: formatMoney(pointsDiscountNum, "pointsDiscountNum"),
        balanceAfter: formatMoney(newBalance, "newBalance"),
        referenceType: "order",
        referenceId: orderId,
        note: `Points redeemed for order ${order.orderNumber}`,
      }, lockedTx);
    });
  }

  // 2. Create purchase records (idempotent: skip if already purchased)
  const orderItems = await db.getOrderItems(orderId, tx);
  for (const item of orderItems) {
    const episode = (item as any).episode || await db.getEpisodeById(item.episodeId, tx);
    if (episode && userId) {
      const existing = await db.getPurchaseByUserAndEpisode(userId, item.episodeId, tx);
      if (!existing) {
        await db.createPurchase(userId, episode.novelId, item.episodeId, orderId, tx);
      }
    }
  }

  // 3. Award loyalty points (only once per order)
  await awardPointsForOrder(orderId, userId, order.totalAmount.toString(), tx);

  // 4. Record coupon usage (if coupon was used)
  if (order.couponCodeSnapshot) {
    const coupon = await db.getCouponByCode(order.couponCodeSnapshot, tx);
    if (coupon) {
      await db.recordCouponUsage(coupon.id, userId, orderId, tx);
      // Update reward coupon status if this is a reward coupon (sports
      // match win or daily check-in) - each is a no-op if the coupon isn't
      // that reward type, so both are safe to call unconditionally.
      await db.markSportsRewardCouponUsed(coupon.id, userId, tx);
      await db.markDailyCheckinCouponUsed(coupon.id, userId, tx);
    }
  }
}

/**
 * Award loyalty points for a completed order
 * 100 currency units = 1 point
 * Only awards once per order (idempotent)
 */
async function awardPointsForOrder(orderId: number, userId: number, amount: string, tx?: any): Promise<void> {
  // Calculate points: 100 currency units = 1 point. Pure computation from
  // `amount`, not from the balance - safe to skip the lock entirely when
  // there is nothing to award.
  const amountNum = normalizeMoneyAmount(amount, "amount");
  const pointsToAward = Math.floor(amountNum / 100);

  if (pointsToAward <= 0) {
    console.log(`Order ${orderId} amount ${amount} is too small to award points`);
    return;
  }

  // Locked read-modify-write, same reasoning as the redeem section above:
  // hasPointsBeenAwardedForOrder has no unique constraint backing it, so the
  // idempotency check itself must run under the lock, not just the balance
  // arithmetic - otherwise two concurrent finalizations of the same order
  // could both see "not yet awarded" and both insert an earn row.
  await db.withUserPointsLock(userId, tx, async (lockedTx) => {
    const alreadyAwarded = await db.hasPointsBeenAwardedForOrder(orderId, lockedTx);
    if (alreadyAwarded) {
      console.log(`Points already awarded for order ${orderId}, skipping`);
      return;
    }

    const currentBalance = await db.getUserPointsBalance(userId, lockedTx);
    const currentBalanceNum = normalizeMoneyAmount(currentBalance, "currentBalance");
    const newBalance = formatMoney(currentBalanceNum + pointsToAward, "newBalance");

    await db.recordPointsTransaction({
      userId,
      type: "earn",
      amount: pointsToAward.toString(),
      balanceAfter: newBalance,
      referenceType: "order",
      referenceId: orderId,
      note: `Points earned from order ${orderId}`,
    }, lockedTx);
  });
}

/**
 * Reject payment
 */
export async function rejectPayment(paymentId: number, rejectedBy: string, reason: string, tx?: any): Promise<void> {
  const payment = await db.getPaymentById(paymentId, tx);
  if (!payment) {
    throw new Error("Payment not found");
  }

  const rejectedByNum = parseInt(rejectedBy, 10);

  // P0-2 FIX: Pass transaction parameter for atomicity
  // Use ApprovalService to reject payment with metadata
  // This preserves rejection reason and reviewer info without setting approval fields
  await ApprovalService.rejectPayment(
    paymentId,
    reason,
    !isNaN(rejectedByNum) ? rejectedByNum : undefined,
    tx  // Pass transaction for atomicity
  );
  
  // Also set reviewedByUserId via db.rejectPayment for backward compatibility
  if (!isNaN(rejectedByNum)) {
    await db.rejectPayment(paymentId, rejectedByNum, reason, tx);
  }

  // Update order status and payment status
  const order = await db.getOrderById(payment.orderId, tx);
  if (order) {
    await db.updateOrder(order.id, { 
      status: "rejected",
      paymentStatus: "rejected",
      notes: reason
    }, tx);

    // Record order history
    await db.recordOrderHistory({
      orderId: order.id,
      action: "payment_rejected",
      fromStatus: order.status,
      toStatus: "rejected",
      actorUserId: rejectedByNum || undefined,
      note: reason,
    }, tx);
  }
}

/**
 * Calculate how many points a user can redeem for a given order amount
 * Redemption rate: 1 point = 1 currency unit (1:1 ratio)
 * Users can redeem up to their full balance, capped at the order subtotal
 */
export async function calculatePointsRedemption(
  userId: number,
  subtotal: string,
  tx?: any
): Promise<{ pointsToRedeem: number; pointsDiscount: string }> {
  const balance = await db.getUserPointsBalance(userId, tx);
  const balanceNum = normalizeMoneyAmount(balance || "0", "balance");
  const subtotalNum = normalizeMoneyAmount(subtotal, "subtotal");

  // Cap redemption at the lower of balance or subtotal
  const pointsToRedeem = Math.min(Math.floor(balanceNum), Math.floor(subtotalNum));
  const pointsDiscount = formatMoney(pointsToRedeem, "pointsDiscount");

  return { pointsToRedeem, pointsDiscount };
}
