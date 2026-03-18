import * as db from "../db";

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
 */
export async function validateAndApplyCoupon(couponCode: string, subtotal: string): Promise<{ discountAmount: string; coupon: any; normalizedCode?: string }> {
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

  return { discountAmount, coupon, normalizedCode };
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
  let normalizedCouponCode: string | undefined;
  if (couponCode) {
    const { discountAmount: discount, normalizedCode } = await validateAndApplyCoupon(couponCode, subtotal.toString());
    discountAmount = parseFloat(discount);
    normalizedCouponCode = normalizedCode;
  }

  // Apply points redemption if provided
  let pointsDiscountAmount = 0;
  const userIdNum = parseInt(userId);
  if (pointsToRedeem && parseFloat(pointsToRedeem) > 0) {
    const requestedPoints = parseFloat(pointsToRedeem);
    // Validate user has enough points
    const balanceStr = await db.getUserPointsBalance(userIdNum);
    const balance = parseFloat(balanceStr);
    if (requestedPoints > balance) {
      throw new Error(`Insufficient points balance. You have ${balance.toFixed(2)} points.`);
    }
    // Points: 1 point = 1 currency unit discount
    pointsDiscountAmount = Math.min(requestedPoints, subtotal - discountAmount);
  }

  // Calculate total
  const totalAmount = Math.max(0, subtotal - discountAmount - pointsDiscountAmount);

  // Create order
  const orderNumber = generateOrderNumber();
  const result = await db.createOrder({
    userId: userIdNum,
    orderNumber,
    subtotal: subtotal.toString(),
    discountAmount: discountAmount.toString(),
    pointsDiscountAmount: pointsDiscountAmount.toString(),
    totalAmount: totalAmount.toString(),
    couponCodeSnapshot: normalizedCouponCode,
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

  // Create payment record for the order
  await db.createPayment(orderId);

  // Fetch and return the full order object
  const fullOrder = await db.getOrderById(orderId);
  if (!fullOrder) {
    throw new Error("Failed to fetch created order");
  }
  return fullOrder;
}

/**
 * Approve payment and create purchases
 */
export async function approvePayment(paymentId: number, approvedBy: string): Promise<{ message: string }> {
  const payment = await db.getPaymentById(paymentId);
  if (!payment) {
    throw new Error("Payment not found");
  }

  const order = await db.getOrderById(payment.orderId);
  if (!order) {
    throw new Error("Order not found");
  }

  // Update payment status with reviewer info
  await db.updatePayment(paymentId, {
    status: "approved",
  });
  // Also set reviewedByUserId and reviewedAt via db.approvePayment
  const approvedByNum = parseInt(approvedBy, 10);
  if (!isNaN(approvedByNum)) {
    await db.approvePayment(paymentId, approvedByNum);
  }

  // Update order status and payment status
  await db.updateOrder(order.id, { 
    status: "approved",
    paymentStatus: "approved"
  });

  // Record order history
  await db.recordOrderHistory({
    orderId: order.id,
    action: "payment_approved",
    fromStatus: order.status,
    toStatus: "approved",
    actorUserId: approvedByNum || undefined,
    note: "Payment approved by admin",
  });

  // Create purchase records
  const orderItems = await db.getOrderItems(order.id);
  for (const item of orderItems) {
    // getOrderItems already enriches with episode data; use item.episode if available
    const episode = (item as any).episode || await db.getEpisodeById(item.episodeId);
    if (episode && order.userId) {
      // Idempotent: skip if already purchased
      const existing = await db.getPurchaseByUserAndEpisode(order.userId, item.episodeId);
      if (!existing) {
        await db.createPurchase(order.userId, episode.novelId, item.episodeId, order.id);
      }
    }
  }

  // Deduct redeemed points from user balance if points were used
  const pointsDiscountNum = parseFloat(order.pointsDiscountAmount?.toString() || "0");
  if (order.userId && pointsDiscountNum > 0) {
    const currentBalanceStr = await db.getUserPointsBalance(order.userId);
    const currentBalance = parseFloat(currentBalanceStr);
    const newBalance = Math.max(0, currentBalance - pointsDiscountNum);
    await db.recordPointsTransaction({
      userId: order.userId,
      type: "redeem",
      amount: pointsDiscountNum.toString(),
      balanceAfter: newBalance.toFixed(2),
      referenceType: "order",
      referenceId: order.id,
      note: `Points redeemed for order ${order.orderNumber}`,
    });
  }

  // Award loyalty points once purchases are finalized
  if (order.userId) {
    await awardPointsForOrder(order.id, order.userId, order.totalAmount.toString());
  }

  // Increment coupon usage count if coupon was used
  if (order.couponCodeSnapshot) {
    const coupon = await db.getCouponByCode(order.couponCodeSnapshot);
    if (coupon) {
      await db.recordCouponUsage(coupon.id, order.userId || undefined, order.id);
    }
  }

  return { message: `Payment ${paymentId} approved successfully` };
}

/**
 * Award loyalty points for a completed order
 * 100 currency units = 1 point
 * Only awards once per order (idempotent)
 */
async function awardPointsForOrder(orderId: number, userId: number, amount: string): Promise<void> {
  // Check if points already awarded for this order
  const alreadyAwarded = await db.hasPointsBeenAwardedForOrder(orderId);
  if (alreadyAwarded) {
    console.log(`Points already awarded for order ${orderId}, skipping`);
    return;
  }

  // Calculate points: 100 currency units = 1 point
  const amountNum = parseFloat(amount);
  const pointsToAward = Math.floor(amountNum / 100);

  if (pointsToAward <= 0) {
    console.log(`Order ${orderId} amount ${amount} is too small to award points`);
    return;
  }

  // Get current balance
  const currentBalance = await db.getUserPointsBalance(userId);
  const currentBalanceNum = parseFloat(currentBalance);
  const newBalance = (currentBalanceNum + pointsToAward).toFixed(2);

  // Record the transaction
  await db.recordPointsTransaction({
    userId,
    type: "earn",
    amount: pointsToAward.toString(),
    balanceAfter: newBalance,
    referenceType: "order",
    referenceId: orderId,
    note: `Points earned from order ${orderId}`,
  });
}

/**
 * Reject payment
 */
export async function rejectPayment(paymentId: number, rejectedBy: string, reason: string): Promise<void> {
  const payment = await db.getPaymentById(paymentId);
  if (!payment) {
    throw new Error("Payment not found");
  }

  const rejectedByNum = parseInt(rejectedBy, 10);

  // Update payment status with rejection reason and reviewer info
  await db.updatePayment(paymentId, {
    status: "rejected",
    rejectionReason: reason,
  });
  // Set reviewedByUserId and reviewedAt
  if (!isNaN(rejectedByNum)) {
    await db.rejectPayment(paymentId, rejectedByNum, reason);
  }

  // Update order status and payment status
  const order = await db.getOrderById(payment.orderId);
  if (order) {
    await db.updateOrder(order.id, { 
      status: "rejected",
      paymentStatus: "rejected",
      notes: reason
    });

    // Record order history
    await db.recordOrderHistory({
      orderId: order.id,
      action: "payment_rejected",
      fromStatus: order.status,
      toStatus: "rejected",
      actorUserId: rejectedByNum || undefined,
      note: reason,
    });
  }
}

/**
 * Calculate how many points a user can redeem for a given order amount
 * Redemption rate: 1 point = 1 currency unit (1:1 ratio)
 * Users can redeem up to their full balance, capped at the order subtotal
 */
export async function calculatePointsRedemption(
  userId: number,
  subtotal: string
): Promise<{ pointsToRedeem: number; pointsDiscount: string }> {
  const balance = await db.getUserPointsBalance(userId);
  const balanceNum = parseFloat(balance || "0");
  const subtotalNum = parseFloat(subtotal);

  // Cap redemption at the lower of balance or subtotal
  const pointsToRedeem = Math.min(Math.floor(balanceNum), Math.floor(subtotalNum));
  const pointsDiscount = pointsToRedeem.toFixed(2);

  return { pointsToRedeem, pointsDiscount };
}
