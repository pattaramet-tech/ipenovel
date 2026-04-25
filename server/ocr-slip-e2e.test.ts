import { describe, it, expect } from "vitest";
import { extractSlipData, verifySlipData } from "./ocr-slip-verification";
import { processSlipVerification } from "./ocr-slip-integration";

/**
 * End-to-End Tests for OCR Slip Auto-Approval System
 * Tests the complete flow from slip extraction to auto-approval decision
 */

describe("OCR Slip Auto-Approval - End-to-End", () => {
  describe("Complete Auto-Approval Flow", () => {
    it("should auto-approve valid slip with all fields and high confidence", () => {
      // Simulate a complete Thai bank slip with all required fields
      const completeSlip = `
        ธนาคารกรุงเทพ
        วันที่ทำการ: 06/04/2569
        ชื่อร้านค้า: Ipe Novel
        รหัสร้านค้า: KB000002283068
        รหัสธุรกรรม: KPS004KB000002283068
        จำนวนเงิน: 500.00 บาท
        วันที่: 06/04/2569 09:00
        เลขที่อ้างอิง: REF20260406001
        ธนาคารต้นทาง: ธนาคารกรุงเทพ
        ธนาคารปลายทาง: ธนาคารกรุงเทพ
      `;

      const extracted = extractSlipData(completeSlip);
      
      // Verify extraction captured all fields
      expect(extracted.shopName).toBe("Ipe Novel");
      expect(extracted.merchantCode).toBe("KB000002283068");
      expect(extracted.merchantTransactionCode).toBe("KPS004KB000002283068");
      expect(extracted.amount).toBe(500);
      expect(extracted.reference).toBe("REF20260406001");
      expect(extracted.confidence).toBeGreaterThanOrEqual(85);

      // Verify against order context
      const paymentTime = new Date("2026-04-06T14:00:00");
      const context = {
        paymentId: 1,
        orderId: 1,
        orderTotal: 500,
        orderCreatedAt: paymentTime,
        paymentCreatedAt: paymentTime,
      };
      const existingReferences = new Set<string>();

      const result = verifySlipData(extracted, context, existingReferences);

      expect(result.isAutoApproved).toBe(true);
      expect(result.status).toBe("approved");
      expect(result.reviewReason).toBeUndefined();
      expect(result.linkedOrderId).toBe(1);
      expect(result.linkedPaymentId).toBe(1);
    });

    it("should auto-approve slip with normalized shop name variations", () => {
      const slips = [
        "ชื่อร้านค้า: Ipe Novel",
        "ชื่อร้านค้า: Ipenovel",
        "ชื่อร้านค้า: IPE NOVEL",
        "ชื่อร้านค้า: ipe novel",
      ];

      const paymentTime = new Date("2026-04-06T14:00:00");
      const context = {
        paymentId: 1,
        orderId: 1,
        orderTotal: 250,
        orderCreatedAt: paymentTime,
        paymentCreatedAt: paymentTime,
      };

      for (const shopNameLine of slips) {
        const slip = `
          ${shopNameLine}
          รหัสร้านค้า: KB000002283068
          รหัสธุรกรรม: KPS004KB000002283068
          จำนวนเงิน: 250.00 บาท
          วันที่: 06/04/2569 10:00
          เลขที่อ้างอิง: REF0000${String(slips.indexOf(shopNameLine)).padStart(5, "0")}
        `;

        const extracted = extractSlipData(slip);
        const result = verifySlipData(extracted, context, new Set());

        expect(result.isAutoApproved).toBe(true);
        expect(result.status).toBe("approved");
      }
    });

    it("should flag for pending_review when confidence is below 85%", () => {
      // Slip with missing merchant transaction code and reference (reduces confidence)
      const lowConfidenceSlip = `
        ชื่อร้านค้า: Ipe Novel
        รหัสร้านค้า: KB000002283068
        จำนวนเงิน: 250.00 บาท
      `;

      const extracted = extractSlipData(lowConfidenceSlip);
      
      // Confidence should be low (missing reference, transaction code, and date)
      expect(extracted.confidence).toBeLessThanOrEqual(70);

      const paymentTime = new Date("2026-04-06T14:00:00");
      const context = {
        paymentId: 1,
        orderId: 1,
        orderTotal: 250,
        orderCreatedAt: paymentTime,
        paymentCreatedAt: paymentTime,
      };

      const result = verifySlipData(extracted, context, new Set());
      
      expect(result.isAutoApproved).toBe(false);
      expect(result.status).toBe("pending_review");
      expect(result.reviewReason).toBe("MISSING_TRANSACTION_DATE");
    });
  });

  describe("Rejection Scenarios", () => {
    it("should reject slip with amount mismatch", () => {
      const slip = `
        ชื่อร้านค้า: Ipe Novel
        รหัสร้านค้า: KB000002283068
        รหัสธุรกรรม: KPS004KB000002283068
        จำนวนเงิน: 249.98 บาท
        วันที่: 06/04/2569 10:00
        เลขที่อ้างอิง: MISMATCH001
      `;

      const extracted = extractSlipData(slip);
      const paymentTime = new Date("2026-04-06T14:00:00");
      const context = {
        paymentId: 1,
        orderId: 1,
        orderTotal: 250,
        orderCreatedAt: paymentTime,
        paymentCreatedAt: paymentTime,
      };

      const result = verifySlipData(extracted, context, new Set());

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("AMOUNT_MISMATCH");
    });

    it("should reject slip with merchant code mismatch", () => {
      const slip = `
        ชื่อร้านค้า: Ipe Novel
        รหัสร้านค้า: KB000002283999
        รหัสธุรกรรม: KPS004KB000002283068
        จำนวนเงิน: 250.00 บาท
        วันที่: 06/04/2569 10:00
        เลขที่อ้างอิง: MERCHANT001
      `;

      const extracted = extractSlipData(slip);
      const paymentTime = new Date("2026-04-06T14:00:00");
      const context = {
        paymentId: 1,
        orderId: 1,
        orderTotal: 250,
        orderCreatedAt: paymentTime,
        paymentCreatedAt: paymentTime,
      };

      const result = verifySlipData(extracted, context, new Set());

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("MERCHANT_CODE_MISMATCH");
    });

    it("should reject slip with shop name mismatch", () => {
      const slip = `
        ชื่อร้านค้า: Wrong Shop
        รหัสร้านค้า: KB000002283068
        รหัสธุรกรรม: KPS004KB000002283068
        จำนวนเงิน: 250.00 บาท
        วันที่: 06/04/2569 10:00
        เลขที่อ้างอิง: SHOP00001001
      `;

      const extracted = extractSlipData(slip);
      const paymentTime = new Date("2026-04-06T14:00:00");
      const context = {
        paymentId: 1,
        orderId: 1,
        orderTotal: 250,
        orderCreatedAt: paymentTime,
        paymentCreatedAt: paymentTime,
      };

      const result = verifySlipData(extracted, context, new Set());

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("SHOP_NAME_MISMATCH");
    });

    it("should reject slip with duplicate reference", () => {
      const slip = `
        ชื่อร้านค้า: Ipe Novel
        รหัสร้านค้า: KB000002283068
        รหัสธุรกรรม: KPS004KB000002283068
        จำนวนเงิน: 250.00 บาท
        วันที่: 06/04/2569 10:00
        เลขที่อ้างอิง: DUP000000001
      `;

      const extracted = extractSlipData(slip);
      const paymentTime = new Date("2026-04-06T14:00:00");
      const context = {
        paymentId: 1,
        orderId: 1,
        orderTotal: 250,
        orderCreatedAt: paymentTime,
        paymentCreatedAt: paymentTime,
      };
      const existingReferences = new Set<string>(["DUP000000001"]);

      const result = verifySlipData(extracted, context, existingReferences);

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("DUPLICATE_REFERENCE");
    });

    it("should reject slip with transaction outside time window", () => {
      const slip = `
        ชื่อร้านค้า: Ipe Novel
        รหัสร้านค้า: KB000002283068
        รหัสธุรกรรม: KPS004KB000002283068
        จำนวนเงิน: 250.00 บาท
        วันที่: 05/04/2569 10:00
        เลขที่อ้างอิง: WINDOW001
      `;

      const extracted = extractSlipData(slip);
      // Payment submitted 25 hours after transaction
      const paymentTime = new Date("2026-04-06T11:00:00");
      const context = {
        paymentId: 1,
        orderId: 1,
        orderTotal: 250,
        orderCreatedAt: paymentTime,
        paymentCreatedAt: paymentTime,
      };

      const result = verifySlipData(extracted, context, new Set());

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("TRANSACTION_OUTSIDE_TIME_WINDOW");
    });

    it("should reject slip with missing required fields", () => {
      const testCases = [
        {
          slip: "จำนวนเงิน: 250.00 บาท\nวันที่: 06/04/2569 10:00\nเลขที่อ้างอิง: TEST001",
          expectedReason: "MISSING_REFERENCE", // TEST001 is 7 chars, below 8-char minimum
        },
        {
          slip: "ชื่อร้านค้า: Ipe Novel\nวันที่: 06/04/2569 10:00\nเลขที่อ้างอิง: TEST001",
          expectedReason: "MISSING_AMOUNT", // no amount in slip → MISSING_AMOUNT fires before MISSING_REFERENCE
        },
        {
          slip: "ชื่อร้านค้า: Ipe Novel\nรหัสร้านค้า: KB000002283068\nรหัสธุรกรรม: KPS004KB000002283068\nเลขที่อ้างอิง: TEST001",
          expectedReason: "MISSING_AMOUNT", // no amount → MISSING_AMOUNT fires before MISSING_REFERENCE
        },
        {
          slip: "ชื่อร้านค้า: Ipe Novel\nรหัสร้านค้า: KB000002283068\nรหัสธุรกรรม: KPS004KB000002283068\nจำนวนเงิน: 250.00 บาท",
          expectedReason: "MISSING_TRANSACTION_DATE",
        },
      ];

      const paymentTime = new Date("2026-04-06T14:00:00");
      const context = {
        paymentId: 1,
        orderId: 1,
        orderTotal: 250,
        orderCreatedAt: paymentTime,
        paymentCreatedAt: paymentTime,
      };

      for (const testCase of testCases) {
        const extracted = extractSlipData(testCase.slip);
        const result = verifySlipData(extracted, context, new Set());

        expect(result.isAutoApproved).toBe(false);
        expect(result.reviewReason).toBe(testCase.expectedReason);
      }
    });
  });

  describe("Fingerprint and Duplicate Detection", () => {
    it("should generate consistent fingerprints for identical slips", () => {
      const slip1 = `
        ชื่อร้านค้า: Ipe Novel
        รหัสร้านค้า: KB000002283068
        รหัสธุรกรรม: KPS004KB000002283068
        จำนวนเงิน: 250.00 บาท
        วันที่: 06/04/2569 10:00
        เลขที่อ้างอิง: FP001
      `;

      const slip2 = `
        ชื่อร้านค้า: Ipe Novel
        รหัสร้านค้า: KB000002283068
        รหัสธุรกรรม: KPS004KB000002283068
        จำนวนเงิน: 250.00 บาท
        วันที่: 06/04/2569 10:00
        เลขที่อ้างอิง: FP001
      `;

      const extracted1 = extractSlipData(slip1);
      const extracted2 = extractSlipData(slip2);

      // Verify both extractions are identical
      expect(extracted1.reference).toBe(extracted2.reference);
      expect(extracted1.amount).toBe(extracted2.amount);
      expect(extracted1.merchantCode).toBe(extracted2.merchantCode);
      expect(extracted1.shopName).toBe(extracted2.shopName);
      expect(extracted1.merchantTransactionCode).toBe(extracted2.merchantTransactionCode);
    });

    it("should detect duplicates by reference number", () => {
      const slip = `
        ชื่อร้านค้า: Ipe Novel
        รหัสร้านค้า: KB000002283068
        รหัสธุรกรรม: KPS004KB000002283068
        จำนวนเงิน: 250.00 บาท
        วันที่: 06/04/2569 10:00
        เลขที่อ้างอิง: DUPLICATE123
      `;

      const extracted = extractSlipData(slip);
      const paymentTime = new Date("2026-04-06T14:00:00");
      const context = {
        paymentId: 1,
        orderId: 1,
        orderTotal: 250,
        orderCreatedAt: paymentTime,
        paymentCreatedAt: paymentTime,
      };

      // First submission should pass
      const result1 = verifySlipData(extracted, context, new Set());
      expect(result1.isAutoApproved).toBe(true);

      // Second submission with same reference should fail
      const existingReferences = new Set<string>([extracted.reference!]);
      const result2 = verifySlipData(extracted, context, existingReferences);
      expect(result2.isAutoApproved).toBe(false);
      expect(result2.reviewReason).toBe("DUPLICATE_REFERENCE");
    });
  });

  describe("Time Window Validation", () => {
    it("should accept slip submitted within 24 hours", () => {
      const slip = `
        ชื่อร้านค้า: Ipe Novel
        รหัสร้านค้า: KB000002283068
        รหัสธุรกรรม: KPS004KB000002283068
        จำนวนเงิน: 250.00 บาท
        วันที่: 06/04/2569 10:00
        เลขที่อ้างอิง: WINDOW001
      `;

      const extracted = extractSlipData(slip);
      // Transaction at 10:00, payment submitted at 14:00 (4 hours later, within 24-hour window)
      const transactionTime = new Date("2026-04-06T10:00:00");
      const paymentTime = new Date("2026-04-06T14:00:00");
      const context = {
        paymentId: 1,
        orderId: 1,
        orderTotal: 250,
        orderCreatedAt: paymentTime,
        paymentCreatedAt: paymentTime,
      };

      const result = verifySlipData(extracted, context, new Set());

      expect(result.isAutoApproved).toBe(true);
      expect(result.status).toBe("approved");
    });

    it("should reject slip submitted more than 24 hours after transaction", () => {
      const slip = `
        ชื่อร้านค้า: Ipe Novel
        รหัสร้านค้า: KB000002283068
        รหัสธุรกรรม: KPS004KB000002283068
        จำนวนเงิน: 250.00 บาท
        วันที่: 05/04/2569 10:00
        เลขที่อ้างอิง: WINDOW002
      `;

      const extracted = extractSlipData(slip);
      // Transaction on 05/04 at 10:00, payment submitted on 06/04 at 11:00 (25 hours later, outside window)
      const paymentTime = new Date("2026-04-06T11:00:00");
      const context = {
        paymentId: 1,
        orderId: 1,
        orderTotal: 250,
        orderCreatedAt: paymentTime,
        paymentCreatedAt: paymentTime,
      };

      const result = verifySlipData(extracted, context, new Set());

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("TRANSACTION_OUTSIDE_TIME_WINDOW");
    });

    it("should accept slip submitted up to 5 minutes after payment (clock skew tolerance)", () => {
      const slip = `
        ชื่อร้านค้า: Ipe Novel
        รหัสร้านค้า: KB000002283068
        รหัสธุรกรรม: KPS004KB000002283068
        จำนวนเงิน: 250.00 บาท
        วันที่: 06/04/2569 14:04
        เลขที่อ้างอิง: SKEW00000001
      `;

      const extracted = extractSlipData(slip);
      // Transaction time is 4 minutes before payment (within clock skew tolerance)
      const paymentTime = new Date("2026-04-06T14:00:00");
      const context = {
        paymentId: 1,
        orderId: 1,
        orderTotal: 250,
        orderCreatedAt: paymentTime,
        paymentCreatedAt: paymentTime,
      };

      const result = verifySlipData(extracted, context, new Set());

      expect(result.isAutoApproved).toBe(true);
      expect(result.status).toBe("approved");
    });
  });

  describe("Confidence Scoring", () => {
    it("should calculate confidence based on extracted fields", () => {
      const testCases = [
        {
          slip: "ชื่อร้านค้า: Ipe Novel",
          minConfidence: 10,
          description: "Shop name only",
        },
        {
          slip: "ชื่อร้านค้า: Ipe Novel\nรหัสร้านค้า: KB000002283068",
          minConfidence: 20,
          description: "Shop name + merchant code",
        },
        {
          slip: `
            ชื่อร้านค้า: Ipe Novel
            รหัสร้านค้า: KB000002283068
            รหัสธุรกรรม: KPS004KB000002283068
            จำนวนเงิน: 250.00 บาท
            วันที่: 06/04/2569 10:00
            เลขที่อ้างอิง: CONF00000001
          `,
          minConfidence: 85,
          description: "All fields present",
        },
      ];

      for (const testCase of testCases) {
        const extracted = extractSlipData(testCase.slip);
        expect(extracted.confidence).toBeGreaterThanOrEqual(testCase.minConfidence);
        console.log(`${testCase.description}: confidence = ${extracted.confidence}%`);
      }
    });
  });
});
