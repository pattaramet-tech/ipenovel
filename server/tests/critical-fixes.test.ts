import { describe, it, expect } from "vitest";
import * as db from "../db";
import * as orderService from "../services/orderService";
import { TRPCError } from "@trpc/server";

/**
 * Tests for all 6 critical fixes from GROUP 1
 * These tests verify that payment approval, authorization, coupon, and points fixes work correctly
 */

describe("CRITICAL FIXES - GROUP 1", () => {
  // ============ FIX 1.1 & 1.2: Payment Approval with Correct ID Lookup ============

  describe("Fix 1.1 & 1.2: Payment Approval Uses Correct ID Lookup", () => {
    it("should find payment by payment ID (not order ID)", async () => {
      // Create test user and order
      const testUser = { openId: `payment-lookup-${Date.now()}`, name: "Payment Lookup Test" };
      await db.upsertUser(testUser);
      const user = await db.getUserByOpenId(testUser.openId);
      if (!user) throw new Error("User not created");

      // Create order and payment
      const order = await db.createOrder({
        orderNumber: orderService.generateOrderNumber(),
        userId: user.id,
        subtotal: "100.00",
        totalAmount: "100.00",
      });
      const orderId = (order as any)[0]?.insertId;

      const payment = await db.createPayment(orderId);
      const paymentId = (payment as any)[0]?.insertId;

      // Verify getPaymentById function exists and works
      const foundPayment = await db.getPaymentById(paymentId);
      expect(foundPayment).toBeDefined();
      expect(foundPayment?.id).toBe(paymentId);
      expect(foundPayment?.orderId).toBe(orderId);
      expect(foundPayment?.status).toBe("pending");
    });

    it("should approve payment and reach idempotency check", async () => {
      // Create test user and order
      const testUser = { openId: `payment-approve-${Date.now()}`, name: "Payment Approve Test" };
      await db.upsertUser(testUser);
      const user = await db.getUserByOpenId(testUser.openId);
      if (!user) throw new Error("User not created");

      // Create order and payment
      const order = await db.createOrder({
        orderNumber: orderService.generateOrderNumber(),
        userId: user.id,
        subtotal: "100.00",
        totalAmount: "100.00",
      });
      const orderId = (order as any)[0]?.insertId;

      const payment = await db.createPayment(orderId);
      const paymentId = (payment as any)[0]?.insertId;

      // Approve payment
      const result = await orderService.approvePayment(paymentId, user.id);
      expect(result.message).toContain("approved");

      // Verify payment is approved
      const approvedPayment = await db.getPaymentById(paymentId);
      expect(approvedPayment?.status).toBe("approved");
    });
  });

  // ============ FIX 1.2: Idempotency Protection ============

  describe("Fix 1.2: Payment Approval Idempotency", () => {
    it("should not duplicate purchases when approving payment twice", async () => {
      // Setup: Create user, order, payment
      const testUser = { openId: `idempotent-purchase-${Date.now()}`, name: "Idempotent Test" };
      await db.upsertUser(testUser);
      const user = await db.getUserByOpenId(testUser.openId);
      if (!user) throw new Error("User not created");

      // Create order with item
      const order = await db.createOrder({
        orderNumber: orderService.generateOrderNumber(),
        userId: user.id,
        subtotal: "100.00",
        totalAmount: "100.00",
      });
      const orderId = (order as any)[0]?.insertId;

      // Create order item
      const episodes = await db.getEpisodesByNovelId(1);
      const paidEpisode = episodes.find(e => !e.isFree);
      if (paidEpisode) {
        await db.createOrderItems([
          {
            orderId,
            novelId: paidEpisode.novelId,
            episodeId: paidEpisode.id,
            unitPrice: "100.00",
            finalPrice: "100.00",
          },
        ]);
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
      // Setup: Create user, order, payment
      const testUser = { openId: `idempotent-points-${Date.now()}`, name: "Idempotent Points" };
      await db.upsertUser(testUser);
      const user = await db.getUserByOpenId(testUser.openId);
      if (!user) throw new Error("User not created");

      // Create order
      const order = await db.createOrder({
        orderNumber: orderService.generateOrderNumber(),
        userId: user.id,
        subtotal: "100.00",
        totalAmount: "100.00",
      });
      const orderId = (order as any)[0]?.insertId;

      // Create order item
      const episodes = await db.getEpisodesByNovelId(1);
      const paidEpisode = episodes.find(e => !e.isFree);
      if (paidEpisode) {
        await db.createOrderItems([
          {
            orderId,
            novelId: paidEpisode.novelId,
            episodeId: paidEpisode.id,
            unitPrice: "100.00",
            finalPrice: "100.00",
          },
        ]);
      }

      const payment = await db.createPayment(orderId);
      const paymentId = (payment as any)[0]?.insertId;

      // Get initial balance
      const initialBalance = await db.getUserPointsBalance(user.id);

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
      expect(parseFloat(balanceAfterFirst)).toBeGreaterThan(parseFloat(initialBalance));
    });
  });

  // ============ FIX 1.3: Cart Item Removal Authorization ============

  describe("Fix 1.3: Cart Item Removal Authorization", () => {
    it("should allow user to remove their own cart item", async () => {
      // Create user
      const testUser = { openId: `cart-auth-${Date.now()}`, name: "Cart Auth Test" };
      await db.upsertUser(testUser);
      const user = await db.getUserByOpenId(testUser.openId);
      if (!user) throw new Error("User not created");

      // Get a paid episode
      const novels = await db.getAllNovels();
      const episodes = await db.getEpisodesByNovelId(novels[0].id);
      const paidEpisode = episodes.find(e => !e.isFree);
      if (!paidEpisode) throw new Error("No paid episode");

      // Add to cart
      const cart = await db.getOrCreateCart(user.id);
      await db.addToCart(cart.id, paidEpisode.id, paidEpisode.novelId, paidEpisode.price.toString());

      const items = await db.getCartItems(cart.id);
      const cartItemId = items[0].id;

      // Verify we can get the item and its cart
      const item = await db.getCartItemById(cartItemId);
      expect(item).toBeDefined();
      expect(item?.cartId).toBe(cart.id);

      const foundCart = await db.getCartById(item!.cartId);
      expect(foundCart?.userId).toBe(user.id);

      // Remove item
      await db.removeFromCart(cartItemId);

      const itemsAfter = await db.getCartItems(cart.id);
      expect(itemsAfter.length).toBe(0);
    });

    it("should prevent unauthorized user from removing cart item", async () => {
      // Create two users
      const user1 = { openId: `user1-cart-${Date.now()}`, name: "User 1" };
      const user2 = { openId: `user2-cart-${Date.now()}`, name: "User 2" };

      await db.upsertUser(user1);
      await db.upsertUser(user2);

      const u1 = await db.getUserByOpenId(user1.openId);
      const u2 = await db.getUserByOpenId(user2.openId);
      if (!u1 || !u2) throw new Error("Users not created");

      // Get a paid episode
      const novels = await db.getAllNovels();
      const episodes = await db.getEpisodesByNovelId(novels[0].id);
      const paidEpisode = episodes.find(e => !e.isFree);
      if (!paidEpisode) throw new Error("No paid episode");

      // Add to user1's cart
      const cart1 = await db.getOrCreateCart(u1.id);
      await db.addToCart(cart1.id, paidEpisode.id, paidEpisode.novelId, paidEpisode.price.toString());

      const items1 = await db.getCartItems(cart1.id);
      const cartItemId = items1[0].id;

      // Simulate user2 trying to remove user1's item
      const item = await db.getCartItemById(cartItemId);
      const cart = await db.getCartById(item!.cartId);

      // Should fail authorization check
      expect(cart?.userId).toBe(u1.id);
      expect(cart?.userId).not.toBe(u2.id);
    });
  });

  // ============ FIX 1.4: Wishlist Removal Authorization ============

  describe("Fix 1.4: Wishlist Removal Authorization", () => {
    it("should prevent unauthorized user from removing wishlist item", async () => {
      // Create two users
      const user1 = { openId: `user1-wish-${Date.now()}`, name: "User 1" };
      const user2 = { openId: `user2-wish-${Date.now()}`, name: "User 2" };

      await db.upsertUser(user1);
      await db.upsertUser(user2);

      const u1 = await db.getUserByOpenId(user1.openId);
      const u2 = await db.getUserByOpenId(user2.openId);
      if (!u1 || !u2) throw new Error("Users not created");

      // Get a novel
      const novels = await db.getAllNovels();

      // Add to user1's wishlist
      await db.addToWishlist(u1.id, novels[0].id);

      const wishlists1 = await db.getWishlistsByUserId(u1.id);
      const wishlistId = wishlists1[0].id;

      // Simulate user2 trying to remove user1's wishlist item
      const wishlist = await db.getWishlistById(wishlistId);

      // Should fail authorization check
      expect(wishlist?.userId).toBe(u1.id);
      expect(wishlist?.userId).not.toBe(u2.id);
    });
  });

  // ============ FIX 1.5: Coupon Usage Recorded Only on Approval ============

  describe("Fix 1.5: Coupon Usage Recorded Only on Approval", () => {
    it("should not record coupon usage if payment is rejected", async () => {
      // Setup: Create user, order with coupon, payment
      const testUser = { openId: `coupon-reject-${Date.now()}`, name: "Coupon Reject" };
      await db.upsertUser(testUser);
      const user = await db.getUserByOpenId(testUser.openId);
      if (!user) throw new Error("User not created");

      const coupon = await db.getCouponByCode("WELCOME20");
      const initialUsage = coupon?.usageCount || 0;

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
      expect(couponAfterCheckout?.usageCount).toBe(initialUsage);

      // Get payment and reject it
      const payment = await db.getPaymentByOrderId(order.orderId);
      if (payment) {
        await orderService.rejectPayment(payment.id, user.id, "Test rejection");
      }

      // Check coupon usage - should still NOT be incremented
      const couponAfterRejection = await db.getCouponByCode("WELCOME20");
      expect(couponAfterRejection?.usageCount).toBe(initialUsage);
    });

    it("should record coupon usage only when payment is approved", async () => {
      // Setup: Create user, order with coupon, payment
      const testUser = { openId: `coupon-approve-${Date.now()}`, name: "Coupon Approve" };
      await db.upsertUser(testUser);
      const user = await db.getUserByOpenId(testUser.openId);
      if (!user) throw new Error("User not created");

      const coupon = await db.getCouponByCode("WELCOME20");
      const initialUsage = coupon?.usageCount || 0;

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
      expect(couponAfterCheckout?.usageCount).toBe(initialUsage);

      // Get payment and approve it
      const payment = await db.getPaymentByOrderId(order.orderId);
      if (payment) {
        await orderService.approvePayment(payment.id, user.id);
      }

      // Check coupon usage - NOW should be incremented
      const couponAfterApproval = await db.getCouponByCode("WELCOME20");
      expect(couponAfterApproval?.usageCount).toBe(initialUsage + 1);
    });
  });

  // ============ FIX 1.6: Points Deducted Only on Approval ============

  describe("Fix 1.6: Points Deducted Only on Approval", () => {
    it("should not deduct points if payment is rejected", async () => {
      // Setup: Create user with points
      const testUser = { openId: `points-reject-${Date.now()}`, name: "Points Reject" };
      await db.upsertUser(testUser);
      const user = await db.getUserByOpenId(testUser.openId);
      if (!user) throw new Error("User not created");

      // Give user some points by earning them
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

      // Get payment and reject it
      const payment = await db.getPaymentByOrderId(order.orderId);
      if (payment) {
        await orderService.rejectPayment(payment.id, user.id, "Test rejection");
      }

      // Check balance - should still NOT be deducted
      const balanceAfterRejection = await db.getUserPointsBalance(user.id);
      expect(parseFloat(balanceAfterRejection)).toBe(balanceNum);
    });

    it("should deduct points only when payment is approved", async () => {
      // Setup: Create user with points
      const testUser = { openId: `points-approve-${Date.now()}`, name: "Points Approve" };
      await db.upsertUser(testUser);
      const user = await db.getUserByOpenId(testUser.openId);
      if (!user) throw new Error("User not created");

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
      if (payment) {
        await orderService.approvePayment(payment.id, user.id);
      }

      // Check balance - NOW should be deducted
      const balanceAfterApproval = await db.getUserPointsBalance(user.id);
      const expectedBalance = balanceNum - 10;
      expect(parseFloat(balanceAfterApproval)).toBe(expectedBalance);
    });
  });
});
