import * as db from "../db";

/**
 * Generate order number in MMDDNNN format
 * MM = month, DD = day, NNN = sequence (001-999)
 */
export function generateOrderNumber(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const sequence = String(Math.floor(Math.random() * 900) + 100); // 100-999
  const datePrefix = `${month}${day}`;
  return `${datePrefix}${sequence}`;
}

/**
 * Validate coupon for an order
 * Returns discount amount or throws error with specific reason
 */
export async function validateAndApplyCoupon(couponCode: string, subtotal: string): Promise<{ discountAmount: string; coupon: any }> {
  // Normalize coupon code: trim and uppercase for consistent lookup
  const normalizedCode = String(couponCode || "").trim().toUpperCase();
  const coupon = await db.getCouponByCode(normalizedCode);

  if (!coupon) {
    throw new Error("Coupon not found");
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

  const subtotalNum = parseFloat(subtotal);
  const minPurchase = coupon.minPurchaseAmount ? parseFloat(String(coupon.minPurchaseAmount).trim()) : 0;

  if (subtotalNum < minPurchase) {
    throw new Error(`Minimum purchase amount of ฿${minPurchase.toFixed(2)} required`);
  }

  // Validate percentage range
  if (coupon.discountType === "percentage" && (discountValue < 0 || discountValue > 100)) {
    throw new Error("Coupon percentage must be between 0 and 100");
  }

  let discountAmount = "0.00";

  if (coupon.discountType === "flat") {
    discountAmount = Math.min(subtotalNum, discountValue).toFixed(2);
  } else if (coupon.discountType === "percentage") {
    const percentDiscount = (subtotalNum * discountValue) / 100;
    discountAmount = percentDiscount.toFixed(2);
  }

  return { discountAmount, coupon };
}

/**
 * Check if episode is already purchased by user
 */
export async function isEpisodeAlreadyPurchased(userId: number, episodeId: number): Promise<boolean> {
  const purchase = await db.getPurchaseByUserAndEpisode(userId, episodeId);
  return !!purchase;
}

/**
 * Check if user has access to an episode (via purchase)
 */
export async function hasAccessToEpisode(userId: number, episodeId: number): Promise<boolean> {
  const purchase = await db.getPurchaseByUserAndEpisode(userId, episodeId);
  return !!purchase;
}

/**
 * Create order from cart
 */
export async function createOrderFromCart(
  userId: string,
  cartItems: any[],
  couponCode?: string,
  pointsToRedeem?: string
): Promise<any> {
  // Calculate subtotal
  let subtotal = 0;
  for (const item of cartItems) {
    const price = parseFloat(item.price?.toString() || "0");
    subtotal += price;
  }

  // Apply coupon if provided
  let discountAmount = 0;
  let appliedCoupon = null;
  if (couponCode) {
    const { discountAmount: discount, coupon } = await validateAndApplyCoupon(couponCode, subtotal.toString());
    discountAmount = parseFloat(discount);
    appliedCoupon = coupon;
  }

  // Calculate total
  const totalAmount = Math.max(0, subtotal - discountAmount);

  // Create order
  const orderNumber = generateOrderNumber();
  const result = await db.createOrder({
    userId: parseInt(userId),
    orderNumber,
    subtotal: subtotal.toString(),
    discountAmount: discountAmount.toString(),
    pointsDiscountAmount: "0",
    totalAmount: totalAmount.toString(),
    couponCodeSnapshot: couponCode,
  });

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
    await db.createOrderItems(orderItemsData);
  }

  return result;
}

/**
 * Approve payment and create purchases
 */
export async function approvePayment(paymentId: number, approvedBy: string): Promise<void> {
  const payment = await db.getPaymentById(paymentId);
  if (!payment) {
    throw new Error("Payment not found");
  }

  const order = await db.getOrderById(payment.orderId);
  if (!order) {
    throw new Error("Order not found");
  }

  // Update payment status
  await db.updatePayment(paymentId, {
    status: "approved",
  });

  // Update order status
  await db.updateOrder(order.id, { status: "approved" });

  // Create purchase records
  const orderItems = await db.getOrderItems(order.id);
  for (const item of orderItems) {
    // Get episode to find novelId
    const episode = await db.getEpisodeById(item.episodeId);
    if (episode && order.userId) {
      await db.createPurchase(order.userId, episode.novelId, item.episodeId, order.id);
    }
  }
}

/**
 * Reject payment
 */
export async function rejectPayment(paymentId: number, rejectedBy: string, reason: string): Promise<void> {
  const payment = await db.getPaymentById(paymentId);
  if (!payment) {
    throw new Error("Payment not found");
  }

  // Update payment status
  await db.updatePayment(paymentId, {
    status: "rejected",
  });

  // Update order status
  const order = await db.getOrderById(payment.orderId);
  if (order) {
    await db.updateOrder(order.id, { status: "rejected" });
  }
}
