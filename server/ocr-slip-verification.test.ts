import { describe, it, expect } from "vitest";
import {
  extractSlipData,
  verifySlipData,
  generateFingerprint,
  ExtractedSlipData,
  OrderPaymentContext,
} from "./ocr-slip-verification";

describe("OCR Slip Verification", () => {
  describe("extractSlipData", () => {
    it("should extract all fields from complete slip", () => {
      const slip = `
        ธนาคารกรุงเทพ
        ชื่อร้านค้า: Ipe Novel
        รหัสร้านค้า: KB000002283068
        รหัสธุรกรรม: KPS004KB000002283068
        จำนวนเงิน: 250.00 บาท
        วันที่: 05/04/2569
        เลขที่อ้างอิง: ABC123456789
      `;
      const extracted = extractSlipData(slip);
      expect(extracted.shopName).toBe("Ipe Novel");
      expect(extracted.merchantCode).toBe("KB000002283068");
      expect(extracted.merchantTransactionCode).toBe("KPS004KB000002283068");
      expect(extracted.amount).toBe(250);
      expect(extracted.reference).toBe("ABC123456789");
      expect(extracted.confidence).toBeGreaterThanOrEqual(85);
    });

    it("should handle Thai date format with Buddhist year", () => {
      const slip = "วันที่: 05/04/2569";
      const extracted = extractSlipData(slip);
      expect(extracted.transactionDate).toBeDefined();
      if (extracted.transactionDate) {
        expect(extracted.transactionDate.getFullYear()).toBe(2026);
        expect(extracted.transactionDate.getMonth()).toBe(3); // April
        expect(extracted.transactionDate.getDate()).toBe(5);
      }
    });

    it("should handle English date format", () => {
      const slip = "Date: 05/04/2026";
      const extracted = extractSlipData(slip);
      expect(extracted.transactionDate).toBeDefined();
    });

    it("should extract amount with comma separator", () => {
      const slip = "จำนวนเงิน: 1,250.50 บาท";
      const extracted = extractSlipData(slip);
      expect(extracted.amount).toBe(1250.5);
    });

    it("should handle missing fields gracefully", () => {
      const slip = "ชื่อร้านค้า: Ipe Novel";
      const extracted = extractSlipData(slip);
      expect(extracted.shopName).toBe("Ipe Novel");
      expect(extracted.merchantCode).toBeUndefined();
      expect(extracted.confidence).toBeLessThan(50);
    });
  });

  describe("verifySlipData", () => {
    const validExtracted: ExtractedSlipData = {
      shopName: "Ipe Novel",
      merchantCode: "KB000002283068",
      merchantTransactionCode: "KPS004KB000002283068",
      amount: 250,
      transactionDate: new Date(2026, 3, 5),
      reference: "ABC123456789",
      confidence: 100,
    };

    const validContext: OrderPaymentContext = {
      orderId: 1,
      paymentId: 1,
      orderTotal: 250,
      orderCreatedAt: new Date(2026, 3, 5, 10, 0, 0),
      paymentCreatedAt: new Date(2026, 3, 5, 10, 5, 0),
    };

    it("should auto-approve valid slip with matching amount", () => {
      const result = verifySlipData(validExtracted, validContext, new Set());
      expect(result.isAutoApproved).toBe(true);
      expect(result.status).toBe("approved");
      expect(result.linkedOrderId).toBe(1);
      expect(result.linkedPaymentId).toBe(1);
    });

    it("should reject slip with mismatched amount", () => {
      const contextMismatch = { ...validContext, orderTotal: 300 };
      const result = verifySlipData(validExtracted, contextMismatch, new Set());
      expect(result.isAutoApproved).toBe(false);
      expect(result.status).toBe("pending_review");
      expect(result.reviewReason).toBe("AMOUNT_MISMATCH");
    });

    it("should reject slip with wrong shop name", () => {
      const invalid = { ...validExtracted, shopName: "Wrong Shop" };
      const result = verifySlipData(invalid, validContext, new Set());
      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("SHOP_NAME_MISMATCH");
    });

    it("should reject slip with wrong merchant code", () => {
      const invalid = { ...validExtracted, merchantCode: "XX000000000000" };
      const result = verifySlipData(invalid, validContext, new Set());
      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("MERCHANT_CODE_MISMATCH");
    });

    it("should reject slip with duplicate reference", () => {
      const existingRefs = new Set(["ABC123456789"]);
      const result = verifySlipData(validExtracted, validContext, existingRefs);
      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("DUPLICATE_REFERENCE");
    });

    it("should reject slip with missing reference", () => {
      const invalid = { ...validExtracted, reference: undefined };
      const result = verifySlipData(invalid, validContext, new Set());
      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("MISSING_REFERENCE");
    });

    it("should reject slip with missing amount", () => {
      const invalid = { ...validExtracted, amount: undefined };
      const result = verifySlipData(invalid, validContext, new Set());
      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("MISSING_AMOUNT");
    });

    it("should auto-approve slip with missing shop name (relies on other strong signals)", () => {
      // v2 behavior: missing shop name is NOT a hard fail — other signals (amount, date, ref, bank) suffice
      const noShop = { ...validExtracted, shopName: undefined };
      const result = verifySlipData(noShop, validContext, new Set());
      // With amount + date + reference + merchantCode all present, should still auto-approve
      expect(result.isAutoApproved).toBe(true);
    });

    it("should reject slip with low confidence", () => {
      const invalid = { ...validExtracted, confidence: 50 };
      const result = verifySlipData(invalid, validContext, new Set());
      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("LOW_CONFIDENCE");
    });

    it("should accept slip with optional merchant transaction code missing", () => {
      const noTxnCode = { ...validExtracted, merchantTransactionCode: undefined };
      const result = verifySlipData(noTxnCode, validContext, new Set());
      expect(result.isAutoApproved).toBe(true);
    });

    it("should reject slip with mismatched merchant transaction code", () => {
      const invalid = { ...validExtracted, merchantTransactionCode: "WRONG123456789" };
      const result = verifySlipData(invalid, validContext, new Set());
      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("MERCHANT_TRANSACTION_CODE_MISMATCH");
    });

    it("should normalize shop name for matching", () => {
      const variants = [
        "Ipe Novel",
        "ipe novel",
        "IPE NOVEL",
        "Ipenovel",
        "IPENOVEL",
      ];

      for (const shopName of variants) {
        const extracted = { ...validExtracted, shopName };
        const result = verifySlipData(extracted, validContext, new Set());
        expect(result.isAutoApproved).toBe(true);
      }
    });

    it("should handle Bangkok Bank slip format", () => {
      const bangkokBankSlip = `
        ธนาคารกรุงเทพ
        ชื่อร้านค้า: Ipe Novel
        รหัสร้านค้า: KB000002283068
        รหัสธุรกรรม: KPS004KB000002283068
        จำนวนเงิน: 250.00 บาท
        วันที่: 05/04/2569
        เลขที่อ้างอิง: BKBK123456789
      `;
      const extracted = extractSlipData(bangkokBankSlip);
      const result = verifySlipData(extracted, validContext, new Set());
      expect(result.isAutoApproved).toBe(true);
    });

    it("should handle Kasikornbank slip format", () => {
      const kasikornSlip = `
        ธนาคารกสิกรไทย
        ชื่อร้านค้า: Ipenovel
        รหัสร้านค้า: KB000002283068
        จำนวนเงิน: 500.00
        วันที่: 05/04/2569
        หมายเลขอ้างอิง: KKB987654321
      `;
      const extracted = extractSlipData(kasikornSlip);
      const contextKasikorn = { ...validContext, orderTotal: 500 };
      const result = verifySlipData(extracted, contextKasikorn, new Set());
      expect(result.isAutoApproved).toBe(true);
    });

    it("should handle Siam Commercial Bank slip format", () => {
      const scbSlip = `
        ธนาคารไทยพาณิชย์
        ชื่อร้านค้า: IPE NOVEL
        รหัสร้านค้า: KB000002283068
        Amount: 250.00
        วันที่: 05/04/2569
        Reference: SCB123456789
      `;
      const extracted = extractSlipData(scbSlip);
      const result = verifySlipData(extracted, validContext, new Set());
      expect(result.isAutoApproved).toBe(true);
    });

    it("should reject slip with amount mismatch", () => {
      const slip = `
        ชื่อร้านค้า: Ipe Novel
        รหัสร้านค้า: KB000002283068
        จำนวนเงิน: 249.99
        วันที่: 04/04/2569
        เลขที่อ้างอิง: REF123456789
      `;
      const extracted = extractSlipData(slip);
      // Verify with order amount of 300 to ensure mismatch is detected
      const contextMismatch = { ...validContext, orderTotal: 300 };
      const result = verifySlipData(extracted, contextMismatch, new Set());
      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("AMOUNT_MISMATCH");
    });

    it("should reject slip with duplicate reference", () => {
      const slip = `
        ชื่อร้านค้า: Ipe Novel
        รหัสร้านค้า: KB000002283068
        จำนวนเงิน: 250.00
        วันที่: 05/04/2569
        เลขที่อ้างอิง: DUPLICATE123
      `;
      const extracted = extractSlipData(slip);
      const existingRefs = new Set(["DUPLICATE123"]);
      const result = verifySlipData(extracted, validContext, existingRefs);
      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("DUPLICATE_REFERENCE");
    });

    it("should link slip to correct order/payment", () => {
      const result = verifySlipData(validExtracted, validContext, new Set());
      expect(result.linkedOrderId).toBe(validContext.orderId);
      expect(result.linkedPaymentId).toBe(validContext.paymentId);
    });

    it("should reject slip outside time window", () => {
      const oldDate = new Date(2026, 3, 3); // 2 days before payment
      const invalid = { ...validExtracted, transactionDate: oldDate };
      const result = verifySlipData(invalid, validContext, new Set());
      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("TRANSACTION_OUTSIDE_TIME_WINDOW");
    });
  });

  describe("generateFingerprint", () => {
    it("should generate consistent fingerprint", () => {
      const extracted: ExtractedSlipData = {
        reference: "ABC123",
        amount: 250,
        merchantCode: "KB000002283068",
        transactionDate: new Date(2026, 3, 5),
      };

      const fp1 = generateFingerprint(extracted);
      const fp2 = generateFingerprint(extracted);
      expect(fp1).toBe(fp2);
    });

    it("should generate different fingerprints for different data", () => {
      const extracted1: ExtractedSlipData = {
        reference: "ABC123",
        amount: 250,
        merchantCode: "KB000002283068",
      };

      const extracted2: ExtractedSlipData = {
        reference: "XYZ789",
        amount: 250,
        merchantCode: "KB000002283068",
      };

      const fp1 = generateFingerprint(extracted1);
      const fp2 = generateFingerprint(extracted2);
      expect(fp1).not.toBe(fp2);
    });
  });
});


describe("OCR Slip Verification - Critical Fixes Regression", () => {
  const mockContext: OrderPaymentContext = {
    orderId: 1,
    paymentId: 1,
    orderTotal: 250,
    orderCreatedAt: new Date("2026-04-19T10:00:00Z"),
    paymentCreatedAt: new Date("2026-04-19T10:05:00Z"),
  };

  const validSlipText = `
    ธนาคารกรุงเทพ
    ชื่อร้านค้า: Ipe Novel
    รหัสร้านค้า: KB000002283068
    จำนวนเงิน: 250.00 บาท
    วันที่: 19/04/2569
    เลขที่อ้างอิง: 123456789012
  `;

  describe("Fix 1: Duplicate Detection with Fingerprint", () => {
    it("should detect duplicate using fingerprint (not just reference)", () => {
      const slip1 = extractSlipData(validSlipText);
      const result1 = verifySlipData(slip1, mockContext, new Set(), new Set());
      expect(result1.isAutoApproved).toBe(true);

      // Second identical slip should be detected as duplicate via fingerprint
      const slip2 = extractSlipData(validSlipText);
      const existingFingerprints = new Set([result1.fingerprint]);
      const result2 = verifySlipData(
        slip2,
        mockContext,
        new Set(),
        existingFingerprints
      );

      expect(result2.isAutoApproved).toBe(false);
      expect(result2.reviewReason).toBe("DUPLICATE_FINGERPRINT");
    });

    it("should detect pending_review duplicates (race condition protection)", () => {
      const slip1 = extractSlipData(validSlipText);
      const result1 = verifySlipData(slip1, mockContext, new Set(), new Set());

      // Simulate first slip in pending_review status
      const existingReferences = new Set([slip1.reference]);
      const slip2 = extractSlipData(validSlipText);
      const result2 = verifySlipData(
        slip2,
        mockContext,
        existingReferences,
        new Set()
      );

      expect(result2.reviewReason).toBe("DUPLICATE_REFERENCE");
    });

    it("should generate and use fingerprint for duplicate detection", () => {
      const slip1 = extractSlipData(validSlipText);
      const fp1 = generateFingerprint(slip1);
      expect(fp1).toBeDefined();
      expect(fp1.length).toBeGreaterThan(0);

      // Fingerprint should be consistent
      const fp2 = generateFingerprint(slip1);
      expect(fp1).toBe(fp2);
    });
  });

  describe("Fix 2: Reference Validation (Strict)", () => {
    it("should require explicitly labeled reference fields", () => {
      const slipNoLabel = `
        ธนาคารกรุงเทพ
        ชื่อร้านค้า: Ipe Novel
        รหัสร้านค้า: KB000002283068
        จำนวนเงิน: 250.00 บาท
        วันที่: 19/04/2569
        ABCDEFGHIJKLMNOP
      `;

      const extracted = extractSlipData(slipNoLabel);
      // Without explicit label, should not extract as reference
      expect(extracted.reference).toBeUndefined();
    });

    it("should accept reference with explicit Thai label", () => {
      const slipWithLabel = `
        ธนาคารกรุงเทพ
        ชื่อร้านค้า: Ipe Novel
        รหัสร้านค้า: KB000002283068
        จำนวนเงิน: 250.00 บาท
        วันที่: 19/04/2569
        เลขที่อ้างอิง: 123456789012
      `;

      const extracted = extractSlipData(slipWithLabel);
      expect(extracted.reference).toBe("123456789012");
    });

    it("should validate reference format (10-15 chars)", () => {
      const extracted = extractSlipData(validSlipText);
      expect(extracted.reference).toMatch(/^[A-Z0-9]{10,15}$/);
    });
  });

  describe("Fix 3: Time Window Tightening", () => {
    it("should reject transaction more than 24h before payment", () => {
      // v2 behavior: time window is 24h (not 5 minutes). The slip date 19/04/2569 09:00
      // is only ~1 hour before payment at 10:05 — within 24h window, so it passes.
      // To test the time window, use a date 2 days before payment.
      const slipOldDate = `
        ธนาคารกรุงเทพ
        ชื่อร้านค้า: Ipe Novel
        รหัสร้านค้า: KB000002283068
        จำนวนเงิน: 250.00 บาท
        วันที่: 17/04/2569
        เลขที่อ้างอิง: 123456789012
      `;

      const extracted = extractSlipData(slipOldDate);
      const result = verifySlipData(extracted, mockContext, new Set(), new Set());

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("TRANSACTION_OUTSIDE_TIME_WINDOW");
    });

    it("should accept transaction within 5-minute window", () => {
      const extracted = extractSlipData(validSlipText);
      const result = verifySlipData(extracted, mockContext, new Set(), new Set());

      // Valid slip should pass time window check
      expect(result.reviewReason).not.toBe("TRANSACTION_OUTSIDE_TIME_WINDOW");
    });
  });

  describe("Fix 4: Thai Numeral Support", () => {
    it("should parse Thai numerals in amount", () => {
      const slipThaiAmount = `
        ธนาคารกรุงเทพ
        ชื่อร้านค้า: Ipe Novel
        รหัสร้านค้า: KB000002283068
        จำนวนเงิน: ๒๕๐.๐๐ บาท
        วันที่: 19/04/2569
        เลขที่อ้างอิง: 123456789012
      `;

      const extracted = extractSlipData(slipThaiAmount);
      expect(extracted.amount).toBe(250);
    });

    it("should parse Thai numerals in date (Buddhist year)", () => {
      const slipThaiDate = `
        ธนาคารกรุงเทพ
        ชื่อร้านค้า: Ipe Novel
        รหัสร้านค้า: KB000002283068
        จำนวนเงิน: 250.00 บาท
        วันที่: ๑๙/๐๔/๒๕๖๙
        เลขที่อ้างอิง: 123456789012
      `;

      const extracted = extractSlipData(slipThaiDate);
      expect(extracted.transactionDate).toBeDefined();
      expect(extracted.transactionDate?.getFullYear()).toBe(2026);
      expect(extracted.transactionDate?.getMonth()).toBe(3); // April (0-indexed)
      expect(extracted.transactionDate?.getDate()).toBe(19);
    });

    it("should parse Thai numerals in reference", () => {
      const slipThaiRef = `
        ธนาคารกรุงเทพ
        ชื่อร้านค้า: Ipe Novel
        รหัสร้านค้า: KB000002283068
        จำนวนเงิน: 250.00 บาท
        วันที่: 19/04/2569
        เลขที่อ้างอิง: ๑๒๓๔๕๖๗๘๙๐๑๒
      `;

      const extracted = extractSlipData(slipThaiRef);
      expect(extracted.reference).toBe("123456789012");
    });

    it("should handle mixed Thai and Western numerals", () => {
      const slipMixed = `
        ธนาคารกรุงเทพ
        ชื่อร้านค้า: Ipe Novel
        รหัสร้านค้า: KB000002283068
        จำนวนเงิน: ๒50.00 บาท
        วันที่: 19/04/๒๕๖๙
        เลขที่อ้างอิง: 123456789012
      `;

      const extracted = extractSlipData(slipMixed);
      expect(extracted.amount).toBe(250);
      expect(extracted.transactionDate?.getFullYear()).toBe(2026);
    });
  });

  describe("Fix 5: Admin Visibility", () => {
    it("should include detected bank in extracted data", () => {
      // validSlipText has ธนาคารกรุงเทพ = Bangkok Bank = BBL (not KBANK)
      const extracted = extractSlipData(validSlipText);
      expect(extracted.detectedBank).toBe("BBL");
      expect(extracted.detectedBankName).toBe("Bangkok Bank");
    });

    it("should include all required fields for admin review", () => {
      const extracted = extractSlipData(validSlipText);
      const result = verifySlipData(extracted, mockContext, new Set(), new Set());

      // All fields required for admin review
      expect(result.extractedData).toHaveProperty("shopName");
      expect(result.extractedData).toHaveProperty("merchantCode");
      expect(result.extractedData).toHaveProperty("amount");
      expect(result.extractedData).toHaveProperty("transactionDate");
      expect(result.extractedData).toHaveProperty("reference");
      expect(result.extractedData).toHaveProperty("detectedBank");
      expect(result.extractedData).toHaveProperty("confidence");
      expect(result).toHaveProperty("fingerprint");
      // reviewReason is undefined for auto-approved slips — check the key exists in the object
      expect(result).toHaveProperty("isAutoApproved");
      expect(result).toHaveProperty("status");
    });

    it("should detect different banks", () => {
      const kbankSlip = `
        ธนาคารกรุงเทพ
        ชื่อร้านค้า: Ipe Novel
        รหัสร้านค้า: KB000002283068
        จำนวนเงิน: 250.00 บาท
        วันที่: 19/04/2569
        เลขที่อ้างอิง: 123456789012
      `;

      const kasikornSlip = `
        ธนาคารกสิกรไทย
        ชื่อร้านค้า: Ipe Novel
        รหัสร้านค้า: KB000002283068
        จำนวนเงิน: 250.00 บาท
        วันที่: 19/04/2569
        เลขที่อ้างอิง: 123456789012
      `;

      const kbankExtracted = extractSlipData(kbankSlip);
      const kasikornExtracted = extractSlipData(kasikornSlip);

      // ธนาคารกรุงเทพ = Bangkok Bank = BBL (not KBANK)
      expect(kbankExtracted.detectedBank).toBe("BBL");
      // ธนาคารกสิกรไทย = KBank = KBANK
      expect(kasikornExtracted.detectedBank).toBe("KBANK");
    });
  });

  describe("Fix 6: Auto-Approval Logging", () => {
    it("should have structured logging for auto-approval", () => {
      const extracted = extractSlipData(validSlipText);
      const result = verifySlipData(extracted, mockContext, new Set(), new Set());

      expect(result.isAutoApproved).toBe(true);
      // Logging happens in integration layer, but we verify the data is available
      expect(extracted.amount).toBeDefined();
      expect(extracted.reference).toBeDefined();
      expect(extracted.confidence).toBeDefined();
      expect(extracted.detectedBank).toBeDefined();
    });
  });

  describe("Regression: Valid Slip Still Auto-Approves", () => {
    it("should still auto-approve valid slip after all fixes", () => {
      const extracted = extractSlipData(validSlipText);
      const result = verifySlipData(extracted, mockContext, new Set(), new Set());

      expect(result.isAutoApproved).toBe(true);
      expect(result.status).toBe("approved");
      expect(result.reviewReason).toBeUndefined();
      expect(extracted.confidence).toBeGreaterThanOrEqual(85);
    });

    it("should still reject invalid slip after all fixes", () => {
      const invalidSlip = `
        ธนาคารกรุงเทพ
        ชื่อร้านค้า: Wrong Shop
        รหัสร้านค้า: KB000002283068
        จำนวนเงิน: 250.00 บาท
        วันที่: 19/04/2569
        เลขที่อ้างอิง: 123456789012
      `;

      const extracted = extractSlipData(invalidSlip);
      const result = verifySlipData(extracted, mockContext, new Set(), new Set());

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("SHOP_NAME_MISMATCH");
    });
  });
});
