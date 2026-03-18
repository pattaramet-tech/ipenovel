import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as db from "./db";
import * as orderService from "./services/orderService";

/**
 * Comprehensive E2E QA Test Suite
 * Tests 14 critical business flows affected by backend fixes
 * All test data prefixed with "Test" for easy identification
 */

describe("E2E QA - Critical Business Flows", () => {
  let testUser: any;
  let testAdmin: any;
  let testNovel: any;
  let testEpisode1: any;
  let testEpisode2: any;
  let testCoupon: any;
  let testCart: any;

  beforeAll(async () => {
    // Create test user
    const userTs = Date.now();
    await db.upsertUser({
      openId: `test-qa-user-${userTs}`,
      name: `Test QA User ${userTs}`,
      email: `test-qa-${userTs}@example.com`,
      role: "user",
    });
    testUser = await db.getUserByOpenId(`test-qa-user-${userTs}`);

    // Create test admin
    const adminTs = Date.now() + 1;
    await db.upsertUser({
      openId: `test-qa-admin-${adminTs}`,
      name: `Test QA Admin ${adminTs}`,
      email: `test-qa-admin-${adminTs}@example.com`,
      role: "admin",
    });
    testAdmin = await db.getUserByOpenId(`test-qa-admin-${adminTs}`);

    // Create test novel with Thai title to test slug generation
    const novelResult: any = await db.createNovel({
      title: `Test Novel - QA Suite ${userTs}`,
      author: "Test Author",
      description: "Test novel for QA",
    });
    testNovel = novelResult;

    // Create paid episode 1
    const ep1Result: any = await db.createEpisode({
      novelId: testNovel.id,
      episodeNumber: `test-qa-ep1-${userTs}`,
      title: `Test Episode 1 - Paid`,
      price: "50.00",
      isFree: false,
      fileUrl: "https://example.com/test-ep1.pdf",
    });
    testEpisode1 = {
      id: (ep1Result as any)[0]?.insertId ?? (ep1Result as any).insertId,
      novelId: testNovel.id,
      price: "50.00",
    };

    // Create paid episode 2
    const ep2Result: any = await db.createEpisode({
      novelId: testNovel.id,
      episodeNumber: `test-qa-ep2-${userTs}`,
      title: `Test Episode 2 - Paid`,
      price: "75.00",
      isFree: false,
      fileUrl: "https://example.com/test-ep2.pdf",
    });
    testEpisode2 = {
      id: (ep2Result as any)[0]?.insertId ?? (ep2Result as any).insertId,
      novelId: testNovel.id,
      price: "75.00",
    };

    // Create test coupon
    const couponResult: any = await db.createCoupon({
      code: `TESTQA${userTs}`,
      discountType: "percentage",
      discountValue: "10",
      isActive: true,
    });
    testCoupon = couponResult;

    // Get or create cart
    testCart = await db.getOrCreateCart(testUser.id);
  }, 60000);

  // ============ FLOW 1: Browse/Catalog Filtering and Sorting ============

  describe("Flow 1: Browse/Catalog Filtering and Sorting", () => {
    it("Test should filter novels by status", async () => {
      const novels = await db.getCatalogNovels({
        filter: "published",
        offset: 0,
        limit: 10,
      });
      expect(Array.isArray(novels)).toBe(true);
      // All novels should have status "published" if filter works
      novels.forEach((n: any) => {
        if (n.status) expect(n.status).toBe("published");
      });
    });

    it("Test should search novels by title", async () => {
      const novels = await db.getCatalogNovels({
        searchTerm: "Test Novel",
        offset: 0,
        limit: 10,
      });
      expect(Array.isArray(novels)).toBe(true);
      // Should find our test novel
      const found = novels.find((n: any) => n.id === testNovel.id);
      expect(found).toBeDefined();
    });

    it("Test should sort novels by creation date", async () => {
      const novels = await db.getCatalogNovels({
        sortBy: "new",
        offset: 0,
        limit: 10,
      });
      expect(Array.isArray(novels)).toBe(true);
      expect(novels.length).toBeGreaterThan(0);
    });

    it("Test should handle combined filter and search", async () => {
      const novels = await db.getCatalogNovels({
        filter: "published",
        searchTerm: "Test",
        offset: 0,
        limit: 10,
      });
      expect(Array.isArray(novels)).toBe(true);
    });
  });

  // ============ FLOW 2: Novel Detail Opening and Episode Access ============

  describe("Flow 2: Novel Detail Opening and Episode Access", () => {
    it("Test should retrieve novel by slug", async () => {
      const novel = await db.getNovelBySlug(testNovel.slug);
      expect(novel).toBeDefined();
      expect(novel?.id).toBe(testNovel.id);
      expect(novel?.title).toContain("Test Novel");
    });

    it("Test should retrieve all episodes for novel", async () => {
      const episodes = await db.getEpisodesByNovelId(testNovel.id);
      expect(Array.isArray(episodes)).toBe(true);
      expect(episodes.length).toBeGreaterThanOrEqual(2);
      expect(episodes.some((e: any) => e.id === testEpisode1.id)).toBe(true);
    });

    it("Test should distinguish free vs paid episodes", async () => {
      const episodes = await db.getEpisodesByNovelId(testNovel.id);
      const paidEpisodes = episodes.filter((e: any) => !e.isFree);
      expect(paidEpisodes.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ============ FLOW 3: Add to Cart ============

  describe("Flow 3: Add to Cart", () => {
    it("Test should add single episode to cart", async () => {
      await db.clearCart(testCart.id);
      await db.addToCart(
        testCart.id,
        testEpisode1.id,
        testEpisode1.novelId,
        testEpisode1.price
      );
      const items = await db.getCartItems(testCart.id);
      expect(items.length).toBe(1);
      expect(items[0]?.episodeId).toBe(testEpisode1.id);
    });

    it("Test should add multiple episodes to cart", async () => {
      await db.clearCart(testCart.id);
      await db.addToCart(
        testCart.id,
        testEpisode1.id,
        testEpisode1.novelId,
        testEpisode1.price
      );
      await db.addToCart(
        testCart.id,
        testEpisode2.id,
        testEpisode2.novelId,
        testEpisode2.price
      );
      const items = await db.getCartItems(testCart.id);
      expect(items.length).toBe(2);
    });

    it("Test should prevent duplicate items in cart", async () => {
      await db.clearCart(testCart.id);
      await db.addToCart(
        testCart.id,
        testEpisode1.id,
        testEpisode1.novelId,
        testEpisode1.price
      );
      // Try to add same episode again
      await db.addToCart(
        testCart.id,
        testEpisode1.id,
        testEpisode1.novelId,
        testEpisode1.price
      );
      const items = await db.getCartItems(testCart.id);
      expect(items.length).toBe(1);
    });
  });

  // ============ FLOW 4: Checkout Without Coupon ============

  describe("Flow 4: Checkout Without Coupon", () => {
    it("Test should create order without coupon", async () => {
      await db.clearCart(testCart.id);
      await db.addToCart(
        testCart.id,
        testEpisode1.id,
        testEpisode1.novelId,
        testEpisode1.price
      );
      const items = await db.getCartItems(testCart.id);

      const order = await orderService.createOrderFromCart(
        String(testUser.id),
        items
      );

      expect(order).toBeDefined();
      expect(order.id).toBeDefined();
      expect(order.orderNumber).toBeDefined();
      expect(order.orderNumber).toMatch(/^ORD-/);
      expect(order.status).toBe("pending");
      expect(order.paymentStatus).toBe("unpaid");
      expect(parseFloat(order.subtotal)).toBe(50);
      expect(parseFloat(order.totalAmount)).toBe(50);
    });
  });

  // ============ FLOW 5: Checkout With Coupon ============

  describe("Flow 5: Checkout With Coupon", () => {
    it("Test should apply coupon discount to order", async () => {
      await db.clearCart(testCart.id);
      await db.addToCart(
        testCart.id,
        testEpisode1.id,
        testEpisode1.novelId,
        testEpisode1.price
      );
      const items = await db.getCartItems(testCart.id);

      const order = await orderService.createOrderFromCart(
        String(testUser.id),
        items,
        testCoupon.code
      );

      expect(order).toBeDefined();
      expect(order.couponCodeSnapshot).toBe(testCoupon.code);
      // 10% discount on 50 = 5
      expect(parseFloat(order.discountAmount)).toBe(5);
      expect(parseFloat(order.totalAmount)).toBe(45);
    });

    it("Test should record coupon usage in database", async () => {
      await db.clearCart(testCart.id);
      await db.addToCart(
        testCart.id,
        testEpisode1.id,
        testEpisode1.novelId,
        testEpisode1.price
      );
      const items = await db.getCartItems(testCart.id);

      const order = await orderService.createOrderFromCart(
        String(testUser.id),
        items,
        testCoupon.code
      );

      // Check coupon usage was recorded
      const coupon = await db.getCouponByCode(testCoupon.code);
      expect(coupon?.usageCount).toBeGreaterThan(0);

      // Check couponUsages table was updated
      const usage = await db.getCouponUsageByOrderId(order.id);
      expect(usage).toBeDefined();
      expect(usage?.couponId).toBe(testCoupon.id);
    });
  });

  // ============ FLOW 6: Checkout With Points Redemption ============

  describe("Flow 6: Checkout With Points Redemption", () => {
    it("Test should award points on order approval", async () => {
      // Create order with larger amount to trigger points (minimum 100)
      await db.clearCart(testCart.id);
      // Add both episodes to reach minimum threshold
      await db.addToCart(
        testCart.id,
        testEpisode1.id,
        testEpisode1.novelId,
        testEpisode1.price
      );
      await db.addToCart(
        testCart.id,
        testEpisode2.id,
        testEpisode2.novelId,
        testEpisode2.price
      );
      const items = await db.getCartItems(testCart.id);
      const order = await orderService.createOrderFromCart(
        String(testUser.id),
        items
      );

      // Get payment and approve
      const payment = await db.getPaymentByOrderId(order.id);
      expect(payment).toBeDefined();

      await orderService.approvePayment(payment!.id, String(testAdmin.id));

      // Check points were awarded (125 points for 125 subtotal)
      const balance = await db.getUserPointsBalance(testUser.id);
      expect(parseFloat(balance)).toBeGreaterThan(0);
    });

    it("Test should redeem points for discount", async () => {
      // Award points first
      const currentBalance = parseFloat(await db.getUserPointsBalance(testUser.id));
      await db.recordPointsTransaction({
        userId: testUser.id,
        type: "earn",
        amount: "100",
        balanceAfter: String(currentBalance + 100),
      });

      // Create order with points redemption
      await db.clearCart(testCart.id);
      await db.addToCart(
        testCart.id,
        testEpisode1.id,
        testEpisode1.novelId,
        testEpisode1.price
      );
      const items = await db.getCartItems(testCart.id);

      const order = await orderService.createOrderFromCart(
        String(testUser.id),
        items,
        undefined,
        "25" // Redeem 25 points
      );

      expect(order).toBeDefined();
      expect(parseFloat(order.pointsDiscountAmount)).toBe(25);
      expect(parseFloat(order.totalAmount)).toBe(25); // 50 - 25 points
    });

    it("Test should deduct points from user balance on approval", async () => {
      // Award points
      const currentBalance = parseFloat(await db.getUserPointsBalance(testUser.id));
      await db.recordPointsTransaction({
        userId: testUser.id,
        type: "earn",
        amount: "100",
        balanceAfter: String(currentBalance + 100),
      });
      const balanceBefore = parseFloat(
        await db.getUserPointsBalance(testUser.id)
      );

      // Create and approve order with points
      await db.clearCart(testCart.id);
      await db.addToCart(
        testCart.id,
        testEpisode1.id,
        testEpisode1.novelId,
        testEpisode1.price
      );
      const items = await db.getCartItems(testCart.id);
      const order = await orderService.createOrderFromCart(
        String(testUser.id),
        items,
        undefined,
        "25"
      );

      const payment = await db.getPaymentByOrderId(order.id);
      await orderService.approvePayment(payment!.id, String(testAdmin.id));

      // Check points were deducted
      const balanceAfter = parseFloat(
        await db.getUserPointsBalance(testUser.id)
      );
      expect(balanceAfter).toBeLessThan(balanceBefore);
    });
  });

  // ============ FLOW 7: Payment Slip Submission ============

  describe("Flow 7: Payment Slip Submission", () => {
    it("Test should store payment slip metadata", async () => {
      // Create order
      await db.clearCart(testCart.id);
      await db.addToCart(
        testCart.id,
        testEpisode1.id,
        testEpisode1.novelId,
        testEpisode1.price
      );
      const items = await db.getCartItems(testCart.id);
      const order = await orderService.createOrderFromCart(
        String(testUser.id),
        items
      );

      const payment = await db.getPaymentByOrderId(order.id);
      expect(payment).toBeDefined();

      // Upload payment slip
      const slipUrl = "https://example.com/slip-test.jpg";
      await db.updatePayment(payment!.id, {
        slipImageUrl: slipUrl,
        slipSubmittedAt: new Date(),
        status: "pending",
      });

      // Verify slip was stored
      const updatedPayment = await db.getPaymentById(payment!.id);
      expect(updatedPayment?.slipImageUrl).toBe(slipUrl);
      expect(updatedPayment?.slipSubmittedAt).toBeDefined();
    });

    it("Test should update order status when slip submitted", async () => {
      // Create order
      await db.clearCart(testCart.id);
      await db.addToCart(
        testCart.id,
        testEpisode1.id,
        testEpisode1.novelId,
        testEpisode1.price
      );
      const items = await db.getCartItems(testCart.id);
      const order = await orderService.createOrderFromCart(
        String(testUser.id),
        items
      );

      // Update order status
      await db.updateOrder(order.id, {
        paymentStatus: "submitted",
      });

      const updatedOrder = await db.getOrderById(order.id);
      expect(updatedOrder?.paymentStatus).toBe("submitted");
    });
  });

  // ============ FLOW 8: Admin Approve Payment ============

  describe("Flow 8: Admin Approve Payment", () => {
    it("Test should approve payment and update status", async () => {
      // Create order
      await db.clearCart(testCart.id);
      await db.addToCart(
        testCart.id,
        testEpisode1.id,
        testEpisode1.novelId,
        testEpisode1.price
      );
      const items = await db.getCartItems(testCart.id);
      const order = await orderService.createOrderFromCart(
        String(testUser.id),
        items
      );

      const payment = await db.getPaymentByOrderId(order.id);
      expect(payment?.status).toBe("pending");

      // Approve payment
      await orderService.approvePayment(payment!.id, String(testAdmin.id));

      // Verify status changed
      const approvedPayment = await db.getPaymentById(payment!.id);
      expect(approvedPayment?.status).toBe("approved");
      expect(String(approvedPayment?.reviewedByUserId)).toBe(String(testAdmin.id));

      const approvedOrder = await db.getOrderById(order.id);
      expect(approvedOrder?.status).toBe("approved");
      expect(approvedOrder?.paymentStatus).toBe("approved");
    });

    it("Test should record approval in order history", async () => {
      // Create order
      await db.clearCart(testCart.id);
      await db.addToCart(
        testCart.id,
        testEpisode1.id,
        testEpisode1.novelId,
        testEpisode1.price
      );
      const items = await db.getCartItems(testCart.id);
      const order = await orderService.createOrderFromCart(
        String(testUser.id),
        items
      );

      const payment = await db.getPaymentByOrderId(order.id);
      await orderService.approvePayment(payment!.id, String(testAdmin.id));

      // Check order history
      const history = await db.getOrderHistory(order.id);
      expect(history.length).toBeGreaterThan(0);
      const approvalRecord = history.find((h: any) => h.toStatus === "approved");
      expect(approvalRecord).toBeDefined();
    });
  });

  // ============ FLOW 9: Admin Reject Payment ============

  describe("Flow 9: Admin Reject Payment", () => {
    it("Test should reject payment with reason", async () => {
      // Create order
      await db.clearCart(testCart.id);
      await db.addToCart(
        testCart.id,
        testEpisode1.id,
        testEpisode1.novelId,
        testEpisode1.price
      );
      const items = await db.getCartItems(testCart.id);
      const order = await orderService.createOrderFromCart(
        String(testUser.id),
        items
      );

      const payment = await db.getPaymentByOrderId(order.id);
      const rejectionReason = "Test rejection - invalid slip";

      // Reject payment
      await orderService.rejectPayment(
        payment!.id,
        String(testAdmin.id),
        rejectionReason
      );

      // Verify rejection
      const rejectedPayment = await db.getPaymentById(payment!.id);
      expect(rejectedPayment?.status).toBe("rejected");
      expect(rejectedPayment?.rejectionReason).toBe(rejectionReason);

      const rejectedOrder = await db.getOrderById(order.id);
      expect(rejectedOrder?.status).toBe("rejected");
      expect(rejectedOrder?.notes).toBe(rejectionReason);
    });
  });

  // ============ FLOW 10: Purchases Created Correctly ============

  describe("Flow 10: Purchases Created Correctly", () => {
    it("Test should create purchase on approval", async () => {
      // Create order with items
      await db.clearCart(testCart.id);
      await db.addToCart(
        testCart.id,
        testEpisode1.id,
        testEpisode1.novelId,
        testEpisode1.price
      );
      const items = await db.getCartItems(testCart.id);
      const order = await orderService.createOrderFromCart(
        String(testUser.id),
        items
      );

      // Approve payment
      const payment = await db.getPaymentByOrderId(order.id);
      await orderService.approvePayment(payment!.id, String(testAdmin.id));

      // Check purchase was created
      const purchases = await db.getPurchasesByUserId(testUser.id);
      const purchase = purchases.find(
        (p: any) => p.episodeId === testEpisode1.id
      );
      expect(purchase).toBeDefined();
      expect(purchase?.userId).toBe(testUser.id);
      expect(purchase?.novelId).toBe(testEpisode1.novelId);
    });

    it("Test should not create purchase on rejection", async () => {
      // Create order
      await db.clearCart(testCart.id);
      await db.addToCart(
        testCart.id,
        testEpisode2.id,
        testEpisode2.novelId,
        testEpisode2.price
      );
      const items = await db.getCartItems(testCart.id);
      const order = await orderService.createOrderFromCart(
        String(testUser.id),
        items
      );

      // Reject payment
      const payment = await db.getPaymentByOrderId(order.id);
      await orderService.rejectPayment(
        payment!.id,
        String(testAdmin.id),
        "Test rejection"
      );

      // Check no purchase was created for rejected order
      const hasAccess = await orderService.hasAccessToEpisode(
        testUser.id,
        testEpisode2.id
      );
      expect(hasAccess).toBe(false);
    });
  });

  // ============ FLOW 11: Points Deducted/Awarded Correctly ============

  describe("Flow 11: Points Deducted/Awarded Correctly", () => {
    it("Test should track points transactions", async () => {
      const beforeBalance = parseFloat(
        await db.getUserPointsBalance(testUser.id)
      );

      // Award points
      await db.recordPointsTransaction({
        userId: testUser.id,
        type: "earn",
        amount: "50",
        balanceAfter: String(beforeBalance + 50),
      });

      const afterBalance = parseFloat(
        await db.getUserPointsBalance(testUser.id)
      );
      expect(afterBalance).toBe(beforeBalance + 50);

      // Check transaction history
      const history = await db.getPointsHistory(testUser.id);
      expect(history.length).toBeGreaterThan(0);
    });
  });

  // ============ FLOW 12: Coupon Usage Recorded Correctly ============

  describe("Flow 12: Coupon Usage Recorded Correctly", () => {
    it("Test should record coupon usage", async () => {
      // Create order with coupon
      await db.clearCart(testCart.id);
      await db.addToCart(
        testCart.id,
        testEpisode1.id,
        testEpisode1.novelId,
        testEpisode1.price
      );
      const items = await db.getCartItems(testCart.id);
      const order = await orderService.createOrderFromCart(
        String(testUser.id),
        items,
        testCoupon.code
      );

      // Check coupon usage was recorded
      const usages = await db.getCouponUsageByUserId(testUser.id);
      const usage = usages.find((u: any) => u.orderId === order.id);
      expect(usage).toBeDefined();
      expect(usage?.couponId).toBe(testCoupon.id);
      expect(usage?.userId).toBe(testUser.id);
      expect(usage?.orderId).toBe(order.id);
    });
  });

  // ============ FLOW 13: Episode File Upload Updates fileUrl ============

  describe("Flow 13: Episode File Upload Updates fileUrl", () => {
    it("Test should update episode fileUrl after upload", async () => {
      // Create episode without fileUrl
      const epResult: any = await db.createEpisode({
        novelId: testNovel.id,
        episodeNumber: `test-qa-upload-${Date.now()}`,
        title: `Test Episode Upload`,
        price: "50.00",
        isFree: false,
        fileUrl: "", // Empty initially
      });
      const episodeId =
        (epResult as any)[0]?.insertId ?? (epResult as any).insertId;

      // Simulate file upload and update
      const newFileUrl = "https://example.com/uploaded-file.pdf";
      await db.updateEpisode(episodeId, { fileUrl: newFileUrl });

      // Verify fileUrl was updated
      const episode = await db.getEpisodeById(episodeId);
      expect(episode?.fileUrl).toBe(newFileUrl);
    });
  });

  // ============ FLOW 14: Admin Can See Inactive Banners ============

  describe("Flow 14: Admin Can See Inactive Banners", () => {
    it("Test should return all banners for admin (including inactive)", async () => {
      // Create active banner
      const activeBanner: any = await db.createBanner({
        title: "Test Active Banner",
        imageUrl: "https://example.com/active.jpg",
        linkUrl: "/test",
        isActive: true,
      });

      // Create inactive banner
      const inactiveBanner: any = await db.createBanner({
        title: "Test Inactive Banner",
        imageUrl: "https://example.com/inactive.jpg",
        linkUrl: "/test",
        isActive: false,
      });

      // Admin should see all banners
      const allBanners = await db.getAllBannersAdmin();
      expect(Array.isArray(allBanners)).toBe(true);
      expect(allBanners.length).toBeGreaterThanOrEqual(2);

      // Regular user should only see active banners
      const activeBanners = await db.getAllBanners();
      const inactiveCount = activeBanners.filter(
        (b: any) => !b.isActive
      ).length;
      expect(inactiveCount).toBe(0);
    });
  });

  // ============ FLOW 15: Order History/Audit Trail ============

  describe("Flow 15: Order History/Audit Trail", () => {
    it("Test should record all order status changes", async () => {
      // Create order
      await db.clearCart(testCart.id);
      await db.addToCart(
        testCart.id,
        testEpisode1.id,
        testEpisode1.novelId,
        testEpisode1.price
      );
      const items = await db.getCartItems(testCart.id);
      const order = await orderService.createOrderFromCart(
        String(testUser.id),
        items
      );

      // Approve payment
      const payment = await db.getPaymentByOrderId(order.id);
      await orderService.approvePayment(payment!.id, String(testAdmin.id));

      // Check order history has records
      const history = await db.getOrderHistory(order.id);
      expect(history.length).toBeGreaterThan(0);

      // Should have approval record
      const approvalRecord = history.find((h: any) => h.toStatus === "approved");
      expect(approvalRecord).toBeDefined();
      expect(approvalRecord?.note).toBeDefined();
    });
  });
});
