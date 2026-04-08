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
export async function validateAndApplyCoupon(couponCode: string, subtotal: string, tx?: any): Promise<{ discountAmount: string; coupon: any; normalizedCode?: string }> {
  // Normalize coupon code: trim and uppercase for consistent lookup
  const normalizedCode = String(couponCode || "").trim().toUpperCase();
  const coupon = await db.getCouponByCode(normalizedCode, tx);

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
  tx?: any
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
    const { discountAmount: discount, normalizedCode } = await validateAndApplyCoupon(couponCode, subtotal.toString(), tx);
    discountAmount = parseFloat(discount);
    normalizedCouponCode = normalizedCode;
  }

  // Apply points redemption if provided
  let pointsDiscountAmount = 0;
  const userIdNum = parseInt(userId);
  if (pointsToRedeem && parseFloat(pointsToRedeem) > 0) {
    const requestedPoints = parseFloat(pointsToRedeem);
    // Validate user has enough points
    const balanceStr = await db.getUserPointsBalance(userIdNum, tx);
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
export async function approvePayment(paymentId: number, approvedBy: string, tx?: any): Promise<{ message: string }> {
  const payment = await db.getPaymentById(paymentId, tx);
  if (!payment) {
    throw new Error("Payment not found");
  }

  const order = await db.getOrderById(payment.orderId, tx);
  if (!order) {
    throw new Error("Order not found");
  }

  // Update payment status with reviewer info
  await db.updatePayment(paymentId, {
    status: "approved",
  }, tx);
  // Also set reviewedByUserId and reviewedAt via db.approvePayment
  const approvedByNum = parseInt(approvedBy, 10);
  if (!isNaN(approvedByNum)) {
    await db.approvePayment(paymentId, approvedByNum, tx);
  }

  // Update order status and payment status
  await db.updateOrder(order.id, { 
    status: "approved",
    paymentStatus: "approved"
  }, tx);

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
  const pointsDiscountNum = parseFloat(order.pointsDiscountAmount?.toString() || "0");
  if (pointsDiscountNum > 0) {
    const alreadyDeducted = await db.hasPointsBeenRedeemedForOrder(orderId, tx);
    if (!alreadyDeducted) {
      const currentBalanceStr = await db.getUserPointsBalance(userId, tx);
      const currentBalance = parseFloat(currentBalanceStr);
      const newBalance = Math.max(0, currentBalance - pointsDiscountNum);
      await db.recordPointsTransaction({
        userId,
        type: "redeem",
        amount: pointsDiscountNum.toString(),
        balanceAfter: newBalance.toFixed(2),
        referenceType: "order",
        referenceId: orderId,
        note: `Points redeemed for order ${order.orderNumber}`,
      }, tx);
    }
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
    }
  }
}

/**
 * Award loyalty points for a completed order
 * 100 currency units = 1 point
 * Only awards once per order (idempotent)
 */
async function awardPointsForOrder(orderId: number, userId: number, amount: string, tx?: any): Promise<void> {
  // Check if points already awarded for this order
  const alreadyAwarded = await db.hasPointsBeenAwardedForOrder(orderId, tx);
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
  const currentBalance = await db.getUserPointsBalance(userId, tx);
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
  }, tx);
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

  // Update payment status with rejection reason and reviewer info
  await db.updatePayment(paymentId, {
    status: "rejected",
    rejectionReason: reason,
  }, tx);
  // Set reviewedByUserId and reviewedAt
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
  const balanceNum = parseFloat(balance || "0");
  const subtotalNum = parseFloat(subtotal);

  // Cap redemption at the lower of balance or subtotal
  const pointsToRedeem = Math.min(Math.floor(balanceNum), Math.floor(subtotalNum));
  const pointsDiscount = pointsToRedeem.toFixed(2);

  return { pointsToRedeem, pointsDiscount };
}


/**
 * Central approval/finalization service for both auto and manual approvals
 * Ensures both paths run identical finalization logic
 * Persists approval source (auto vs manual) with admin identity
 */
export async function approvePaymentWithSource(
  paymentId: number,
  approvalSource: "auto" | "manual" | "wallet",
  approvedByAdminId?: number,
  approvedByAdminName?: string,
  tx?: any
): Promise<{ message: string }> {
  const payment = await db.getPaymentById(paymentId, tx);
  if (!payment) {
    throw new Error("Payment not found");
  }

  const order = await db.getOrderById(payment.orderId, tx);
  if (!order) {
    throw new Error("Order not found");
  }

  // Determine approval label based on source
  let approvedByLabel = "Manual";
  if (approvalSource === "auto") {
    approvedByLabel = "AutoApp";
  } else if (approvalSource === "wallet") {
    approvedByLabel = "Wallet";
  } else if (approvalSource === "manual" && approvedByAdminName) {
    approvedByLabel = approvedByAdminName;
  }

  const now = new Date();

  // Update payment with approval source and finalization info
  await db.updatePayment(paymentId, {
    status: "approved",
    approvalSource,
    approvedByAdminId: approvedByAdminId || null,
    approvedByLabel,
    approvedAt: now,
  }, tx);

  // Update order status
  await db.updateOrder(order.id, {
    status: "approved",
    paymentStatus: "approved",
  }, tx);

  // Record order history
  let historyNote: string;
  if (approvalSource === "auto") {
    historyNote = "Payment auto-approved via OCR verification";
  } else if (approvalSource === "wallet") {
    historyNote = "Payment approved via wallet payment";
  } else {
    historyNote = `Payment approved by admin: ${approvedByLabel}`;
  }

  await db.recordOrderHistory({
    orderId: order.id,
    action: "payment_approved",
    fromStatus: order.status,
    toStatus: "approved",
    actorUserId: approvedByAdminId || 0,
    note: historyNote,
  }, tx);

  // Finalize order completion (grant entitlements, award points, record coupon usage)
  if (order.userId) {
    await finalizeOrderCompletion(order.id, order.userId, tx);
  }

  return { message: `Payment ${paymentId} approved successfully` };
}
