import { describe, it, expect } from "vitest";
import { calculateBonus } from "./db";

describe("Wallet Bonus System", () => {
  describe("calculateBonus() function", () => {
    it("should return 0 bonus for amounts less than 250", async () => {
      expect(await calculateBonus(100)).toBe("0.00");
      expect(await calculateBonus(249.99)).toBe("0.00");
      expect(await calculateBonus("200")).toBe("0.00");
    });

    it("should return 10 bonus for amounts 250-499", async () => {
      expect(await calculateBonus(250)).toBe("10.00");
      expect(await calculateBonus(300)).toBe("10.00");
      expect(await calculateBonus(499.99)).toBe("10.00");
      expect(await calculateBonus("350")).toBe("10.00");
    });

    it("should return 20 bonus for amounts 500 and above", async () => {
      expect(await calculateBonus(500)).toBe("20.00");
      expect(await calculateBonus(1000)).toBe("20.00");
      expect(await calculateBonus(999.99)).toBe("20.00");
      expect(await calculateBonus("5000")).toBe("20.00");
    });

    it("should handle string and number inputs consistently", async () => {
      expect(await calculateBonus("300")).toBe(await calculateBonus(300));
      expect(await calculateBonus("500")).toBe(await calculateBonus(500));
      expect(await calculateBonus("100")).toBe(await calculateBonus(100));
    });
  });

  describe("Bonus Tier Boundaries", () => {
    it("should correctly handle tier boundaries", async () => {
      // Boundary: 250
      expect(await calculateBonus(249.99)).toBe("0.00");
      expect(await calculateBonus(250.00)).toBe("10.00");
      expect(await calculateBonus(250.01)).toBe("10.00");

      // Boundary: 500
      expect(await calculateBonus(499.99)).toBe("10.00");
      expect(await calculateBonus(500.00)).toBe("20.00");
      expect(await calculateBonus(500.01)).toBe("20.00");
    });
  });

  describe("Bonus Calculation Precision", () => {
    it("should return properly formatted decimal strings", async () => {
      const bonus = await calculateBonus(300);
      expect(bonus).toMatch(/^\d+\.\d{2}$/);
      expect(bonus).toBe("10.00");
    });

    it("should handle floating point amounts correctly", async () => {
      expect(await calculateBonus(250.50)).toBe("10.00");
      expect(await calculateBonus(500.75)).toBe("20.00");
      expect(await calculateBonus(99.99)).toBe("0.00");
    });
  });
});
