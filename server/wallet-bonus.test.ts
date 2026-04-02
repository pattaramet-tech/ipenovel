import { describe, it, expect } from "vitest";
import { calculateBonus } from "./db";

describe("Wallet Bonus System", () => {
  describe("calculateBonus() function", () => {
    it("should return 0 bonus for amounts less than 250", () => {
      expect(calculateBonus(100)).toBe("0.00");
      expect(calculateBonus(249.99)).toBe("0.00");
      expect(calculateBonus("200")).toBe("0.00");
    });

    it("should return 10 bonus for amounts 250-499", () => {
      expect(calculateBonus(250)).toBe("10.00");
      expect(calculateBonus(300)).toBe("10.00");
      expect(calculateBonus(499.99)).toBe("10.00");
      expect(calculateBonus("350")).toBe("10.00");
    });

    it("should return 20 bonus for amounts 500 and above", () => {
      expect(calculateBonus(500)).toBe("20.00");
      expect(calculateBonus(1000)).toBe("20.00");
      expect(calculateBonus(999.99)).toBe("20.00");
      expect(calculateBonus("5000")).toBe("20.00");
    });

    it("should throw error for invalid amounts", () => {
      expect(() => calculateBonus(0)).toThrow();
      expect(() => calculateBonus(-100)).toThrow();
      expect(() => calculateBonus("invalid")).toThrow();
      expect(() => calculateBonus(NaN)).toThrow();
    });

    it("should handle string and number inputs consistently", () => {
      expect(calculateBonus("300")).toBe(calculateBonus(300));
      expect(calculateBonus("500")).toBe(calculateBonus(500));
      expect(calculateBonus("100")).toBe(calculateBonus(100));
    });
  });

  describe("Bonus Tier Boundaries", () => {
    it("should correctly handle tier boundaries", () => {
      // Boundary: 250
      expect(calculateBonus(249.99)).toBe("0.00");
      expect(calculateBonus(250.00)).toBe("10.00");
      expect(calculateBonus(250.01)).toBe("10.00");

      // Boundary: 500
      expect(calculateBonus(499.99)).toBe("10.00");
      expect(calculateBonus(500.00)).toBe("20.00");
      expect(calculateBonus(500.01)).toBe("20.00");
    });
  });

  describe("Bonus Calculation Precision", () => {
    it("should return properly formatted decimal strings", () => {
      const bonus = calculateBonus(300);
      expect(bonus).toMatch(/^\d+\.\d{2}$/);
      expect(bonus).toBe("10.00");
    });

    it("should handle floating point amounts correctly", () => {
      expect(calculateBonus(250.50)).toBe("10.00");
      expect(calculateBonus(500.75)).toBe("20.00");
      expect(calculateBonus(99.99)).toBe("0.00");
    });
  });
});
