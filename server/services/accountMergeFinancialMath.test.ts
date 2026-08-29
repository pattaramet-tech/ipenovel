import { describe, expect, it } from "vitest";
import {
  addNonNegativeFixedDecimals,
  decimalToMinorUnits,
  minorUnitsToDecimal,
} from "./accountMergeFinancialMath";

describe("IPE-006 fixed-decimal financial math", () => {
  it("adds cent-scale decimals exactly without binary floating-point drift", () => {
    const result = addNonNegativeFixedDecimals("0.01", "0.02", "wallet", { precision: 12, scale: 2 });
    expect(result.leftMinor).toBe(1);
    expect(result.rightMinor).toBe(2);
    expect(result.sumMinor).toBe(3);
    expect(result.sum).toBe("0.03");
  });

  it("preserves trailing scale and handles the largest safe sum at the schema boundary", () => {
    const result = addNonNegativeFixedDecimals(
      "9999999999.98",
      "0.01",
      "wallet",
      { precision: 12, scale: 2 }
    );
    expect(result.sum).toBe("9999999999.99");
    expect(minorUnitsToDecimal(result.sumMinor, 2)).toBe("9999999999.99");
  });

  it("rejects a merged value that would overflow the database DECIMAL capacity before any write", () => {
    expect(() =>
      addNonNegativeFixedDecimals("9999999999.99", "0.01", "wallet", { precision: 12, scale: 2 })
    ).toThrow("exceeds DECIMAL(12,2) capacity after merge");
  });

  it("rejects negative balances, exponent notation, and more fractional digits than the schema allows", () => {
    expect(() => decimalToMinorUnits("-0.01", "balance", { precision: 10, scale: 2 })).toThrow("non-negative");
    expect(() => decimalToMinorUnits("1e3", "balance", { precision: 10, scale: 2 })).toThrow("plain decimal");
    expect(() => decimalToMinorUnits("1.001", "balance", { precision: 10, scale: 2 })).toThrow("exceeds scale 2");
  });

  it("normalizes whole and one-decimal database values to exact minor units", () => {
    expect(decimalToMinorUnits("0", "zero", { precision: 10, scale: 2 })).toBe(0);
    expect(decimalToMinorUnits("12.3", "oneDecimal", { precision: 10, scale: 2 })).toBe(1230);
    expect(minorUnitsToDecimal(-1230, 2)).toBe("-12.30");
  });
});
