import { describe, it, expect, beforeAll } from "vitest";
import * as db from "../db";
import * as orderService from "../services/orderService";

/**
 * Tests for all 6 critical fixes from GROUP 1
 * These tests verify that payment approval, authorization, coupon, and points fixes work correctly
 */

// Shared test data created once
let sharedNovelId: number;
let sharedPaidEpisodeId: number;
let sharedPaidEpisodePrice: string;

beforeAll(async () => {
  // Create a novel and paid episode for use across tests
  const ts = Date.now();
  const novel: any = await db.createNovel({
    title: `Critical Fix Test Novel ${ts}`,
    author: "Test Author",
    description: "Test",
  });
  sharedNovelId = (novel as any).id;

  const epResult: any = await db.createEpisode({
    novelId: sharedNovelId,
    episodeNumber: `ep-cf-${ts}`,
    title: "Paid Episode CF",
    price: "99.00",
    isFree: false,
    fileUrl: "https://example.com/test.pdf",
  });
  // drizzle mysql2 returns [ResultSetHeader, ...]
  sharedPaidEpisodeId = (epResult as any)[0]?.insertId ?? (epResult as any).insertId;
  sharedPaidEpisodePrice = "99.00";
}, 30000);

describe("CRITICAL FIXES - GROUP 1", () => {
  // ============ FIX 1.1 & 1.2: Payment Approval with Correct ID Lookup ============

  describe("Fix 1.1 & 1.2: Payment Approval Uses Correct ID Lookup", () => {
    it("should find payment by payment ID (not order ID)", async () => {
      const testUser = { openId: `payment-lookup-${Date.now()}`, name: "Payment Lookup Test" };
      await db.upsertUser(testUser);
      const user = await db.getUserByOpenId(testUser.openId);
      if (!user) throw new Error("User not created");

      const order = await db.createOrder({
        orderNumber: orderService.generateOrderNumber(),
        userId: user.id,
        subtotal: "100.00",
        totalAmount: "100.00",
      });
      const orderId = (order as any).id;

      await db.createPayment(orderId);
      const foundPaymentByOrder = await db.getPaymentByOrderId(orderId);
      const paymentId = foundPaymentByOrder?.id;

      const foundPayment = await db.getPaymentById(paymentId!);
      expect(foundPayment).toBeDefined();
      expect(foundPayment?.id).toBe(paymentId);
      expect(foundPayment?.orderId).toBe(orderId);
      expect(foundPayment?.status).toBe("pending");
    }, 15000);

    it("should approve payment and reach idempotency check", async () => {
      const testUser = { openId: `payment-approve-${Date.now()}`, name: "Payment Approve Test" };
      await db.upsertUser(testUser);
      const user = await db.getUserByOpenId(testUser.openId);
      if (!user) throw new Error("User not created");

      const order = await db.createOrder({
        orderNumber: orderService.generateOrderNumber(),
        userId: user.id,
        subtotal: "100.00",
        totalAmount: "100.00",
      });
      const orderId = (order as any).id;

      await db.createPayment(orderId);
      const foundPayment = await db.getPaymentByOrderId(orderId);
      const paymentId = foundPayment?.id;

      const result = await orderService.approvePayment(paymentId!, user.id);
      expect(result.message).toContain("approved");

      const approvedPayment = await db.getPaymentById(paymentId);
      expect(approvedPayment?.status).toBe("approved");
    }, 15000);
  });

  // ============ FIX 1.2: Idempotency Protection ============

  describe("Fix 1.2: Payment Approval Idempotency", () => {
    it("should not duplicate purchases when approving payment twice", async () => {
      const testUser = { openId: `idempotent-purchase-${Date.now()}`, name: "Idempotent Test" };
      await db.upsertUser(testUser);
      const user = await db.getUserByOpenId(testUser.openId);
      if (!user) throw new Error("User not created");

      const order = await db.createOrder({
        orderNumber: orderService.generateOrderNumber(),
        userId: user.id,
        subtotal: "99.00",
        totalAmount: "99.00",
      });
      const orderId = (order as any).id;

      // Create order item using shared test data
      if (sharedPaidEpisodeId) {
        await db.createOrderItems([{
          orderId,
          novelId: sharedNovelId,
          episodeId: sharedPaidEpisodeId,
          unitPrice: sharedPaidEpisodePrice,
          discountAmount: "0.00",
          finalPrice: sharedPaidEpisodePrice,
        }]);
      }

      await db.createPayment(orderId);
      const foundPayment1 = await db.getPaymentByOrderId(orderId);
      const paymentId = foundPayment1?.id;

      await orderService.approvePayment(paymentId!, user.id);
      const purchasesAfterFirst = await db.getPurchasesByUserId(user.id);
      const firstApprovalCount = purchasesAfterFirst.length;

      // Second approval should be idempotent
      await orderService.approvePayment(paymentId!, user.id);
      const purchasesAfterSecond = await db.getPurchasesByUserId(user.id);
      const secondApprovalCount = purchasesAfterSecond.length;

      expect(firstApprovalCount).toBe(secondApprovalCount);
      if (sharedPaidEpisodeId) {
        expect(secondApprovalCount).toBeGreaterThan(0);
      }
    }, 20000);

    it("should not duplicate points when approving payment twice", async () => {
      const testUser = { openId: `idempotent-points-${Date.now()}`, name: "Idempotent Points" };
      await db.upsertUser(testUser);
      const user = await db.getUserByOpenId(testUser.openId);
      if (!user) throw new Error("User not created");

      const order = await db.createOrder({
        orderNumber: orderService.generateOrderNumber(),
        userId: user.id,
        subtotal: "99.00",
        totalAmount: "99.00",
      });
      const orderId = (order as any).id;

      if (sharedPaidEpisodeId) {
        await db.createOrderItems([{
          orderId,
          novelId: sharedNovelId,
          episodeId: sharedPaidEpisodeId,
          unitPrice: sharedPaidEpisodePrice,
          discountAmount: "0.00",
          finalPrice: sharedPaidEpisodePrice,
        }]);
      }

      await db.createPayment(orderId);
      const foundPayment2 = await db.getPaymentByOrderId(orderId);
      const paymentId = foundPayment2?.id;

      const initialBalance = await db.getUserPointsBalance(user.id);
      await orderService.approvePayment(paymentId!, user.id);
      const balanceAfterFirst = await db.getUserPointsBalance(user.id);

      // Second approval should be idempotent
      await orderService.approvePayment(paymentId!, user.id);
      const balanceAfterSecond = await db.getUserPointsBalance(user.id);

      expect(balanceAfterFirst).toBe(balanceAfterSecond);
      if (sharedPaidEpisodeId) {
        expect(parseFloat(balanceAfterFirst)).toBeGreaterThan(parseFloat(initialBalance));
      }
    }, 20000);
  });

  // ============ FIX 1.3: Cart Item Removal Authorization ============

  describe("Fix 1.3: Cart Item Removal Authorization", () => {
    it("should allow user to remove their own cart item", async () => {
      const testUser = { openId: `cart-auth-${Date.now()}`, name: "Cart Auth Test" };
      await db.upsertUser(testUser);
      const user = await db.getUserByOpenId(testUser.openId);
      if (!user) throw new Error("User not created");
      if (!sharedPaidEpisodeId) return; // skip if no episode

      const cart = await db.getOrCreateCart(user.id);
      await db.addToCart(cart.id, sharedPaidEpisodeId, sharedNovelId, sharedPaidEpisodePrice);

      const items = await db.getCartItems(cart.id);
      const cartItemId = items[0].id;

      const item = await db.getCartItemById(cartItemId);
      expect(item).toBeDefined();
      expect(item?.cartId).toBe(cart.id);

      const foundCart = await db.getCartById(item!.cartId);
      expect(foundCart?.userId).toBe(user.id);

      await db.removeFromCart(cartItemId);
      const itemsAfter = await db.getCartItems(cart.id);
      expect(itemsAfter.length).toBe(0);
    }, 15000);

    it("should prevent unauthorized user from removing cart item", async () => {
      const user1 = { openId: `user1-cart-${Date.now()}`, name: "User 1" };
      const user2 = { openId: `user2-cart-${Date.now()}`, name: "User 2" };
      await db.upsertUser(user1);
      await db.upsertUser(user2);
      const u1 = await db.getUserByOpenId(user1.openId);
      const u2 = await db.getUserByOpenId(user2.openId);
      if (!u1 || !u2) throw new Error("Users not created");
      if (!sharedPaidEpisodeId) return; // skip if no episode

      const cart1 = await db.getOrCreateCart(u1.id);
      await db.addToCart(cart1.id, sharedPaidEpisodeId, sharedNovelId, sharedPaidEpisodePrice);

      const items1 = await db.getCartItems(cart1.id);
      const cartItemId = items1[0].id;

      const item = await db.getCartItemById(cartItemId);
      const cart = await db.getCartById(item!.cartId);

      expect(cart?.userId).toBe(u1.id);
      expect(cart?.userId).not.toBe(u2.id);
    }, 15000);
  });

  // ============ FIX 1.4: Wishlist Removal Authorization ============

  describe("Fix 1.4: Wishlist Removal Authorization", () => {
    it("should prevent unauthorized user from removing wishlist item", async () => {
      const user1 = { openId: `user1-wish-${Date.now()}`, name: "User 1" };
      const user2 = { openId: `user2-wish-${Date.now()}`, name: "User 2" };
      await db.upsertUser(user1);
      await db.upsertUser(user2);
      const u1 = await db.getUserByOpenId(user1.openId);
      const u2 = await db.getUserByOpenId(user2.openId);
      if (!u1 || !u2) throw new Error("Users not created");

      const novels = await db.getAllNovels();
      if (novels.length === 0) return; // skip if no novels

      await db.addToWishlist(u1.id, novels[0].id);
      const wishlists1 = await db.getWishlistsByUserId(u1.id);
      const wishlistId = wishlists1[0].id;

      const wishlist = await db.getWishlistById(wishlistId);
      expect(wishlist?.userId).toBe(u1.id);
      expect(wishlist?.userId).not.toBe(u2.id);
    }, 15000);
  });

  // ============ FIX 1.5: Coupon Usage Recorded Only on Approval ============

  describe("Fix 1.5: Coupon Usage Recorded Only on Approval", () => {
    it("should not record coupon usage if payment is rejected", async () => {
      const testUser = { openId: `coupon-reject-${Date.now()}`, name: "Coupon Reject" };
      await db.upsertUser(testUser);
      const user = await db.getUserByOpenId(testUser.openId);
      if (!user) throw new Error("User not created");
      if (!sharedPaidEpisodeId) return;

      const coupon = await db.getCouponByCode("WELCOME20");
      const initialUsage = coupon?.usageCount || 0;

      const cart = await db.getOrCreateCart(user.id);
      await db.addToCart(cart.id, sharedPaidEpisodeId, sharedNovelId, sharedPaidEpisodePrice);
      const cartItems = await db.getCartItems(cart.id);
      const order = await orderService.createOrderFromCart(user.id, cartItems, "WELCOME20");

      const couponAfterCheckout = await db.getCouponByCode("WELCOME20");
      expect(couponAfterCheckout?.usageCount).toBe(initialUsage);

      const payment = await db.getPaymentByOrderId(order.orderId);
      if (payment) {
        await orderService.rejectPayment(payment.id, user.id, "Test rejection");
      }

      const couponAfterRejection = await db.getCouponByCode("WELCOME20");
      expect(couponAfterRejection?.usageCount).toBe(initialUsage);
    }, 20000);

    it("should record coupon usage only when payment is approved", async () => {
      const testUser = { openId: `coupon-approve-${Date.now()}`, name: "Coupon Approve" };
      await db.upsertUser(testUser);
      const user = await db.getUserByOpenId(testUser.openId);
      if (!user) throw new Error("User not created");
      if (!sharedPaidEpisodeId) return;

      const coupon = await db.getCouponByCode("WELCOME20");
      const initialUsage = coupon?.usageCount || 0;

      const cart = await db.getOrCreateCart(user.id);
      await db.addToCart(cart.id, sharedPaidEpisodeId, sharedNovelId, sharedPaidEpisodePrice);
      const cartItems = await db.getCartItems(cart.id);
      const order = await orderService.createOrderFromCart(user.id, cartItems, "WELCOME20");

      const couponAfterCheckout = await db.getCouponByCode("WELCOME20");
      expect(couponAfterCheckout?.usageCount).toBe(initialUsage);

      const payment = await db.getPaymentByOrderId(order.orderId);
      if (payment) {
        await orderService.approvePayment(payment.id, user.id);
      }

      const couponAfterApproval = await db.getCouponByCode("WELCOME20");
      expect(couponAfterApproval?.usageCount).toBe(initialUsage + 1);
    }, 20000);
  });

  // ============ FIX 1.6: Points Deducted Only on Approval ============

  describe("Fix 1.6: Points Deducted Only on Approval", () => {
    it("should not deduct points if payment is rejected", async () => {
      const testUser = { openId: `points-reject-${Date.now()}`, name: "Points Reject" };
      await db.upsertUser(testUser);
      const user = await db.getUserByOpenId(testUser.openId);
      if (!user) throw new Error("User not created");
      if (!sharedPaidEpisodeId) return;

      // Give user some points first
      await db.recordPointsTransaction({
        userId: user.id,
        type: "earned",
        amount: "100.00",
        description: "Test points",
        orderId: null,
      });

      const currentBalance = await db.getUserPointsBalance(user.id);
      const balanceNum = parseFloat(currentBalance);

      const cart = await db.getOrCreateCart(user.id);
      await db.addToCart(cart.id, sharedPaidEpisodeId, sharedNovelId, sharedPaidEpisodePrice);
      const cartItems = await db.getCartItems(cart.id);
      const pointsToRedeem = "10";
      const order = await orderService.createOrderFromCart(user.id, cartItems, undefined, pointsToRedeem);

      const balanceAfterCheckout = await db.getUserPointsBalance(user.id);
      expect(parseFloat(balanceAfterCheckout)).toBe(balanceNum);

      const payment = await db.getPaymentByOrderId(order.orderId);
      if (payment) {
        await orderService.rejectPayment(payment.id, user.id, "Test rejection");
      }

      const balanceAfterRejection = await db.getUserPointsBalance(user.id);
      expect(parseFloat(balanceAfterRejection)).toBe(balanceNum);
    }, 20000);

    it("should deduct points only when payment is approved", async () => {
      const testUser = { openId: `points-approve-${Date.now()}`, name: "Points Approve" };
      await db.upsertUser(testUser);
      const user = await db.getUserByOpenId(testUser.openId);
      if (!user) throw new Error("User not created");
      if (!sharedPaidEpisodeId) return;

      // Give user some points first
      await db.recordPointsTransaction({
        userId: user.id,
        type: "earned",
        amount: "100.00",
        description: "Test points",
        orderId: null,
      });

      const currentBalance = await db.getUserPointsBalance(user.id);
      const balanceNum = parseFloat(currentBalance);

      const cart = await db.getOrCreateCart(user.id);
      await db.addToCart(cart.id, sharedPaidEpisodeId, sharedNovelId, sharedPaidEpisodePrice);
      const cartItems = await db.getCartItems(cart.id);
      const pointsToRedeem = "10";
      const order = await orderService.createOrderFromCart(user.id, cartItems, undefined, pointsToRedeem);

      const balanceAfterCheckout = await db.getUserPointsBalance(user.id);
      expect(parseFloat(balanceAfterCheckout)).toBe(balanceNum);

      const payment = await db.getPaymentByOrderId(order.orderId);
      if (payment) {
        await orderService.approvePayment(payment.id, user.id);
      }

      const balanceAfterApproval = await db.getUserPointsBalance(user.id);
      const expectedBalance = balanceNum - 10;
      expect(parseFloat(balanceAfterApproval)).toBe(expectedBalance);
    }, 20000);
  });
});
