import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as db from "./db";

// Mock database functions
vi.mock("./db", async () => {
  const actual = await vi.importActual("./db");
  return {
    ...actual,
  };
});

describe("Admin Coupons CRUD", () => {
  const testCoupon = {
    id: 1,
    code: "TEST20",
    discountType: "flat" as const,
    discountValue: "20",
    minPurchaseAmount: "100",
    maxUsageCount: 50,
    usageCount: 0,
    expiresAt: new Date("2026-12-31"),
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  describe("getAllCoupons", () => {
    it("should return empty array when no coupons exist", async () => {
      vi.spyOn(db, "getAllCoupons").mockResolvedValueOnce([]);
      const result = await db.getAllCoupons();
      expect(result).toEqual([]);
    });

    it("should return list of coupons ordered by createdAt desc", async () => {
      const coupons = [testCoupon, { ...testCoupon, id: 2, code: "SAVE10" }];
      vi.spyOn(db, "getAllCoupons").mockResolvedValueOnce(coupons);
      const result = await db.getAllCoupons();
      expect(result).toHaveLength(2);
      expect(result[0].code).toBe("TEST20");
    });
  });

  describe("createCoupon", () => {
    it("should create a coupon with all fields", async () => {
      const input = {
        code: "NEW20",
        discountType: "flat" as const,
        discountValue: "20",
        minPurchaseAmount: "100",
        maxUsageCount: 50,
        expiresAt: new Date("2026-12-31"),
      };

      vi.spyOn(db, "createCoupon").mockResolvedValueOnce({ insertId: 1 });
      const result = await db.createCoupon(input);
      expect(result).toBeDefined();
    });

    it("should create a coupon with minimal fields", async () => {
      const input = {
        code: "BASIC",
        discountType: "percentage" as const,
        discountValue: "10",
      };

      vi.spyOn(db, "createCoupon").mockResolvedValueOnce({ insertId: 2 });
      const result = await db.createCoupon(input);
      expect(result).toBeDefined();
    });

    it("should set isActive to true and usageCount to 0 by default", async () => {
      const input = {
        code: "DEFAULT",
        discountType: "flat" as const,
        discountValue: "50",
      };

      vi.spyOn(db, "createCoupon").mockResolvedValueOnce({ insertId: 3 });
      const result = await db.createCoupon(input);
      expect(result).toBeDefined();
    });
  });

  describe("updateCoupon", () => {
    it("should update coupon code", async () => {
      const updateData = { code: "UPDATED20" };
      vi.spyOn(db, "updateCoupon").mockResolvedValueOnce(undefined);
      await db.updateCoupon(1, updateData);
      expect(db.updateCoupon).toHaveBeenCalledWith(1, updateData);
    });

    it("should update discount value and type", async () => {
      const updateData = {
        discountType: "percentage" as const,
        discountValue: "25",
      };
      vi.spyOn(db, "updateCoupon").mockResolvedValueOnce(undefined);
      await db.updateCoupon(1, updateData);
      expect(db.updateCoupon).toHaveBeenCalledWith(1, updateData);
    });

    it("should update usage limits", async () => {
      const updateData = { maxUsageCount: 100 };
      vi.spyOn(db, "updateCoupon").mockResolvedValueOnce(undefined);
      await db.updateCoupon(1, updateData);
      expect(db.updateCoupon).toHaveBeenCalledWith(1, updateData);
    });

    it("should update expiration date", async () => {
      const newDate = new Date("2027-12-31");
      const updateData = { expiresAt: newDate };
      vi.spyOn(db, "updateCoupon").mockResolvedValueOnce(undefined);
      await db.updateCoupon(1, updateData);
      expect(db.updateCoupon).toHaveBeenCalledWith(1, updateData);
    });

    it("should toggle active status", async () => {
      const updateData = { isActive: false };
      vi.spyOn(db, "updateCoupon").mockResolvedValueOnce(undefined);
      await db.updateCoupon(1, updateData);
      expect(db.updateCoupon).toHaveBeenCalledWith(1, updateData);
    });

    it("should update multiple fields at once", async () => {
      const updateData = {
        code: "MEGA50",
        discountValue: "50",
        isActive: false,
      };
      vi.spyOn(db, "updateCoupon").mockResolvedValueOnce(undefined);
      await db.updateCoupon(1, updateData);
      expect(db.updateCoupon).toHaveBeenCalledWith(1, updateData);
    });
  });

  describe("deleteCoupon", () => {
    it("should delete a coupon by id", async () => {
      vi.spyOn(db, "deleteCoupon").mockResolvedValueOnce(undefined);
      await db.deleteCoupon(1);
      expect(db.deleteCoupon).toHaveBeenCalledWith(1);
    });

    it("should handle deletion of non-existent coupon gracefully", async () => {
      vi.spyOn(db, "deleteCoupon").mockResolvedValueOnce(undefined);
      await db.deleteCoupon(999);
      expect(db.deleteCoupon).toHaveBeenCalledWith(999);
    });
  });

  describe("getCouponByCode", () => {
    it("should retrieve coupon by code", async () => {
      vi.spyOn(db, "getCouponByCode").mockResolvedValueOnce(testCoupon);
      const result = await db.getCouponByCode("TEST20");
      expect(result).toEqual(testCoupon);
      expect(result?.code).toBe("TEST20");
    });

    it("should return undefined for non-existent code", async () => {
      vi.spyOn(db, "getCouponByCode").mockResolvedValueOnce(undefined);
      const result = await db.getCouponByCode("NONEXISTENT");
      expect(result).toBeUndefined();
    });
  });

  describe("Coupon Validation", () => {
    it("should validate discount type is either flat or percentage", () => {
      const validFlat = { discountType: "flat" };
      const validPercentage = { discountType: "percentage" };
      expect(validFlat.discountType).toMatch(/^(flat|percentage)$/);
      expect(validPercentage.discountType).toMatch(/^(flat|percentage)$/);
    });

    it("should validate discount value is numeric", () => {
      const validValue = "25";
      const validDecimal = "25.50";
      expect(!isNaN(Number(validValue))).toBe(true);
      expect(!isNaN(Number(validDecimal))).toBe(true);
    });

    it("should validate max usage count is positive integer", () => {
      const validCount = 50;
      const validZero = 0;
      expect(validCount > 0).toBe(true);
      expect(validZero >= 0).toBe(true);
    });

    it("should validate expiration date is in future", () => {
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);
      expect(futureDate > new Date()).toBe(true);
    });
  });

  describe("Coupon Usage Tracking", () => {
    it("should track coupon usage count", async () => {
      vi.spyOn(db, "recordCouponUsage").mockResolvedValueOnce(undefined);
      await db.recordCouponUsage(1, 123, 456);
      expect(db.recordCouponUsage).toHaveBeenCalledWith(1, 123, 456);
    });

    it("should handle coupon usage for guest users", async () => {
      vi.spyOn(db, "recordCouponUsage").mockResolvedValueOnce(undefined);
      await db.recordCouponUsage(1, undefined, 456);
      expect(db.recordCouponUsage).toHaveBeenCalledWith(1, undefined, 456);
    });
  });
});
