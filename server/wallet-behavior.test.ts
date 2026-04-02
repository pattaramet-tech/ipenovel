import { describe, it, expect } from "vitest";
import * as db from "./db";

describe("Wallet System - Behavior & Regression Tests", () => {
  describe("Bonus Calculation", () => {
    it("should calculate 0 bonus for amounts below 250", () => {
      const bonus = db.calculateBonus("100.00");
      expect(bonus).toBe("0.00");
    });

    it("should calculate 10 bonus for amounts 250-499", () => {
      const bonus = db.calculateBonus("250.00");
      expect(bonus).toBe("10.00");
    });

    it("should calculate 20 bonus for amounts 500+", () => {
      const bonus = db.calculateBonus("500.00");
      expect(bonus).toBe("20.00");
    });

    it("should handle edge case: 249.99", () => {
      const bonus = db.calculateBonus("249.99");
      expect(bonus).toBe("0.00");
    });

    it("should handle edge case: 250.00", () => {
      const bonus = db.calculateBonus("250.00");
      expect(bonus).toBe("10.00");
    });

    it("should handle edge case: 499.99", () => {
      const bonus = db.calculateBonus("499.99");
      expect(bonus).toBe("10.00");
    });

    it("should handle edge case: 500.00", () => {
      const bonus = db.calculateBonus("500.00");
      expect(bonus).toBe("20.00");
    });
  });
});
