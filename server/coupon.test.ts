import { describe, it, expect } from "vitest";
import * as orderService from "./services/orderService";
import * as db from "./db";

describe("Coupon System - End-to-End", () => {
  describe("Coupon Code Normalization", () => {
    it("should find coupon with lowercase code", async () => {
      // Create a coupon with uppercase code
      await db.createCoupon({
        code: "WELCOME20",
        discountType: "percentage",
        discountValue: "20",
      });

      // Should find it with lowercase
      const coupon = await db.getCouponByCode("welcome20");
      expect(coupon).toBeDefined();
      expect(coupon?.code).toBe("WELCOME20");
    });

    it("should find coupon with whitespace", async () => {
      // Create coupon
      await db.createCoupon({
        code: "SUMMER30",
        discountType: "percentage",
        discountValue: "30",
      });

      // Should find it with surrounding spaces
      const coupon = await db.getCouponByCode("  SUMMER30  ");
      expect(coupon).toBeDefined();
      expect(coupon?.code).toBe("SUMMER30");
    });

    it("should find coupon with mixed case and spaces", async () => {
      // Create coupon
      await db.createCoupon({
        code: "NEWUSER10",
        discountType: "percentage",
        discountValue: "10",
      });

      // Should find it with mixed case and spaces
      const coupon = await db.getCouponByCode("  newuser10  ");
      expect(coupon).toBeDefined();
      expect(coupon?.code).toBe("NEWUSER10");
    });
  });

  describe("Coupon Validation", () => {
    it("should validate active percentage coupon", async () => {
      // Create active coupon
      await db.createCoupon({
        code: "ACTIVE20",
        discountType: "percentage",
        discountValue: "20",
        isActive: true,
      });

      // Should validate successfully
      const result = await orderService.validateAndApplyCoupon("ACTIVE20", "100");
      expect(result.discountAmount).toBe("20.00");
    });

    it("should reject inactive coupon", async () => {
      // Create active coupon first
      await db.createCoupon({
        code: "INACTIVECOUPON",
        discountType: "percentage",
        discountValue: "20",
        isActive: true,
      });

      // Update to inactive
      const coupon = await db.getCouponByCode("INACTIVECOUPON");
      if (coupon) {
        await db.updateCoupon(coupon.id, { isActive: false });
      }

      // Should throw error
      await expect(orderService.validateAndApplyCoupon("INACTIVECOUPON", "100")).rejects.toThrow("Coupon is inactive");
    });

    it("should reject expired coupon", async () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);

      // Create expired coupon
      await db.createCoupon({
        code: "EXPIRED",
        discountType: "percentage",
        discountValue: "20",
        expiresAt: pastDate,
      });

      // Should throw error
      await expect(orderService.validateAndApplyCoupon("EXPIRED", "100")).rejects.toThrow("Coupon has expired");
    });

    it("should reject coupon below minimum purchase", async () => {
      // Create coupon with minimum purchase = 500
      await db.createCoupon({
        code: "MINPURCHASE",
        discountType: "percentage",
        discountValue: "20",
        minPurchaseAmount: "500",
      });

      // Should throw error
      await expect(orderService.validateAndApplyCoupon("MINPURCHASE", "100")).rejects.toThrow("Minimum purchase amount of ฿500.00 required");
    });

    it("should reject non-existent coupon", async () => {
      // Should throw error
      await expect(orderService.validateAndApplyCoupon("NONEXISTENT", "100")).rejects.toThrow("Coupon not found");
    });
  });

  describe("Coupon Discount Calculation", () => {
    it("should calculate flat discount correctly", async () => {
      // Create flat discount coupon
      await db.createCoupon({
        code: "FLAT50",
        discountType: "flat",
        discountValue: "50",
      });

      // Should calculate discount
      const result = await orderService.validateAndApplyCoupon("FLAT50", "200");
      expect(result.discountAmount).toBe("50.00");
    });

    it("should cap flat discount at subtotal", async () => {
      // Create flat discount coupon
      await db.createCoupon({
        code: "FLAT100",
        discountType: "flat",
        discountValue: "100",
      });

      // Should cap discount at subtotal
      const result = await orderService.validateAndApplyCoupon("FLAT100", "50");
      expect(result.discountAmount).toBe("50.00");
    });

    it("should calculate percentage discount correctly", async () => {
      // Create percentage discount coupon
      await db.createCoupon({
        code: "PERCENT25",
        discountType: "percentage",
        discountValue: "25",
      });

      // Should calculate discount
      const result = await orderService.validateAndApplyCoupon("PERCENT25", "200");
      expect(result.discountAmount).toBe("50.00");
    });
  });

  describe("Admin Coupon CRUD", () => {
    it("should list coupons with discountValue visible", async () => {
      // Create a coupon
      await db.createCoupon({
        code: "TESTCOUPON",
        discountType: "percentage",
        discountValue: "15",
      });

      // Get all coupons
      const coupons = await db.getAllCoupons();
      const testCoupon = coupons.find((c: any) => c.code === "TESTCOUPON");

      expect(testCoupon).toBeDefined();
      expect(testCoupon?.discountValue).toBeDefined();
      expect(testCoupon?.discountValue).not.toBe("");
      expect(testCoupon?.discountValue).not.toBe(null);
    });

    it("should update coupon discountValue", async () => {
      // Create a coupon
      await db.createCoupon({
        code: "UPDATETEST",
        discountType: "percentage",
        discountValue: "10",
      });

      // Get the coupon ID
      const coupon = await db.getCouponByCode("UPDATETEST");
      expect(coupon).toBeDefined();

      if (coupon) {
        // Update discount value
        await db.updateCoupon(coupon.id, { discountValue: "25" });

        // Verify update
        const updated = await db.getCouponByCode("UPDATETEST");
        expect(updated?.discountValue).toBeDefined();
        expect(parseFloat(String(updated?.discountValue))).toBe(25);
      }
    });

    it("should delete coupon", async () => {
      // Create a coupon
      await db.createCoupon({
        code: "DELETETEST",
        discountType: "percentage",
        discountValue: "10",
      });

      // Get the coupon
      const coupon = await db.getCouponByCode("DELETETEST");
      expect(coupon).toBeDefined();

      if (coupon) {
        // Delete it
        await db.deleteCoupon(coupon.id);

        // Verify deletion
        const deleted = await db.getCouponByCode("DELETETEST");
        expect(deleted).toBeUndefined();
      }
    });
  });

  describe("Error Messages", () => {
    it("should return specific error for expired coupon", async () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);

      await db.createCoupon({
        code: "EXPIREDTEST",
        discountType: "percentage",
        discountValue: "20",
        expiresAt: pastDate,
      });

      try {
        await orderService.validateAndApplyCoupon("EXPIREDTEST", "100");
        expect.fail("Should throw error");
      } catch (error: any) {
        expect(error.message).toContain("expired");
      }
    });

    it("should return specific error for not found", async () => {
      try {
        await orderService.validateAndApplyCoupon("NOTFOUND123", "100");
        expect.fail("Should throw error");
      } catch (error: any) {
        expect(error.message).toContain("not found");
      }
    });
  });
});
