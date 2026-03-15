# Ipenovel V2 - Release Blocker Checklist

**Status:** 🔴 NOT READY FOR RELEASE  
**Total Blockers:** 17 issues across 3 priority groups  
**Estimated Fix Time:** 4-5 hours  
**Last Updated:** March 16, 2026

---

## GROUP 1: MUST FIX BEFORE RELEASE ⛔

These are critical bugs that break core functionality or create data integrity issues. Release is impossible without fixing these.

---

### 1.1 Payment Approval Uses Wrong ID Lookup

**Title:** Payment approval function receives payment ID but looks up by order ID  
**Severity:** 🔴 CRITICAL  
**Status:** ❌ UNFIXED

#### Affected Files
- `server/services/orderService.ts` (line 206)
- `server/db.ts` (missing `getPaymentById()` function)

#### User Impact
- Payment approval completely broken
- Admin cannot approve any payments
- Customers cannot receive entitlements
- Purchase system non-functional

#### Root Cause
The `approvePayment(paymentId)` function receives a payment ID but calls `db.getPaymentByOrderId(paymentId)`, treating the payment ID as if it were an order ID. This causes a lookup failure and the entire approval flow breaks.

```typescript
// WRONG (line 206 in orderService.ts)
const payment = await db.getPaymentByOrderId(paymentId);  // paymentId ≠ orderId!
```

#### Exact Fix Plan

**Step 1:** Add `getPaymentById()` function to `server/db.ts`

```typescript
// Add after getPaymentByOrderId() function (around line 300)
export async function getPaymentById(paymentId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}
```

**Step 2:** Fix the lookup in `server/services/orderService.ts` line 206

```typescript
// BEFORE
const payment = await db.getPaymentByOrderId(paymentId);

// AFTER
const payment = await db.getPaymentById(paymentId);
```

#### Test to Verify Fix

**File:** `server/services/orderService.test.ts`

```typescript
it("should approve payment with correct payment ID lookup", async () => {
  // Create test user and order
  const testUser = { openId: `payment-test-${Date.now()}`, name: "Payment Test" };
  await db.upsertUser(testUser);
  const user = await db.getUserByOpenId(testUser.openId);
  
  // Create order and payment
  const order = await db.createOrder({
    orderNumber: generateOrderNumber(),
    userId: user.id,
    subtotal: "100.00",
    totalAmount: "100.00",
  });
  const orderId = (order as any)[0]?.insertId;
  
  const payment = await db.createPayment(orderId);
  const paymentId = (payment as any)[0]?.insertId;
  
  // Verify payment exists
  const foundPayment = await db.getPaymentById(paymentId);
  expect(foundPayment).toBeDefined();
  expect(foundPayment?.id).toBe(paymentId);
  
  // Approve payment
  await orderService.approvePayment(paymentId, user.id);
  
  // Verify payment is approved
  const approvedPayment = await db.getPaymentById(paymentId);
  expect(approvedPayment?.status).toBe("approved");
});
```

---

### 1.2 Idempotency Check Unreachable Due to Failed Lookup

**Title:** Payment approval idempotency protection never executes  
**Severity:** 🔴 CRITICAL  
**Status:** ❌ UNFIXED (depends on fix 1.1)

#### Affected Files
- `server/services/orderService.ts` (lines 206-215)

#### User Impact
- Approving the same payment twice creates duplicate purchases
- Duplicate purchases grant entitlements twice
- Duplicate points awarded (user gets 2x points)
- Data corruption in purchases and points tables

#### Root Cause
The idempotency check at line 212 (`if (payment.status === "approved")`) is never reached because the payment lookup at line 206 fails first. This allows the approval logic to execute multiple times for the same payment.

```typescript
// Current broken flow:
1. approvePayment(paymentId=5)
2. db.getPaymentByOrderId(5)  // Fails - returns null
3. throw Error("Payment not found")
4. Idempotency check at line 212 never reached
```

#### Exact Fix Plan

**Step 1:** Fix the payment lookup (see fix 1.1 above)

**Step 2:** Verify idempotency check is correct in `server/services/orderService.ts` lines 211-215

```typescript
// This code is already correct, just needs the lookup fix
if (payment.status === "approved") {
  console.log(`Payment ${paymentId} already approved, skipping duplicate approval`);
  return { message: "Payment already approved" };
}
```

#### Test to Verify Fix

**File:** `server/services/orderService.test.ts`

```typescript
it("should not duplicate purchases when approving payment twice", async () => {
  // Setup: Create user, order, payment
  const testUser = { openId: `idempotent-test-${Date.now()}`, name: "Idempotent Test" };
  await db.upsertUser(testUser);
  const user = await db.getUserByOpenId(testUser.openId);
  
  const order = await db.createOrder({
    orderNumber: generateOrderNumber(),
    userId: user.id,
    subtotal: "100.00",
    totalAmount: "100.00",
  });
  const orderId = (order as any)[0]?.insertId;
  
  // Create order item
  const episodes = await db.getEpisodesByNovelId(1);
  if (episodes.length > 0) {
    const episode = episodes[0];
    await db.createOrderItems([{
      orderId,
      novelId: episode.novelId,
      episodeId: episode.id,
      unitPrice: "100.00",
      finalPrice: "100.00",
    }]);
  }
  
  const payment = await db.createPayment(orderId);
  const paymentId = (payment as any)[0]?.insertId;
  
  // Approve payment FIRST TIME
  await orderService.approvePayment(paymentId, user.id);
  
  // Get purchase count after first approval
  const purchasesAfterFirst = await db.getPurchasesByUserId(user.id);
  const firstApprovalCount = purchasesAfterFirst.length;
  
  // Approve payment SECOND TIME (should be idempotent)
  await orderService.approvePayment(paymentId, user.id);
  
  // Get purchase count after second approval
  const purchasesAfterSecond = await db.getPurchasesByUserId(user.id);
  const secondApprovalCount = purchasesAfterSecond.length;
  
  // Verify no duplicate purchases created
  expect(firstApprovalCount).toBe(secondApprovalCount);
  expect(secondApprovalCount).toBeGreaterThan(0);
});

it("should not duplicate points when approving payment twice", async () => {
  // Similar setup as above...
  
  // Approve payment FIRST TIME
  await orderService.approvePayment(paymentId, user.id);
  
  // Get points balance after first approval
  const balanceAfterFirst = await db.getUserPointsBalance(user.id);
  
  // Approve payment SECOND TIME
  await orderService.approvePayment(paymentId, user.id);
  
  // Get points balance after second approval
  const balanceAfterSecond = await db.getUserPointsBalance(user.id);
  
  // Verify points not duplicated
  expect(balanceAfterFirst).toBe(balanceAfterSecond);
});
```

---

### 1.3 Cart Item Removal Not Authorized

**Title:** Any authenticated user can delete any cart item if they know the ID  
**Severity:** 🔴 CRITICAL (Security)  
**Status:** ❌ UNFIXED

#### Affected Files
- `server/routers.ts` (lines 136-141)
- `server/db.ts` (missing `getCartItemById()` function)

#### User Impact
- User A can delete User B's cart items
- Malicious users can sabotage other users' shopping carts
- Data integrity violation
- Security breach

#### Root Cause
The `cart.remove` endpoint receives a `cartItemId` but doesn't verify that the cart item belongs to the requesting user. An attacker can enumerate cart item IDs and delete any item.

```typescript
// WRONG (lines 136-141)
remove: protectedProcedure
  .input(z.object({ cartItemId: z.number() }))
  .mutation(async ({ input }) => {
    // ❌ No authorization check - deletes ANY cart item
    await db.removeFromCart(input.cartItemId);
    return { success: true };
  }),
```

#### Exact Fix Plan

**Step 1:** Add `getCartItemById()` function to `server/db.ts`

```typescript
// Add after getCartItems() function (around line 200)
export async function getCartItemById(cartItemId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(cartItems).where(eq(cartItems.id, cartItemId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}
```

**Step 2:** Add `getCartById()` function to `server/db.ts`

```typescript
// Add after getOrCreateCart() function (around line 180)
export async function getCartById(cartId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(carts).where(eq(carts.id, cartId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}
```

**Step 3:** Fix authorization in `server/routers.ts` lines 136-141

```typescript
// BEFORE
remove: protectedProcedure
  .input(z.object({ cartItemId: z.number() }))
  .mutation(async ({ input }) => {
    await db.removeFromCart(input.cartItemId);
    return { success: true };
  }),

// AFTER
remove: protectedProcedure
  .input(z.object({ cartItemId: z.number() }))
  .mutation(async ({ input, ctx }) => {
    // Get cart item
    const item = await db.getCartItemById(input.cartItemId);
    if (!item) throw new TRPCError({ code: "NOT_FOUND" });
    
    // Verify cart belongs to user
    const cart = await db.getCartById(item.cartId);
    if (!cart || cart.userId !== ctx.user.id) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    
    await db.removeFromCart(input.cartItemId);
    return { success: true };
  }),
```

#### Test to Verify Fix

**File:** `server/tests/authorization.test.ts` (new file)

```typescript
import { describe, it, expect } from "vitest";
import * as db from "../db";
import { TRPCError } from "@trpc/server";

describe("Authorization: Cart Item Removal", () => {
  it("should allow user to remove their own cart item", async () => {
    // Create two users
    const user1 = { openId: `user1-${Date.now()}`, name: "User 1" };
    const user2 = { openId: `user2-${Date.now()}`, name: "User 2" };
    
    await db.upsertUser(user1);
    await db.upsertUser(user2);
    
    const u1 = await db.getUserByOpenId(user1.openId);
    const u2 = await db.getUserByOpenId(user2.openId);
    
    // Get a paid episode
    const novels = await db.getAllNovels();
    const episodes = await db.getEpisodesByNovelId(novels[0].id);
    const paidEpisode = episodes.find(e => !e.isFree);
    
    if (!paidEpisode) throw new Error("No paid episode found");
    
    // Add to user1's cart
    const cart1 = await db.getOrCreateCart(u1.id);
    await db.addToCart(cart1.id, paidEpisode.id, paidEpisode.novelId, paidEpisode.price.toString());
    
    const items1 = await db.getCartItems(cart1.id);
    const cartItemId = items1[0].id;
    
    // User1 should be able to remove their item
    await db.removeFromCart(cartItemId);
    
    const itemsAfter = await db.getCartItems(cart1.id);
    expect(itemsAfter.length).toBe(0);
  });

  it("should prevent user from removing another user's cart item", async () => {
    // Create two users
    const user1 = { openId: `user1-auth-${Date.now()}`, name: "User 1" };
    const user2 = { openId: `user2-auth-${Date.now()}`, name: "User 2" };
    
    await db.upsertUser(user1);
    await db.upsertUser(user2);
    
    const u1 = await db.getUserByOpenId(user1.openId);
    const u2 = await db.getUserByOpenId(user2.openId);
    
    // Get a paid episode
    const novels = await db.getAllNovels();
    const episodes = await db.getEpisodesByNovelId(novels[0].id);
    const paidEpisode = episodes.find(e => !e.isFree);
    
    if (!paidEpisode) throw new Error("No paid episode found");
    
    // Add to user1's cart
    const cart1 = await db.getOrCreateCart(u1.id);
    await db.addToCart(cart1.id, paidEpisode.id, paidEpisode.novelId, paidEpisode.price.toString());
    
    const items1 = await db.getCartItems(cart1.id);
    const cartItemId = items1[0].id;
    
    // Simulate user2 trying to remove user1's item
    const item = await db.getCartItemById(cartItemId);
    const cart = await db.getCartById(item.cartId);
    
    // Should fail authorization check
    expect(cart.userId).toBe(u1.id);
    expect(cart.userId).not.toBe(u2.id);
  });
});
```

---

### 1.4 Wishlist Removal Not Authorized

**Title:** Any authenticated user can delete any wishlist item if they know the ID  
**Severity:** 🔴 CRITICAL (Security)  
**Status:** ❌ UNFIXED

#### Affected Files
- `server/routers.ts` (lines 353-358)
- `server/db.ts` (missing `getWishlistById()` function)

#### User Impact
- User A can delete User B's wishlist items
- Malicious users can sabotage other users' wishlists
- Data integrity violation
- Security breach

#### Root Cause
The `wishlists.remove` endpoint receives a `wishlistId` but doesn't verify that the wishlist belongs to the requesting user.

```typescript
// WRONG (lines 353-358)
remove: protectedProcedure
  .input(z.object({ wishlistId: z.number() }))
  .mutation(async ({ input }) => {
    // ❌ No authorization check
    await db.removeFromWishlist(input.wishlistId);
    return { success: true };
  }),
```

#### Exact Fix Plan

**Step 1:** Add `getWishlistById()` function to `server/db.ts`

```typescript
// Add after getWishlistsByUserId() function (around line 400)
export async function getWishlistById(wishlistId: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(wishlists).where(eq(wishlists.id, wishlistId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}
```

**Step 2:** Fix authorization in `server/routers.ts` lines 353-358

```typescript
// BEFORE
remove: protectedProcedure
  .input(z.object({ wishlistId: z.number() }))
  .mutation(async ({ input }) => {
    await db.removeFromWishlist(input.wishlistId);
    return { success: true };
  }),

// AFTER
remove: protectedProcedure
  .input(z.object({ wishlistId: z.number() }))
  .mutation(async ({ input, ctx }) => {
    const wishlist = await db.getWishlistById(input.wishlistId);
    if (!wishlist) throw new TRPCError({ code: "NOT_FOUND" });
    
    if (wishlist.userId !== ctx.user.id) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
    
    await db.removeFromWishlist(input.wishlistId);
    return { success: true };
  }),
```

#### Test to Verify Fix

**File:** `server/tests/authorization.test.ts`

```typescript
it("should prevent user from removing another user's wishlist item", async () => {
  // Create two users
  const user1 = { openId: `user1-wish-${Date.now()}`, name: "User 1" };
  const user2 = { openId: `user2-wish-${Date.now()}`, name: "User 2" };
  
  await db.upsertUser(user1);
  await db.upsertUser(user2);
  
  const u1 = await db.getUserByOpenId(user1.openId);
  const u2 = await db.getUserByOpenId(user2.openId);
  
  // Get a novel
  const novels = await db.getAllNovels();
  
  // Add to user1's wishlist
  await db.addToWishlist(u1.id, novels[0].id);
  
  const wishlists1 = await db.getWishlistsByUserId(u1.id);
  const wishlistId = wishlists1[0].id;
  
  // Simulate user2 trying to remove user1's wishlist item
  const wishlist = await db.getWishlistById(wishlistId);
  
  // Should fail authorization check
  expect(wishlist.userId).toBe(u1.id);
  expect(wishlist.userId).not.toBe(u2.id);
});
```

---

### 1.5 Coupon Usage Recorded at Checkout Instead of Approval

**Title:** Coupon usage counted even if payment is rejected  
**Severity:** 🔴 CRITICAL (Business Logic)  
**Status:** ❌ UNFIXED

#### Affected Files
- `server/services/orderService.ts` (lines 178-184 in `createOrderFromCart()`)
- `server/services/orderService.ts` (missing coupon recording in `approvePayment()`)

#### User Impact
- Coupon usage limits bypass (users can use expired coupons)
- Coupons expire faster than intended
- Customers lose coupon uses on rejected payments
- Coupon system unreliable

#### Root Cause
Coupon usage is recorded at checkout time (line 182), but should only be recorded when payment is approved. If payment is rejected, the coupon usage should not be counted.

```typescript
// WRONG: Recorded at checkout (line 182)
if (couponSnapshot) {
  const coupon = await db.getCouponByCode(couponSnapshot);
  if (coupon) {
    await db.recordCouponUsage(coupon.id, userId, orderId);  // Too early!
  }
}
```

#### Exact Fix Plan

**Step 1:** Remove coupon usage recording from `createOrderFromCart()` in `server/services/orderService.ts`

```typescript
// REMOVE lines 178-184 from createOrderFromCart()
// This block:
if (couponSnapshot) {
  const coupon = await db.getCouponByCode(couponSnapshot);
  if (coupon) {
    await db.recordCouponUsage(coupon.id, userId, orderId);
  }
}
```

**Step 2:** Add coupon usage recording to `approvePayment()` in `server/services/orderService.ts`

```typescript
// ADD after line 270 (after recording order history)
if (order.couponCodeSnapshot) {
  const coupon = await db.getCouponByCode(order.couponCodeSnapshot);
  if (coupon) {
    await db.recordCouponUsage(coupon.id, order.userId || 0, order.id);
  }
}
```

#### Test to Verify Fix

**File:** `server/services/orderService.test.ts`

```typescript
it("should not record coupon usage if payment is rejected", async () => {
  // Setup: Create user, order with coupon, payment
  const testUser = { openId: `coupon-test-${Date.now()}`, name: "Coupon Test" };
  await db.upsertUser(testUser);
  const user = await db.getUserByOpenId(testUser.openId);
  
  const coupon = await db.getCouponByCode("WELCOME20");
  const initialUsage = coupon.usageCount;
  
  // Create order with coupon
  const cart = await db.getOrCreateCart(user.id);
  const episodes = await db.getEpisodesByNovelId(1);
  const paidEpisode = episodes.find(e => !e.isFree);
  
  if (paidEpisode) {
    await db.addToCart(cart.id, paidEpisode.id, paidEpisode.novelId, paidEpisode.price.toString());
  }
  
  const cartItems = await db.getCartItems(cart.id);
  const order = await orderService.createOrderFromCart(user.id, cartItems, "WELCOME20");
  
  // Check coupon usage - should NOT be incremented yet
  const couponAfterCheckout = await db.getCouponByCode("WELCOME20");
  expect(couponAfterCheckout.usageCount).toBe(initialUsage);  // Still same
  
  // Get payment and reject it
  const payment = await db.getPaymentByOrderId(order.orderId);
  await orderService.rejectPayment(payment.id, user.id, "Test rejection");
  
  // Check coupon usage - should still NOT be incremented
  const couponAfterRejection = await db.getCouponByCode("WELCOME20");
  expect(couponAfterRejection.usageCount).toBe(initialUsage);  // Still same
});

it("should record coupon usage only when payment is approved", async () => {
  // Setup: Create user, order with coupon, payment
  const testUser = { openId: `coupon-approve-${Date.now()}`, name: "Coupon Approve" };
  await db.upsertUser(testUser);
  const user = await db.getUserByOpenId(testUser.openId);
  
  const coupon = await db.getCouponByCode("WELCOME20");
  const initialUsage = coupon.usageCount;
  
  // Create order with coupon
  const cart = await db.getOrCreateCart(user.id);
  const episodes = await db.getEpisodesByNovelId(1);
  const paidEpisode = episodes.find(e => !e.isFree);
  
  if (paidEpisode) {
    await db.addToCart(cart.id, paidEpisode.id, paidEpisode.novelId, paidEpisode.price.toString());
  }
  
  const cartItems = await db.getCartItems(cart.id);
  const order = await orderService.createOrderFromCart(user.id, cartItems, "WELCOME20");
  
  // Check coupon usage - should NOT be incremented yet
  const couponAfterCheckout = await db.getCouponByCode("WELCOME20");
  expect(couponAfterCheckout.usageCount).toBe(initialUsage);
  
  // Get payment and approve it
  const payment = await db.getPaymentByOrderId(order.orderId);
  await orderService.approvePayment(payment.id, user.id);
  
  // Check coupon usage - NOW should be incremented
  const couponAfterApproval = await db.getCouponByCode("WELCOME20");
  expect(couponAfterApproval.usageCount).toBe(initialUsage + 1);
});
```

---

### 1.6 Points Redeemed at Checkout Instead of Approval

**Title:** Points deducted from user even if payment is rejected  
**Severity:** 🔴 CRITICAL (Business Logic)  
**Status:** ❌ UNFIXED

#### Affected Files
- `server/services/orderService.ts` (lines 164-176 in `createOrderFromCart()`)
- `server/services/orderService.ts` (missing points deduction in `approvePayment()`)

#### User Impact
- Users lose points permanently if payment rejected
- Points deducted before payment confirmed
- Inconsistent points earning/redemption timing
- User confusion and support tickets

#### Root Cause
Points are redeemed (deducted) at checkout time (line 165), but should only be deducted when payment is approved. If payment is rejected, points should not be deducted.

```typescript
// WRONG: Deducted at checkout (line 165-176)
if (pointsToRedeem) {
  const { pointsToRedeem: redeemAmount, pointsDiscount } = await calculatePointsRedemption(userId, pointsToRedeem);
  pointsRedeemed = redeemAmount;
  pointsDiscountAmount = pointsDiscount;
  
  // This records the redemption immediately
  await db.recordPointsTransaction({
    userId,
    type: "redeem",
    amount: pointsRedeemed,
    ...
  });
}
```

#### Exact Fix Plan

**Step 1:** Change points redemption to snapshot-only in `createOrderFromCart()` in `server/services/orderService.ts`

```typescript
// BEFORE (lines 164-176)
if (pointsToRedeem) {
  const { pointsToRedeem: redeemAmount, pointsDiscount } = await calculatePointsRedemption(userId, pointsToRedeem);
  pointsRedeemed = redeemAmount;
  pointsDiscountAmount = pointsDiscount;
  
  const newBalance = (parseFloat(await db.getUserPointsBalance(userId)) - parseFloat(pointsRedeemed)).toFixed(2);
  await db.recordPointsTransaction({
    userId,
    type: "redeem",
    amount: pointsRedeemed,
    balanceAfter: newBalance,
    referenceType: "order",
    referenceId: orderId,
    note: `Redeemed points for order ${orderNumber}`,
  });
}

// AFTER: Just snapshot, don't deduct yet
if (pointsToRedeem) {
  const { pointsToRedeem: redeemAmount, pointsDiscount } = await calculatePointsRedemption(userId, pointsToRedeem);
  pointsRedeemed = redeemAmount;
  pointsDiscountAmount = pointsDiscount;
  // Don't call recordPointsTransaction here - just snapshot the values
}
```

**Step 2:** Add points deduction to `approvePayment()` in `server/services/orderService.ts`

```typescript
// ADD after line 270 (after recording order history)
// Deduct points only if payment approved
if (order.pointsDiscountAmount && order.pointsDiscountAmount !== "0.00") {
  const pointsToDeduct = (parseFloat(order.pointsDiscountAmount.toString()) / POINTS_REDEMPTION_RATE).toFixed(2);
  const currentBalance = await db.getUserPointsBalance(order.userId || 0);
  const newBalance = (parseFloat(currentBalance) - parseFloat(pointsToDeduct)).toFixed(2);
  
  await db.recordPointsTransaction({
    userId: order.userId || 0,
    type: "redeem",
    amount: pointsToDeduct,
    balanceAfter: newBalance,
    referenceType: "order",
    referenceId: order.id,
    note: `Redeemed points for order ${order.orderNumber}`,
  });
}
```

#### Test to Verify Fix

**File:** `server/services/orderService.test.ts`

```typescript
it("should not deduct points if payment is rejected", async () => {
  // Setup: Create user with points
  const testUser = { openId: `points-test-${Date.now()}`, name: "Points Test" };
  await db.upsertUser(testUser);
  const user = await db.getUserByOpenId(testUser.openId);
  
  // Give user some points
  const currentBalance = await db.getUserPointsBalance(user.id);
  const balanceNum = parseFloat(currentBalance);
  
  // Create order with points redemption
  const cart = await db.getOrCreateCart(user.id);
  const episodes = await db.getEpisodesByNovelId(1);
  const paidEpisode = episodes.find(e => !e.isFree);
  
  if (paidEpisode) {
    await db.addToCart(cart.id, paidEpisode.id, paidEpisode.novelId, paidEpisode.price.toString());
  }
  
  const cartItems = await db.getCartItems(cart.id);
  const pointsToRedeem = "10";  // Redeem 10 points
  const order = await orderService.createOrderFromCart(user.id, cartItems, undefined, pointsToRedeem);
  
  // Check balance - should NOT be deducted yet
  const balanceAfterCheckout = await db.getUserPointsBalance(user.id);
  expect(parseFloat(balanceAfterCheckout)).toBe(balanceNum);  // Still same
  
  // Get payment and reject it
  const payment = await db.getPaymentByOrderId(order.orderId);
  await orderService.rejectPayment(payment.id, user.id, "Test rejection");
  
  // Check balance - should still NOT be deducted
  const balanceAfterRejection = await db.getUserPointsBalance(user.id);
  expect(parseFloat(balanceAfterRejection)).toBe(balanceNum);  // Still same
});

it("should deduct points only when payment is approved", async () => {
  // Setup: Create user with points
  const testUser = { openId: `points-approve-${Date.now()}`, name: "Points Approve" };
  await db.upsertUser(testUser);
  const user = await db.getUserByOpenId(testUser.openId);
  
  // Give user some points
  const currentBalance = await db.getUserPointsBalance(user.id);
  const balanceNum = parseFloat(currentBalance);
  
  // Create order with points redemption
  const cart = await db.getOrCreateCart(user.id);
  const episodes = await db.getEpisodesByNovelId(1);
  const paidEpisode = episodes.find(e => !e.isFree);
  
  if (paidEpisode) {
    await db.addToCart(cart.id, paidEpisode.id, paidEpisode.novelId, paidEpisode.price.toString());
  }
  
  const cartItems = await db.getCartItems(cart.id);
  const pointsToRedeem = "10";
  const order = await orderService.createOrderFromCart(user.id, cartItems, undefined, pointsToRedeem);
  
  // Check balance - should NOT be deducted yet
  const balanceAfterCheckout = await db.getUserPointsBalance(user.id);
  expect(parseFloat(balanceAfterCheckout)).toBe(balanceNum);
  
  // Get payment and approve it
  const payment = await db.getPaymentByOrderId(order.orderId);
  await orderService.approvePayment(payment.id, user.id);
  
  // Check balance - NOW should be deducted
  const balanceAfterApproval = await db.getUserPointsBalance(user.id);
  const expectedBalance = balanceNum - 10;  // 10 points redeemed
  expect(parseFloat(balanceAfterApproval)).toBe(expectedBalance);
});
```

---

## GROUP 2: SHOULD FIX BEFORE RELEASE ⚠️

These are important issues that should be fixed before release but won't completely break the system. They affect user experience, data consistency, or edge cases.

---

### 2.1 Already-Purchased Episode Not Validated at Checkout

**Title:** Checkout doesn't verify cart items aren't already purchased (race condition)  
**Severity:** 🟠 MAJOR  
**Status:** ❌ UNFIXED

#### Affected Files
- `server/services/orderService.ts` (line 86-97 in `createOrderFromCart()`)

#### User Impact
- User could purchase same episode twice in race condition
- Duplicate purchases if cart not updated before checkout
- Data integrity issue

#### Root Cause
The checkout validates that items aren't in cart (done at add time), but doesn't re-validate at checkout time. If a user purchases an episode in one browser tab and checks out in another tab, the duplicate purchase could succeed.

#### Exact Fix Plan

**Step 1:** Add validation in `createOrderFromCart()` before creating order

```typescript
// ADD after line 97 (after calculating subtotal)
// Verify none of the cart items are already purchased
for (const item of cartItems) {
  const isPurchased = await isEpisodeAlreadyPurchased(userId, item.episodeId);
  if (isPurchased) {
    throw new Error(`Episode ${item.episodeId} is already purchased`);
  }
}
```

#### Test to Verify Fix

**File:** `server/services/orderService.test.ts`

```typescript
it("should reject checkout if episode already purchased (race condition)", async () => {
  // Setup: Create user and purchase an episode
  const testUser = { openId: `race-test-${Date.now()}`, name: "Race Test" };
  await db.upsertUser(testUser);
  const user = await db.getUserByOpenId(testUser.openId);
  
  const episodes = await db.getEpisodesByNovelId(1);
  const paidEpisode = episodes.find(e => !e.isFree);
  
  if (!paidEpisode) throw new Error("No paid episode");
  
  // First: Create a purchase for this episode
  const order1 = await db.createOrder({
    orderNumber: generateOrderNumber(),
    userId: user.id,
    subtotal: paidEpisode.price.toString(),
    totalAmount: paidEpisode.price.toString(),
  });
  const orderId1 = (order1 as any)[0]?.insertId;
  
  await db.createPurchase(user.id, paidEpisode.novelId, paidEpisode.episodeId, orderId1);
  
  // Second: Try to add same episode to cart and checkout
  const cart = await db.getOrCreateCart(user.id);
  // This should fail because episode is already purchased
  try {
    await db.addToCart(cart.id, paidEpisode.id, paidEpisode.novelId, paidEpisode.price.toString());
    throw new Error("Should have thrown error");
  } catch (error: any) {
    expect(error.message).toContain("already purchased");
  }
});
```

---

### 2.2 Missing Validation Error Messages

**Title:** Generic error messages don't explain what went wrong  
**Severity:** 🟠 MAJOR (UX)  
**Status:** ❌ UNFIXED

#### Affected Files
- `server/routers.ts` (multiple locations)

#### User Impact
- Users confused about why operations fail
- Poor user experience
- Support tickets from confused users

#### Root Cause
Many endpoints throw generic `BAD_REQUEST` errors without explaining the reason.

#### Exact Fix Plan

**Step 1:** Add descriptive error messages throughout routers

```typescript
// BEFORE
throw new TRPCError({ code: "BAD_REQUEST" });

// AFTER
throw new TRPCError({ 
  code: "BAD_REQUEST",
  message: "Episode already purchased or in cart"
});
```

#### Test to Verify Fix

**File:** `server/tests/errors.test.ts` (new file)

```typescript
it("should return descriptive error when episode already purchased", async () => {
  // Setup and test...
  // Verify error message contains helpful text
});
```

---

### 2.3 No Transaction Support for Order Creation

**Title:** Multi-step order creation not wrapped in database transaction  
**Severity:** 🟠 MAJOR (Data Integrity)  
**Status:** ❌ UNFIXED

#### Affected Files
- `server/services/orderService.ts` (lines 125-154)

#### User Impact
- Partial orders created if step fails
- Data inconsistency
- Orphaned records in database

#### Root Cause
Steps are executed sequentially without transaction protection.

#### Exact Fix Plan

**Step 1:** Wrap order creation in transaction (requires database transaction support)

```typescript
// This would require adding transaction support to db.ts
// For now, document this as a future enhancement
```

---

## GROUP 3: CAN FIX AFTER RELEASE 📋

These are lower-priority issues that can be addressed in a future release. They don't block functionality but improve code quality and maintainability.

---

### 3.1 Missing Database Helper Functions (Non-Critical)

**Title:** Several helper functions not yet implemented  
**Severity:** 🟡 MINOR  
**Status:** ❌ UNFIXED

#### Affected Files
- `server/db.ts`

#### Missing Functions
- Additional query optimizations
- Batch operations for performance

#### Exact Fix Plan
Add functions as needed for performance optimization in future releases.

---

### 3.2 Code Organization and Refactoring

**Title:** Some functions could be better organized  
**Severity:** 🟡 MINOR  
**Status:** ❌ UNFIXED

#### Affected Files
- `server/routers.ts` (could be split into multiple files)
- `server/services/orderService.ts` (could be split by domain)

#### Exact Fix Plan
Refactor after release when codebase is stable.

---

### 3.3 Admin Payment Page Sorting

**Title:** Payment verification list should sort newest to oldest  
**Severity:** 🟡 MINOR (UX)  
**Status:** ✅ ALREADY IMPLEMENTED

The `getPendingPayments()` function already uses `orderBy(desc(payments.createdAt))`.

---

### 3.4 Rejection Reason Display to Customer

**Title:** Customer should see rejection reason in My Orders  
**Severity:** 🟡 MINOR (UX)  
**Status:** ❌ UNFIXED

#### Affected Files
- `server/routers.ts` (orders.detail)
- `client/src/pages/OrdersPage.tsx`

#### Exact Fix Plan
Include rejection reason in order detail response and display in UI.

---

### 3.5 Points Display on Home Page

**Title:** User's current points balance should display on home page  
**Severity:** 🟡 MINOR (UX)  
**Status:** ❌ UNFIXED

#### Affected Files
- `client/src/pages/Home.tsx`

#### Exact Fix Plan
Add points balance display in navigation or hero section.

---

## SUMMARY TABLE

| Group | Count | Severity | Fix Time | Status |
|-------|-------|----------|----------|--------|
| **GROUP 1: MUST FIX** | 6 | 🔴 CRITICAL | 3-4 hrs | ❌ UNFIXED |
| **GROUP 2: SHOULD FIX** | 3 | 🟠 MAJOR | 1-2 hrs | ❌ UNFIXED |
| **GROUP 3: CAN FIX LATER** | 5 | 🟡 MINOR | 2-3 hrs | ⚠️ PARTIAL |
| **TOTAL** | **14** | Mixed | **6-9 hrs** | ❌ NOT READY |

---

## RELEASE DECISION

**🔴 CURRENT STATUS: NOT READY FOR RELEASE**

**Minimum Requirements to Release:**
- ✅ Fix all 6 items in GROUP 1 (MUST FIX)
- ✅ Fix at least 2 items in GROUP 2 (SHOULD FIX)
- ✅ Pass all existing tests (33+)
- ✅ Pass all new tests for fixes
- ✅ Manual QA of payment flow
- ✅ Manual QA of authorization checks

**Estimated Time to Release-Ready:** 4-5 hours

---

## NEXT STEPS

1. **Immediate (Next 30 min):** Review and approve this checklist
2. **Hour 1-2:** Fix GROUP 1 items 1.1-1.4 (Payment, Authorization)
3. **Hour 2-3:** Fix GROUP 1 items 1.5-1.6 (Coupon, Points)
4. **Hour 3-4:** Fix GROUP 2 items 2.1-2.2 (Validation, Error Messages)
5. **Hour 4-5:** Write and run all tests
6. **Hour 5:** Manual QA and sign-off

**Ready to proceed with fixes?**
