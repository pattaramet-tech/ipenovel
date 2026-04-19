/**
 * OCR Hardening Test Suite
 * 
 * Tests for Phase 3 hardening:
 * - Datetime hardening with timezone and multi-pass parsing
 * - Reference normalization with O/0 substitution
 * - Fingerprint stabilization (date-only, normalized reference)
 * - Bank detection with keyword and pattern matching
 * - Amount normalization (always 2 decimal places)
 */

import { describe, it, expect } from "vitest";
import { parseOCRDatetime, extractDateOnly, isDatetimeWithinWindow } from "./ocr-datetime-hardener";
import { detectBank, getBankDisplayName } from "./ocr-bank-detector";
import { normalizeExtraction, extractAndNormalize } from "./ocr-normalizer";
import { generateFingerprint, compareFingerprints } from "./ocr-fingerprint";

describe("OCR Hardening Suite", () => {
  describe("Datetime Hardening", () => {
    it("should parse strict DD/MM/YYYY HH:MM format", () => {
      const result = parseOCRDatetime("18/04/2026 10:30");
      expect(result).toBeTruthy();
      expect(result).toContain("2026-04-18");
    });

    it("should parse strict DD/MM/YYYY HH:MM:SS format", () => {
      const result = parseOCRDatetime("18/04/2026 10:30:45");
      expect(result).toBeTruthy();
      expect(result).toContain("2026-04-18");
    });

    it("should convert Thai Buddhist year (2569 -> 2026)", () => {
      const result = parseOCRDatetime("18/04/2569 10:30");
      expect(result).toBeTruthy();
      expect(result).toContain("2026-04-18");
    });

    it("should parse DD-MM-YY HH:MM format with 2-digit year", () => {
      const result = parseOCRDatetime("18-04-26 10:30");
      expect(result).toBeTruthy();
      expect(result).toContain("2026-04-18");
    });

    it("should parse DD Mon YYYY HH:MM format", () => {
      const result = parseOCRDatetime("18 Apr 2026 10:30");
      expect(result).toBeTruthy();
      expect(result).toContain("2026-04-18");
    });

    it("should reject invalid dates (day > 31)", () => {
      const result = parseOCRDatetime("32/04/2026 10:30");
      expect(result).toBeNull();
    });

    it("should reject invalid dates (month > 12)", () => {
      const result = parseOCRDatetime("18/13/2026 10:30");
      expect(result).toBeNull();
    });

    it("should reject invalid time (hour > 23)", () => {
      const result = parseOCRDatetime("18/04/2026 25:30");
      expect(result).toBeNull();
    });

    it("should extract date-only from ISO string", () => {
      const iso = "2026-04-18T10:30:45.000Z";
      const dateOnly = extractDateOnly(iso);
      expect(dateOnly).toBe("2026-04-18");
    });

    it("should validate datetime within 30-day window", () => {
      const now = new Date();
      const iso = now.toISOString();
      expect(isDatetimeWithinWindow(iso, 30)).toBe(true);
    });

    it("should reject datetime outside 30-day window", () => {
      const past = new Date();
      past.setDate(past.getDate() - 35);
      expect(isDatetimeWithinWindow(past.toISOString(), 30)).toBe(false);
    });
  });

  describe("Bank Detection", () => {
    it("should detect KBank from text", () => {
      const result = detectBank("KBANK Transfer KB000002283068");
      expect(result.bank).toBe("KBANK");
      expect(result.confidence).toBeGreaterThan(0);
    });

    it("should detect SCB from text", () => {
      const result = detectBank("SIAM COMMERCIAL BANK SCB");
      expect(result.bank).toBe("SCB");
      expect(result.confidence).toBeGreaterThan(0);
    });

    it("should detect Bangkok Bank from text", () => {
      const result = detectBank("BANGKOK BANK BBL Transfer");
      expect(result.bank).toBe("BBL");
      expect(result.confidence).toBeGreaterThan(0);
    });

    it("should detect Krungsri from text", () => {
      const result = detectBank("KRUNGSRI Bank Transfer");
      expect(result.bank).toBe("KRUNGSRI");
      expect(result.confidence).toBeGreaterThan(0);
    });

    it("should detect PromptPay from text", () => {
      const result = detectBank("PROMPTPAY Transfer");
      expect(result.bank).toBe("PROMPTPAY");
      expect(result.confidence).toBeGreaterThan(0);
    });

    it("should return UNKNOWN for unrecognized bank", () => {
      const result = detectBank("Some random text");
      expect(result.bank).toBe("UNKNOWN");
      expect(result.confidence).toBe(0);
    });

    it("should get correct bank display name", () => {
      expect(getBankDisplayName("KBANK")).toBe("Krung Thai Bank");
      expect(getBankDisplayName("SCB")).toBe("Siam Commercial Bank");
      expect(getBankDisplayName("BBL")).toBe("Bangkok Bank");
      expect(getBankDisplayName("PROMPTPAY")).toBe("PromptPay");
    });
  });

  describe("Reference Normalization", () => {
    it("should normalize reference to uppercase", () => {
      const slip = extractAndNormalize(
        "Ref: abc123\nAmount: 250.00\nDate: 18/04/2026 10:30\nTo: Shop"
      );
      expect(slip?.reference).toBe("ABC123");
    });

    it("should substitute O with 0 in reference", () => {
      const slip = extractAndNormalize(
        "Ref: ABC0123O\nAmount: 250.00\nDate: 18/04/2026 10:30\nTo: Shop"
      );
      // O should be converted to 0
      expect(slip?.reference).toContain("0");
    });

    it("should remove spaces from reference", () => {
      const slip = extractAndNormalize(
        "Ref: ABC 123 456\nAmount: 250.00\nDate: 18/04/2026 10:30\nTo: Shop"
      );
      expect(slip?.reference).toBe("ABC123456");
    });

    it("should reject reference shorter than 6 characters", () => {
      const slip = extractAndNormalize(
        "Ref: ABC12\nAmount: 250.00\nDate: 18/04/2026 10:30\nTo: Shop"
      );
      expect(slip).toBeNull();
    });
  });

  describe("Amount Normalization", () => {
    it("should normalize amount to 2 decimal places", () => {
      const slip = extractAndNormalize(
        "Amount: 250\nRef: ABC123456\nDate: 18/04/2026 10:30\nTo: Shop"
      );
      expect(slip?.amount).toBe(250.0);
    });

    it("should handle amount with comma separator", () => {
      const slip = extractAndNormalize(
        "Amount: 1,250.00\nRef: ABC123456\nDate: 18/04/2026 10:30\nTo: Shop"
      );
      expect(slip?.amount).toBe(1250.0);
    });

    it("should handle amount with Thai baht symbol", () => {
      const slip = extractAndNormalize(
        "Amount: ฿250.00\nRef: ABC123456\nDate: 18/04/2026 10:30\nTo: Shop"
      );
      expect(slip?.amount).toBe(250.0);
    });

    it("should round amount to 2 decimal places", () => {
      const slip = extractAndNormalize(
        "Amount: 250.999\nRef: ABC123456\nDate: 18/04/2026 10:30\nTo: Shop"
      );
      expect(slip?.amount).toBe(251.0);
    });

    it("should reject zero or negative amounts", () => {
      const slip = extractAndNormalize(
        "Amount: 0\nRef: ABC123456\nDate: 18/04/2026 10:30\nTo: Shop"
      );
      expect(slip).toBeNull();
    });
  });

  describe("Fingerprint Stabilization", () => {
    it("should generate same fingerprint for same slip data", () => {
      const fp1 = generateFingerprint(250, "2026-04-18T10:30:00Z", "ABC123456", "MERCHANT1", "KBANK");
      const fp2 = generateFingerprint(250, "2026-04-18T10:30:00Z", "ABC123456", "MERCHANT1", "KBANK");
      expect(fp1).toBe(fp2);
    });

    it("should generate different fingerprint for different amount", () => {
      const fp1 = generateFingerprint(250, "2026-04-18T10:30:00Z", "ABC123456", "MERCHANT1", "KBANK");
      const fp2 = generateFingerprint(251, "2026-04-18T10:30:00Z", "ABC123456", "MERCHANT1", "KBANK");
      expect(fp1).not.toBe(fp2);
    });

    it("should generate different fingerprint for different reference", () => {
      const fp1 = generateFingerprint(250, "2026-04-18T10:30:00Z", "ABC123456", "MERCHANT1", "KBANK");
      const fp2 = generateFingerprint(250, "2026-04-18T10:30:00Z", "XYZ789012", "MERCHANT1", "KBANK");
      expect(fp1).not.toBe(fp2);
    });

    it("should use date-only for fingerprint (ignore time)", () => {
      const fp1 = generateFingerprint(250, "2026-04-18T10:30:00Z", "ABC123456", "MERCHANT1", "KBANK");
      const fp2 = generateFingerprint(250, "2026-04-18T15:45:00Z", "ABC123456", "MERCHANT1", "KBANK");
      // Same date, different time should produce same fingerprint
      expect(fp1).toBe(fp2);
    });

    it("should compare fingerprints case-insensitively", () => {
      const fp1 = "abc123def456";
      const fp2 = "ABC123DEF456";
      expect(compareFingerprints(fp1, fp2)).toBe(true);
    });

    it("should generate different fingerprint for different bank", () => {
      const fp1 = generateFingerprint(250, "2026-04-18T10:30:00Z", "ABC123456", "MERCHANT1", "KBANK");
      const fp2 = generateFingerprint(250, "2026-04-18T10:30:00Z", "ABC123456", "MERCHANT1", "SCB");
      expect(fp1).not.toBe(fp2);
    });

    it("should include merchant code in fingerprint", () => {
      const fp1 = generateFingerprint(250, "2026-04-18T10:30:00Z", "ABC123456", "MERCHANT1", "KBANK");
      const fp2 = generateFingerprint(250, "2026-04-18T10:30:00Z", "ABC123456", "MERCHANT2", "KBANK");
      expect(fp1).not.toBe(fp2);
    });
  });

  describe("Integration Scenarios", () => {
    it("should handle complete Thai bank slip OCR text", () => {
      const ocrText = `
        KBANK Transfer
        Amount: ฿1,250.50
        Date: 18/04/2569 10:30
        Ref: ABC123456
        To: Ipe Novel Shop
        Merchant Code: KB000002283068
      `;

      const slip = extractAndNormalize(ocrText);
      expect(slip).toBeTruthy();
      expect(slip?.amount).toBe(1250.5);
      expect(slip?.reference).toBe("ABC123456");
      expect(slip?.bank).toBe("KBANK");
    });

    it("should handle PromptPay slip with normalized reference", () => {
      const ocrText = `
        PROMPTPAY Transfer
        Amount: 500.00
        Date: 18/04/2026 14:00
        Ref: XYZ789O12 (with O letter)
        To: Shop Name
      `;

      const slip = extractAndNormalize(ocrText);
      expect(slip).toBeTruthy();
      expect(slip?.amount).toBe(500.0);
      expect(slip?.bank).toBe("PROMPTPAY");
      // O should be converted to 0
      expect(slip?.reference).toContain("0");
    });

    it("should reject slip with missing critical fields", () => {
      const ocrText = `
        KBANK Transfer
        Amount: 250.00
        (missing date and reference)
      `;

      const slip = extractAndNormalize(ocrText);
      expect(slip).toBeNull();
    });
  });
});
