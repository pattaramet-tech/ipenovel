import { describe, it, expect } from "vitest";
import {
  normalizeMoneyAmount,
  formatMoney,
  moneyEquals,
  moneyDifference,
  moneyAdd,
} from "./moneyNormalizer";

describe("Money Normalization Helpers", () => {
  describe("normalizeMoneyAmount", () => {
    it("should handle number inputs", () => {
      expect(normalizeMoneyAmount(100, "amount")).toBe(100);
      expect(normalizeMoneyAmount(100.5, "amount")).toBe(100.5);
      expect(normalizeMoneyAmount(0, "amount")).toBe(0);
    });

    it("should handle string inputs", () => {
      expect(normalizeMoneyAmount("100", "amount")).toBe(100);
      expect(normalizeMoneyAmount("100.00", "amount")).toBe(100);
      expect(normalizeMoneyAmount("100.50", "amount")).toBe(100.5);
      expect(normalizeMoneyAmount("0.01", "amount")).toBe(0.01);
    });

    it("should handle Decimal-like objects", () => {
      // Simulate Drizzle Decimal object
      const decimalObj = {
        toString: () => "100.00",
      };
      expect(normalizeMoneyAmount(decimalObj, "amount")).toBe(100);
    });

    it("should round to 2 decimal places", () => {
      expect(normalizeMoneyAmount(100.005, "amount")).toBe(100.01);
      expect(normalizeMoneyAmount(100.004, "amount")).toBe(100);
      expect(normalizeMoneyAmount("100.999", "amount")).toBe(101);
    });

    it("should reject null/undefined", () => {
      expect(() => normalizeMoneyAmount(null, "amount")).toThrow("amount is required");
      expect(() => normalizeMoneyAmount(undefined, "amount")).toThrow("amount is required");
      expect(() => normalizeMoneyAmount("", "amount")).toThrow("amount is required");
    });

    it("should reject non-finite numbers", () => {
      expect(() => normalizeMoneyAmount(Infinity, "amount")).toThrow("must be a valid number");
      expect(() => normalizeMoneyAmount(-Infinity, "amount")).toThrow("must be a valid number");
      expect(() => normalizeMoneyAmount(NaN, "amount")).toThrow("must be a valid number");
      expect(() => normalizeMoneyAmount("abc", "amount")).toThrow("must be a valid number");
    });

    it("should reject negative amounts", () => {
      expect(() => normalizeMoneyAmount(-100, "amount")).toThrow("must be non-negative");
      expect(() => normalizeMoneyAmount("-100.00", "amount")).toThrow("must be non-negative");
    });

    it("should handle edge case: very small amounts", () => {
      expect(normalizeMoneyAmount(0.01, "amount")).toBe(0.01);
      expect(normalizeMoneyAmount("0.01", "amount")).toBe(0.01);
    });

    it("should handle edge case: very large amounts", () => {
      expect(normalizeMoneyAmount(999999.99, "amount")).toBe(999999.99);
      expect(normalizeMoneyAmount("999999.99", "amount")).toBe(999999.99);
    });
  });

  describe("formatMoney", () => {
    it("should format numbers with 2 decimal places", () => {
      expect(formatMoney(100, "amount")).toBe("100.00");
      expect(formatMoney(100.5, "amount")).toBe("100.50");
      expect(formatMoney(0, "amount")).toBe("0.00");
    });

    it("should format strings with 2 decimal places", () => {
      expect(formatMoney("100", "amount")).toBe("100.00");
      expect(formatMoney("100.5", "amount")).toBe("100.50");
      expect(formatMoney("0.01", "amount")).toBe("0.01");
    });

    it("should format Decimal objects with 2 decimal places", () => {
      const decimalObj = { toString: () => "100.5" };
      expect(formatMoney(decimalObj, "amount")).toBe("100.50");
    });

    it("should throw on invalid input", () => {
      expect(() => formatMoney(null, "amount")).toThrow("amount is required");
      expect(() => formatMoney("abc", "amount")).toThrow("must be a valid number");
    });
  });

  describe("moneyEquals", () => {
    it("should compare equal amounts", () => {
      expect(moneyEquals(100, 100)).toBe(true);
      expect(moneyEquals("100.00", 100)).toBe(true);
      expect(moneyEquals(100, "100.00")).toBe(true);
    });

    it("should handle floating-point tolerance", () => {
      // Within default tolerance (0.01)
      expect(moneyEquals(100.001, 100)).toBe(true);
      expect(moneyEquals(100.004, 100)).toBe(true);

      // Outside default tolerance
      expect(moneyEquals(100.02, 100)).toBe(false);
      expect(moneyEquals(100.1, 100)).toBe(false);
    });

    it("should support custom tolerance", () => {
      expect(moneyEquals(100.05, 100, 0.1)).toBe(true);
      expect(moneyEquals(100.15, 100, 0.1)).toBe(false);
    });

    it("should return false on invalid input", () => {
      expect(moneyEquals(null, 100)).toBe(false);
      expect(moneyEquals(100, undefined)).toBe(false);
      expect(moneyEquals("abc", 100)).toBe(false);
    });
  });

  describe("moneyDifference", () => {
    it("should calculate difference between amounts", () => {
      expect(moneyDifference(100, 30)).toBe(70);
      expect(moneyDifference(100.5, 30.3)).toBe(70.2);
      expect(moneyDifference(100, 100)).toBe(0);
    });

    it("should handle string inputs", () => {
      expect(moneyDifference("100", "30")).toBe(70);
      expect(moneyDifference("100.50", "30.30")).toBe(70.2);
    });

    it("should handle Decimal objects", () => {
      const decimal1 = { toString: () => "100" };
      const decimal2 = { toString: () => "30" };
      expect(moneyDifference(decimal1, decimal2)).toBe(70);
    });

    it("should throw on invalid input", () => {
      expect(() => moneyDifference(null, 100)).toThrow();
      expect(() => moneyDifference(100, undefined)).toThrow();
    });
  });

  describe("moneyAdd", () => {
    it("should add amounts correctly", () => {
      expect(moneyAdd(100, 30)).toBe(130);
      expect(moneyAdd(100.5, 30.3)).toBe(130.8);
      expect(moneyAdd(0, 100)).toBe(100);
    });

    it("should handle string inputs", () => {
      expect(moneyAdd("100", "30")).toBe(130);
      expect(moneyAdd("100.50", "30.30")).toBe(130.8);
    });

    it("should handle Decimal objects", () => {
      const decimal1 = { toString: () => "100" };
      const decimal2 = { toString: () => "30" };
      expect(moneyAdd(decimal1, decimal2)).toBe(130);
    });

    it("should round result to 2 decimal places", () => {
      expect(moneyAdd(100.005, 30.005)).toBe(130.02);
    });

    it("should throw on invalid input", () => {
      expect(() => moneyAdd(null, 100)).toThrow();
      expect(() => moneyAdd(100, undefined)).toThrow();
    });
  });

  describe("Integration: OCR slip verification scenario", () => {
    it("should handle order total from database as string", () => {
      // Simulating: database returns orderTotal as string
      const orderTotalFromDb = "299.00";
      const extractedAmount = 299;

      const normalized = normalizeMoneyAmount(orderTotalFromDb, "orderTotal");
      expect(normalized).toBe(299);
      expect(Math.abs(extractedAmount - normalized)).toBeLessThan(0.01);
    });

    it("should handle order total from database as Decimal", () => {
      // Simulating: database returns orderTotal as Decimal object
      const orderTotalFromDb = { toString: () => "299.00" };
      const extractedAmount = 299;

      const normalized = normalizeMoneyAmount(orderTotalFromDb, "orderTotal");
      expect(normalized).toBe(299);
      expect(Math.abs(extractedAmount - normalized)).toBeLessThan(0.01);
    });

    it("should handle amount mismatch detection", () => {
      const orderTotal = "100.00";
      const extractedAmount = 99.50;

      const normalized = normalizeMoneyAmount(orderTotal, "orderTotal");
      const diff = Math.abs(extractedAmount - normalized);
      expect(diff).toBeGreaterThan(0.01);
    });

    it("should handle coupon discount calculation", () => {
      const subtotal = "299.00";
      const discountPercentage = 10;

      const subtotalNum = normalizeMoneyAmount(subtotal, "subtotal");
      const discountAmount = (subtotalNum * discountPercentage) / 100;
      const formatted = formatMoney(discountAmount, "discountAmount");

      expect(formatted).toBe("29.90");
    });

    it("should handle points balance from database", () => {
      // Simulating: database returns balance as string
      const balanceFromDb = "150.50";
      const pointsToRedeem = 100;

      const balance = normalizeMoneyAmount(balanceFromDb, "balance");
      expect(balance).toBe(150.5);
      expect(pointsToRedeem).toBeLessThanOrEqual(balance);
    });
  });
});
