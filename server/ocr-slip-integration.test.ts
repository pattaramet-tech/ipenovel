import { describe, it, expect, beforeEach } from "vitest";
import { extractSlipData, verifySlipData, type OrderPaymentContext } from "./ocr-slip-verification";
import { getReviewReasonDescription } from "./ocr-slip-integration";

describe("OCR Slip Integration - Core Logic", () => {
  describe("Auto-Approval Scenarios", () => {
    it("should auto-approve valid slip with exact amount match", () => {
      const validSlip = `
        ธนาคารกรุงเทพ
        ชื่อร้านค้า: Ipe Novel
        รหัสร้านค้า: KB000002283068
        รหัสธุรกรรม: KPS004KB000002283068
        จำนวนเงิน: 250.00 บาท
        วันที่: 06/04/2569 10:30
        เลขที่อ้างอิง: AUTO00000001
      `;

      const extracted = extractSlipData(validSlip);
      const paymentTime = new Date("2026-04-06T14:00:00");
      const context = {
        paymentId: 1,
        orderId: 1,
        orderTotal: 250,
        orderCreatedAt: paymentTime,
        paymentCreatedAt: paymentTime,
      };
      const existingReferences = new Set<string>();

      const result = verifySlipData(extracted, context, existingReferences);

      expect(result.isAutoApproved).toBe(true);
      expect(result.status).toBe("approved");
      expect(result.reviewReason).toBeUndefined();
    });

    it("should auto-approve slip with all fields present", () => {
      const slip = `
        ธนาคารกรุงเทพ
        ชื่อร้านค้า: IPE NOVEL
        รหัสร้านค้า: KB000002283068
        รหัสธุรกรรม: KPS004KB000002283068
        จำนวนเงิน: 500.00 บาท
        วันที่: 06/04/2569 09:00
        เลขที่อ้างอิง: REF123456
      `;

      const extracted = extractSlipData(slip);
      const paymentTime = new Date("2026-04-06T14:00:00");
      const context = {
        paymentId: 2,
        orderId: 2,
        orderTotal: 500,
        orderCreatedAt: paymentTime,
        paymentCreatedAt: paymentTime,
      };
      const existingReferences = new Set<string>();

      const result = verifySlipData(extracted, context, existingReferences);

      expect(result.isAutoApproved).toBe(true);
      expect(result.status).toBe("approved");
    });
  });

  describe("Pending Review Scenarios", () => {
    it("should send to pending_review on amount mismatch", () => {
      const slip = `
        ธนาคารกรุงเทพ
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
        paymentId: 3,
        orderId: 3,
        orderTotal: 250,
        orderCreatedAt: paymentTime,
        paymentCreatedAt: paymentTime,
      };
      const existingReferences = new Set<string>();

      const result = verifySlipData(extracted, context, existingReferences);

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("AMOUNT_MISMATCH");
    });

    it("should send to pending_review on merchant code mismatch", () => {
      const slip = `
        ธนาคารกรุงเทพ
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
        paymentId: 4,
        orderId: 4,
        orderTotal: 250,
        orderCreatedAt: paymentTime,
        paymentCreatedAt: paymentTime,
      };
      const existingReferences = new Set<string>();

      const result = verifySlipData(extracted, context, existingReferences);

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("MERCHANT_CODE_MISMATCH");
    });

    it("should send to pending_review on shop name mismatch", () => {
      const slip = `
        ธนาคารกรุงเทพ
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
        paymentId: 5,
        orderId: 5,
        orderTotal: 250,
        orderCreatedAt: paymentTime,
        paymentCreatedAt: paymentTime,
      };
      const existingReferences = new Set<string>();

      const result = verifySlipData(extracted, context, existingReferences);

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("SHOP_NAME_MISMATCH");
    });

    it("should send to pending_review on duplicate reference", () => {
      const slip = `
        ธนาคารกรุงเทพ
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
        paymentId: 6,
        orderId: 6,
        orderTotal: 250,
        orderCreatedAt: paymentTime,
        paymentCreatedAt: paymentTime,
      };
      const existingReferences = new Set<string>(["DUP000000001"]);

      const result = verifySlipData(extracted, context, existingReferences);

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("DUPLICATE_REFERENCE");
    });

    it("should send to pending_review on missing fields", () => {
      const slip = `
        ธนาคารกรุงเทพ
        จำนวนเงิน: 250.00 บาท
      `;

      const extracted = extractSlipData(slip);
      const paymentTime = new Date("2026-04-06T14:00:00");
      const context = {
        paymentId: 7,
        orderId: 7,
        orderTotal: 250,
        orderCreatedAt: paymentTime,
        paymentCreatedAt: paymentTime,
      };
      const existingReferences = new Set<string>();

      const result = verifySlipData(extracted, context, existingReferences);

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBeTruthy();
      expect(["MISSING_SHOP_NAME", "MISSING_MERCHANT_CODE", "MISSING_REFERENCE", "MISSING_TRANSACTION_DATE"]).toContain(
        result.reviewReason
      );
    });

    it("should send to pending_review on low confidence", () => {
      const slip = `
        ธนาคารกรุงเทพ
        จำนวนเงิน: 250.00 บาท
        เลขที่อ้างอิง: LOW001
      `;

      const extracted = extractSlipData(slip);
      const paymentTime = new Date("2026-04-06T14:00:00");
      const context = {
        paymentId: 8,
        orderId: 8,
        orderTotal: 250,
        orderCreatedAt: paymentTime,
        paymentCreatedAt: paymentTime,
      };
      const existingReferences = new Set<string>();

      const result = verifySlipData(extracted, context, existingReferences);

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBeTruthy();
    });
  });

  describe("Review Reason Descriptions", () => {
    it("should provide human-readable descriptions for all reason codes", () => {
      const reasons = [
        "AMOUNT_MISMATCH",
        "MISSING_SHOP_NAME",
        "MERCHANT_CODE_MISMATCH",
        "DUPLICATE_REFERENCE",
        "LOW_CONFIDENCE",
        "TRANSACTION_OUTSIDE_TIME_WINDOW",
      ];

      reasons.forEach((reason) => {
        const description = getReviewReasonDescription(reason);
        expect(description).toBeTruthy();
        expect(description.length).toBeGreaterThan(0);
      });
    });
  });
});
