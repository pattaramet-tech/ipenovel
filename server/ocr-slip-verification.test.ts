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

    it("should reject slip with missing shop name", () => {
      const invalid = { ...validExtracted, shopName: undefined };
      const result = verifySlipData(invalid, validContext, new Set());
      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("MISSING_SHOP_NAME");
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
