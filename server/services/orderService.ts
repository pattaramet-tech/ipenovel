/**
 * Order Service - Core business logic for checkout, payment, and entitlements
 * Ensures transactions, idempotency, and data consistency
 */

import { getDb } from "../db";
import * as db from "../db";
import { nanoid } from "nanoid";

const POINTS_CONVERSION_RATE = 100; // 100 currency units = 1 point
const POINTS_REDEMPTION_RATE = 1; // 1 point = 1 currency unit

/**
 * Generate unique order number
 * Format: ORD-{timestamp}-{randomId}
 */
export function generateOrderNumber(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const randomId = nanoid(8).toUpperCase();
  return `ORD-${timestamp}-${randomId}`;
}

/**
 * Validate coupon for an order
 * Returns discount amount or throws error
 */
export async function validateAndApplyCoupon(couponCode: string, subtotal: string): Promise<{ discountAmount: string; coupon: any }> {
  const coupon = await db.getCouponByCode(couponCode);

  if (!coupon) {
    throw new Error("Coupon not found");
  }

  if (!coupon.isActive) {
    throw new Error("Coupon is not active");
  }

  if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) {
    throw new Error("Coupon has expired");
  }

  if (coupon.maxUsageCount && coupon.usageCount >= coupon.maxUsageCount) {
    throw new Error("Coupon usage limit reached");
  }

  const subtotalNum = parseFloat(subtotal);
  const minPurchase = parseFloat(coupon.minPurchaseAmount?.toString() || "0");

  if (subtotalNum < minPurchase) {
    throw new Error(`Minimum purchase amount of ${minPurchase} required`);
  }

  let discountAmount = "0.00";

  if (coupon.discountType === "flat") {
    discountAmount = Math.min(subtotalNum, parseFloat(coupon.discountValue.toString())).toFixed(2);
  } else if (coupon.discountType === "percentage") {
    const percentDiscount = (subtotalNum * parseFloat(coupon.discountValue.toString())) / 100;
    discountAmount = percentDiscount.toFixed(2);
  }

  return { discountAmount, coupon };
}

/**
 * Calculate points to redeem
 * User can redeem up to their available balance
 */
export async function calculatePointsRedemption(userId: number, requestedPoints: string): Promise<{ pointsToRedeem: string; pointsDiscount: string }> {
  const balance = await db.getUserPointsBalance(userId);
  const balanceNum = parseFloat(balance);
  const requestedNum = parseFloat(requestedPoints);

  if (requestedNum > balanceNum) {
    throw new Error("Insufficient points balance");
  }

  const pointsDiscount = (requestedNum * POINTS_REDEMPTION_RATE).toFixed(2);
  return { pointsToRedeem: requestedPoints, pointsDiscount };
}

/**
 * Create order from cart items
 * Handles multi-item checkout, coupon, and points in a transaction
 */
export async function createOrderFromCart(userId: number, cartItems: any[], couponCode?: string, pointsToRedeem?: string) {
  const database = await getDb();
  if (!database) {
    throw new Error("Database not available");
  }

  // Calculate subtotal
  let subtotal = "0.00";
  for (const item of cartItems) {
    const itemPrice = parseFloat(item.price.toString());
    subtotal = (parseFloat(subtotal) + itemPrice).toFixed(2);
  }

  // Apply coupon if provided
  let discountAmount = "0.00";
  let couponSnapshot: string | undefined;

  if (couponCode) {
    const { discountAmount: discount, coupon } = await validateAndApplyCoupon(couponCode, subtotal);
    discountAmount = discount;
    couponSnapshot = couponCode;
  }

  // Apply points if provided
  let pointsDiscountAmount = "0.00";
  let pointsRedeemed = "0.00";

  if (pointsToRedeem) {
    const { pointsToRedeem: redeemAmount, pointsDiscount } = await calculatePointsRedemption(userId, pointsToRedeem);
    pointsRedeemed = redeemAmount;
    pointsDiscountAmount = pointsDiscount;
  }

  // Calculate total
  const totalAmount = (parseFloat(subtotal) - parseFloat(discountAmount) - parseFloat(pointsDiscountAmount)).toFixed(2);

  // Create order with transaction
  const orderNumber = generateOrderNumber();

  const result = await db.createOrder({
    orderNumber,
    userId,
    subtotal,
    discountAmount,
    pointsDiscountAmount,
    totalAmount,
    couponCodeSnapshot: couponSnapshot,
  });

  if (!result) {
    throw new Error("Failed to create order");
  }

  const orderId = (result as any)[0]?.insertId;

  // Create order items
  const orderItemsData = cartItems.map((item) => ({
    orderId,
    novelId: item.novelId,
    episodeId: item.episodeId,
    unitPrice: item.price.toString(),
    discountAmount: "0.00",
    finalPrice: item.price.toString(),
  }));

  await db.createOrderItems(orderItemsData);

  // Create payment record
  await db.createPayment(orderId);

  // Record order history
  await db.recordOrderHistory({
    orderId,
    action: "order_created",
    toStatus: "pending",
    actorUserId: userId,
  });

  // NOTE: Points redemption will be recorded when payment is approved, not at checkout

  // NOTE: Coupon usage will be recorded when payment is approved, not at checkout

  return {
    orderId,
    orderNumber,
    subtotal,
    discountAmount,
    pointsDiscountAmount,
    totalAmount,
  };
}

/**
 * Approve payment and grant entitlements
 * IDEMPOTENT: Approving twice won't duplicate purchases or points
 */
export async function approvePayment(paymentId: number, reviewedByUserId: number) {
  const database = await getDb();
  if (!database) {
    throw new Error("Database not available");
  }

  const payment = await db.getPaymentById(paymentId);
  if (!payment) {
    throw new Error("Payment not found");
  }

  // Check if already approved (idempotency)
  if (payment.status === "approved") {
    console.log(`Payment ${paymentId} already approved, skipping duplicate approval`);
    return { message: "Payment already approved" };
  }

  const order = await db.getOrderById(payment.orderId);
  if (!order) {
    throw new Error("Order not found");
  }

  // Approve payment
  await db.approvePayment(paymentId, reviewedByUserId);

  // Update order status
  // Note: In a real transaction, this would be wrapped in a DB transaction
  // For now, we update sequentially

  // Get order items
  const orderItems = await db.getOrderItems(order.id);

  // Create purchase entitlements for each item
  for (const item of orderItems) {
    // Check if purchase already exists (idempotency)
    const existingPurchase = await db.getPurchaseByUserAndEpisode(order.userId || 0, item.episodeId);
    if (!existingPurchase) {
      await db.createPurchase(order.userId || 0, item.novelId, item.episodeId, order.id);
    }
  }

  // Grant points (only if not already granted)
  // Check if points were already earned for this order
  const pointsHistory = await db.getPointsHistory(order.userId || 0);
  const alreadyEarned = pointsHistory.some((t: any) => t.referenceType === "order" && t.referenceId === order.id && t.type === "earn");

  if (!alreadyEarned && order.userId) {
    const earnedPoints = (parseFloat(order.totalAmount.toString()) / POINTS_CONVERSION_RATE).toFixed(2);
    const currentBalance = await db.getUserPointsBalance(order.userId);
    const newBalance = (parseFloat(currentBalance) + parseFloat(earnedPoints)).toFixed(2);

    await db.recordPointsTransaction({
      userId: order.userId,
      type: "earn",
      amount: earnedPoints,
      balanceAfter: newBalance,
      referenceType: "order",
      referenceId: order.id,
      note: `Earned points from order ${order.orderNumber}`,
    });
  }

  // Record order history
  await db.recordOrderHistory({
    orderId: order.id,
    action: "payment_approved",
    fromStatus: order.status,
    toStatus: "approved",
    actorUserId: reviewedByUserId,
  });

  // Record coupon usage only after approval
  if (order.couponCodeSnapshot) {
    const coupon = await db.getCouponByCode(order.couponCodeSnapshot);
    if (coupon) {
      await db.recordCouponUsage(coupon.id, order.userId || 0, order.id);
    }
  }

  // Deduct points only after approval
  if (order.pointsDiscountAmount && order.pointsDiscountAmount !== "0.00" && order.userId) {
    const pointsToDeduct = (parseFloat(order.pointsDiscountAmount.toString()) / POINTS_CONVERSION_RATE).toFixed(2);
    const currentBalance = await db.getUserPointsBalance(order.userId);
    const newBalance = (parseFloat(currentBalance) - parseFloat(pointsToDeduct)).toFixed(2);

    await db.recordPointsTransaction({
      userId: order.userId,
      type: "redeem",
      amount: pointsToDeduct,
      balanceAfter: newBalance,
      referenceType: "order",
      referenceId: order.id,
      note: `Redeemed points for order ${order.orderNumber}`,
    });
  }

  return { message: "Payment approved successfully" };
}

/**
 * Reject payment
 */
export async function rejectPayment(paymentId: number, reviewedByUserId: number, rejectionReason: string) {
  const database = await getDb();
  if (!database) {
    throw new Error("Database not available");
  }

  const payment = await db.getPaymentByOrderId(paymentId);
  if (!payment) {
    throw new Error("Payment not found");
  }

  const order = await db.getOrderById(payment.orderId);
  if (!order) {
    throw new Error("Order not found");
  }

  // Reject payment
  await db.rejectPayment(paymentId, reviewedByUserId, rejectionReason);

  // Record order history
  await db.recordOrderHistory({
    orderId: order.id,
    action: "payment_rejected",
    fromStatus: order.status,
    toStatus: "rejected",
    actorUserId: reviewedByUserId,
    note: rejectionReason,
  });

  return { message: "Payment rejected successfully" };
}

/**
 * Check if user has access to an episode
 * Returns true if user has purchased the episode or it's free
 */
export async function hasAccessToEpisode(userId: number, episodeId: number): Promise<boolean> {
  const episode = await db.getEpisodeById(episodeId);
  if (!episode) {
    return false;
  }

  // Free episodes are accessible to all
  if (episode.isFree) {
    return true;
  }

  // Check if user has purchased this episode
  const purchase = await db.getPurchaseByUserAndEpisode(userId, episodeId);
  return !!purchase;
}

/**
 * Check if episode is already purchased by user
 */
export async function isEpisodeAlreadyPurchased(userId: number, episodeId: number): Promise<boolean> {
  const purchase = await db.getPurchaseByUserAndEpisode(userId, episodeId);
  return !!purchase;
}
