import { describe, it, expect } from "vitest";
import * as orderService from "./services/orderService";
import * as db from "./db";

// Helper to generate a unique coupon code per test run to avoid duplicate key errors
const uc = (base: string) => `${base}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

describe("Coupon System - End-to-End", () => {
  describe("Coupon Code Normalization", () => {
    it("should find coupon with lowercase code", async () => {
      const code = uc("WELCOME20");
      await db.createCoupon({
        code,
        discountType: "percentage",
        discountValue: "20",
      });

      // Should find it with lowercase
      const coupon = await db.getCouponByCode(code.toLowerCase());
      expect(coupon).toBeDefined();
      expect(coupon?.code).toBe(code);
    });

    it("should find coupon with whitespace", async () => {
      const code = uc("SUMMER30");
      await db.createCoupon({
        code,
        discountType: "percentage",
        discountValue: "30",
      });

      // Should find it with surrounding spaces
      const coupon = await db.getCouponByCode(`  ${code}  `);
      expect(coupon).toBeDefined();
      expect(coupon?.code).toBe(code);
    });

    it("should find coupon with mixed case and spaces", async () => {
      const code = uc("NEWUSER10");
      await db.createCoupon({
        code,
        discountType: "percentage",
        discountValue: "10",
      });

      // Should find it with mixed case and spaces
      const coupon = await db.getCouponByCode(`  ${code.toLowerCase()}  `);
      expect(coupon).toBeDefined();
      expect(coupon?.code).toBe(code);
    });
  });

  describe("Coupon Validation", () => {
    it("should validate active percentage coupon", async () => {
      const code = uc("ACTIVE20");
      await db.createCoupon({
        code,
        discountType: "percentage",
        discountValue: "20",
      });

      // Should validate successfully
      const result = await orderService.validateAndApplyCoupon(code, "100");
      expect(result.discountAmount).toBe("20.00");
    });

    it("should reject inactive coupon", async () => {
      const code = uc("INACTIVECOUPON");
      await db.createCoupon({
        code,
        discountType: "percentage",
        discountValue: "20",
      });

      // Update to inactive
      const coupon = await db.getCouponByCode(code);
      if (coupon) {
        await db.updateCoupon(coupon.id, { isActive: false });
      }

      // Should throw error
      await expect(orderService.validateAndApplyCoupon(code, "100")).rejects.toThrow("Coupon is inactive");
    });

    it("should reject expired coupon", async () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);
      const code = uc("EXPIRED");

      await db.createCoupon({
        code,
        discountType: "percentage",
        discountValue: "20",
        expiresAt: pastDate,
      });

      // Should throw error
      await expect(orderService.validateAndApplyCoupon(code, "100")).rejects.toThrow("Coupon has expired");
    });

    it("should reject coupon below minimum purchase", async () => {
      const code = uc("MINPURCHASE");
      await db.createCoupon({
        code,
        discountType: "percentage",
        discountValue: "20",
        minPurchaseAmount: "500",
      });

      // Should throw error
      await expect(orderService.validateAndApplyCoupon(code, "100")).rejects.toThrow("Minimum purchase amount of ฿500.00 required");
    });

    it("should reject non-existent coupon", async () => {
      // Should throw error
      await expect(orderService.validateAndApplyCoupon("NONEXISTENT_XYZABC", "100")).rejects.toThrow("Coupon not found");
    });
  });

  describe("Coupon Discount Calculation", () => {
    it("should calculate flat discount correctly", async () => {
      const code = uc("FLAT50");
      await db.createCoupon({
        code,
        discountType: "flat",
        discountValue: "50",
      });

      const result = await orderService.validateAndApplyCoupon(code, "200");
      expect(result.discountAmount).toBe("50.00");
    });

    it("should cap flat discount at subtotal", async () => {
      const code = uc("FLAT100");
      await db.createCoupon({
        code,
        discountType: "flat",
        discountValue: "100",
      });

      // Should cap discount at subtotal
      const result = await orderService.validateAndApplyCoupon(code, "50");
      expect(result.discountAmount).toBe("50.00");
    });

    it("should calculate percentage discount correctly", async () => {
      const code = uc("PERCENT25");
      await db.createCoupon({
        code,
        discountType: "percentage",
        discountValue: "25",
      });

      const result = await orderService.validateAndApplyCoupon(code, "200");
      expect(result.discountAmount).toBe("50.00");
    });
  });

  describe("Admin Coupon CRUD", () => {
    it("should list coupons with discountValue visible", async () => {
      const code = uc("TESTCOUPON");
      await db.createCoupon({
        code,
        discountType: "percentage",
        discountValue: "15",
      });

      // Get all coupons
      const coupons = await db.getAllCoupons();
      const testCoupon = coupons.find((c: any) => c.code === code);

      expect(testCoupon).toBeDefined();
      expect(testCoupon?.discountValue).toBeDefined();
      expect(testCoupon?.discountValue).not.toBe("");
      expect(testCoupon?.discountValue).not.toBe(null);
    });

    it("should update coupon discountValue", async () => {
      const code = uc("UPDATETEST");
      await db.createCoupon({
        code,
        discountType: "percentage",
        discountValue: "10",
      });

      const coupon = await db.getCouponByCode(code);
      expect(coupon).toBeDefined();

      if (coupon) {
        await db.updateCoupon(coupon.id, { discountValue: "25" });

        const updated = await db.getCouponByCode(code);
        expect(updated?.discountValue).toBeDefined();
        expect(parseFloat(String(updated?.discountValue))).toBe(25);
      }
    });

    it("should delete coupon", async () => {
      const code = uc("DELETETEST");
      await db.createCoupon({
        code,
        discountType: "percentage",
        discountValue: "10",
      });

      const coupon = await db.getCouponByCode(code);
      expect(coupon).toBeDefined();

      if (coupon) {
        await db.deleteCoupon(coupon.id);

        const deleted = await db.getCouponByCode(code);
        expect(deleted).toBeUndefined();
      }
    });
  });

  describe("Error Messages", () => {
    it("should return specific error for expired coupon", async () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 1);
      const code = uc("EXPIREDTEST");

      await db.createCoupon({
        code,
        discountType: "percentage",
        discountValue: "20",
        expiresAt: pastDate,
      });

      try {
        await orderService.validateAndApplyCoupon(code, "100");
        expect.fail("Should throw error");
      } catch (error: any) {
        expect(error.message).toContain("expired");
      }
    });

    it("should return specific error for not found", async () => {
      try {
        await orderService.validateAndApplyCoupon("NOTFOUND_XYZABC123", "100");
        expect.fail("Should throw error");
      } catch (error: any) {
        expect(error.message).toContain("not found");
      }
    });
  });
});
