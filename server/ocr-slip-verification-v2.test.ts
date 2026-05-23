import { describe, it, expect, beforeEach } from "vitest";
import {
  extractSlipData,
  verifySlipData,
  generateFingerprint,
  parseSlipImage,
  ExtractedSlipData,
  OrderPaymentContext,
} from "./ocr-slip-verification-v2";

// ─── Real samples from Slipupgrade.txt ─────────────────────────────────────

const SCB_JSON_SAMPLE = `\`\`\`json
{
  "bank_name": "SCB",
  "status": "จ่ายบิลสำเร็จ",
  "date": "23 พ.ค. 2569",
  "time": "23:01",
  "reference_number": "202605234Jqgxc15MLaY71oYS",
  "sender_name": "นาย บรรพต ม.",
  "sender_account_number_masked": "xxx-xxx431-4",
  "receiver_name": "Ipe Novel",
  "biller_id": "010753600031501",
  "merchant_code": "KB000002283068",
  "transaction_code": "KPS004KB000002283068",
  "amount": "100.00",
  "additional_info": "ผู้รับเงินสามารถสแกนคิวอาร์โค้ดนี้ เพื่อตรวจสอบสถานะการจ่ายเงิน"
}
\`\`\`

**OCR Confidence Score:** 98/100`;

const KBANK_NESTED_JSON_SAMPLE = `\`\`\`json
{
  "extracted_text": {
    "status": "ชำระเงินสำเร็จ",
    "date_time": "23 พ.ค. 69 22:48 น.",
    "sender_name": "นาย ศราวุฒิ ส",
    "sender_bank": "ธ.กสิกรไทย",
    "sender_account_number": "xxx-x-x6622-x",
    "receiver_shop_name": "Ipe Novel",
    "receiver_name": "นาย ภัทรเมศ อินทองคำ",
    "receiver_account_number_or_id": "202605233452674",
    "transaction_id_or_reference_number": {
      "label": "เลขที่รายการ:",
      "value": "016143224852AQR07610"
    },
    "amount": {
      "label": "จำนวน:",
      "value": "200.00 บาท"
    },
    "fee": {
      "label": "ค่าธรรมเนียม:",
      "value": "0.00 บาท"
    },
    "additional_info": [
      "K+",
      "สติ",
      "สติเฟต์เตอร์",
      "รู้ทัน ป้องกันโกง",
      "สแกนตรวจสอบสลิป"
    ]
  },
  "ocr_confidence": 98
}
\`\`\``;

const KBANK_THAI_LABELS_SAMPLE = `\`\`\`json
{
  "OCR_Confidence_Score": 98,
  "extracted_data": {
    "สถานะ": "ชำระเงินสำเร็จ",
    "วันที่_เวลา": "23 พ.ค. 69 22:48 น.",
    "ผู้โอน": {
      "ชื่อ": "นาย ศราวุฒิ ส",
      "ธนาคาร": "ธ.กสิกรไทย",
      "เลขที่บัญชี_masked": "xxx-x-x6622-x"
    },
    "ผู้รับ": {
      "ชื่อร้านค้า_หรือ_ชื่อผู้รับ": "Ipe Novel",
      "ชื่อจริง_ผู้รับ": "นาย ภัทรเมศ อินทองคำ",
      "รหัสผู้รับ_หรือ_เลขที่บัญชี_ผู้รับ": "202605233452674"
    },
    "เลขที่รายการ": "016143224852AQR07610",
    "จำนวนเงิน": "200.00 บาท",
    "ค่าธรรมเนียม": "0.00 บาท",
    "QR_Code_Label": "สแกนตรวจสอบสลิป",
    "อื่นๆ": [
      "K+",
      "สติ",
      "Details",
      "Contact info",
      "สติเฟต์เตอร์",
      "รู้ทัน ป้องกันโกง"
    ]
  }
}
\`\`\``;

const KBANK_SIMPLE_SAMPLE = `\`\`\`json
{
  "ชำระเงินสำเร็จ": "ชำระเงินสำเร็จ",
  "วันที่": "23 พ.ค. 69 22:37 น.",
  "ธนาคาร": "K+",
  "ชื่อผู้ส่ง": "นาย รัฐศาสตร์ ด",
  "ธนาคารผู้ส่ง": "ธ.กสิกรไทย",
  "เลขที่บัญชีผู้ส่ง (masked)": "xxx-x-x9666-x",
  "ชื่อร้านค้า / ชื่อผู้รับ": "Ipe Novel",
  "ชื่อผู้รับ (รายละเอียด)": "นาย ภัทรเมศ อินทองคำ",
  "รหัสธุรกรรม": "202605233438753",
  "เลขที่รายการ": "016143223733CQR08572",
  "จำนวนเงิน": "100.00 บาท",
  "ค่าธรรมเนียม": "0.00 บาท",
  "QR Code Label": "สแกนตรวจสอบสลิป"
}
\`\`\``;

const SCB_PLAINTEXT_SAMPLE = `\`\`\`
ธนาคาร: SCB
สถานะ: จ่ายบิลสำเร็จ
วันที่: 23 พ.ค. 2569
เวลา: 17:29
รหัสอ้างอิง: 202605238QdR7aQOjwWv1OBr4

จาก:
  ชื่อผู้ส่ง: นาย บรรพต ม.
  เลขที่บัญชี (masked): xxx-xxx431-4

ไปยัง:
  ชื่อผู้รับ: Ipe Novel
  Biller ID: 010753600031501
  รหัสร้านค้า: KB000002283068
  รหัสธุรกรรม: KPS004KB000002283068

จำนวนเงิน: 100.00

หมายเหตุ: ผู้รับเงินสามารถสแกนคิวอาร์โค้ดนี้ เพื่อตรวจสอบสถานะการจ่ายเงิน
\`\`\`

**OCR Confidence Score:** 98/100`;

// ─── Test context ─────────────────────────────────────────────────────────

let testContext: OrderPaymentContext;

beforeEach(() => {
  testContext = {
    orderId: 1,
    paymentId: 100,
    orderTotal: 100,
    orderCreatedAt: new Date("2026-05-23T16:00:00Z"),
    paymentCreatedAt: new Date("2026-05-23T16:05:00Z"),
    slipSubmittedAt: new Date("2026-05-23T16:10:00Z"),
  };
});

// ─── Test suite ───────────────────────────────────────────────────────────

describe("OCR Slip Verification v2 - Production Hardening", () => {
  describe("extractSlipData - SCB JSON-style", () => {
    it("should extract amount from JSON 'amount': '100.00'", () => {
      const extracted = extractSlipData(SCB_JSON_SAMPLE, 85);
      expect(extracted.amount).toBe(100);
    });

    it("should extract reference from JSON reference_number", () => {
      const extracted = extractSlipData(SCB_JSON_SAMPLE, 85);
      expect(extracted.reference).toBe("202605234JQGXC15MLAY71OYS");
    });

    it("should extract shop name from receiver_name", () => {
      const extracted = extractSlipData(SCB_JSON_SAMPLE, 85);
      expect(extracted.shopName).toBeDefined();
      if (extracted.shopName) {
        expect(extracted.shopName.toLowerCase()).toContain("ipe novel");
      }
    });

    it("should extract merchant code", () => {
      const extracted = extractSlipData(SCB_JSON_SAMPLE, 85);
      expect(extracted.merchantCode).toBe("KB000002283068");
    });

    it("should extract transaction code", () => {
      const extracted = extractSlipData(SCB_JSON_SAMPLE, 85);
      expect(extracted.merchantTransactionCode).toBe("KPS004KB000002283068");
    });

    it("should extract date from Thai Buddhist year 2569 → 2026", () => {
      const extracted = extractSlipData(SCB_JSON_SAMPLE, 85);
      expect(extracted.transactionDate).toBeDefined();
      if (extracted.transactionDate) {
        expect(extracted.transactionDate.getUTCFullYear()).toBe(2026);
        expect(extracted.transactionDate.getUTCMonth()).toBe(4); // May = 4
        expect(extracted.transactionDate.getUTCDate()).toBe(23);
      }
    });

    it("should extract time 23:01 when date and time are separate fields", () => {
      const extracted = extractSlipData(SCB_JSON_SAMPLE, 85);
      expect(extracted.transactionDate).toBeDefined();
      if (extracted.transactionDateTime) {
        // 23:01 Bangkok time = 16:01 UTC
        expect(extracted.transactionDateTime.getUTCHours()).toBe(16);
        expect(extracted.transactionDateTime.getUTCMinutes()).toBe(1);
      }
    });

    it("should extract confidence from 'OCR Confidence Score: 98/100'", () => {
      const extracted = extractSlipData(SCB_JSON_SAMPLE, 85);
      expect(extracted.confidence).toBeGreaterThan(0);
    });

    it("should detect bank as SCB", () => {
      const extracted = extractSlipData(SCB_JSON_SAMPLE, 85);
      expect(extracted.detectedBank).toBe("SCB");
    });

    it("should extract biller ID", () => {
      const extracted = extractSlipData(SCB_JSON_SAMPLE, 85);
      expect(extracted.billerId).toBe("010753600031501");
    });
  });

  describe("extractSlipData - KBank nested JSON", () => {
    it("should extract amount from nested 'amount.value': '200.00 บาท'", () => {
      const extracted = extractSlipData(KBANK_NESTED_JSON_SAMPLE, 85);
      expect(extracted.amount).toBe(200);
    });

    it("should extract reference from nested transaction_id_or_reference_number.value", () => {
      const extracted = extractSlipData(KBANK_NESTED_JSON_SAMPLE, 85);
      expect(extracted.reference).toBe("016143224852AQR07610");
    });

    it("should extract shop name from receiver_shop_name", () => {
      const extracted = extractSlipData(KBANK_NESTED_JSON_SAMPLE, 85);
      expect(extracted.shopName).toBeDefined();
      if (extracted.shopName) {
        expect(extracted.shopName.toLowerCase()).toContain("ipe novel");
      }
    });

    it("should extract dateTime from Thai short year 69 → 2026 with time 22:48", () => {
      const extracted = extractSlipData(KBANK_NESTED_JSON_SAMPLE, 85);
      expect(extracted.transactionDate).toBeDefined();
      if (extracted.transactionDateTime) {
        expect(extracted.transactionDate.getUTCFullYear()).toBe(2026);
        expect(extracted.transactionDateTime.getUTCMonth()).toBe(4); // May
        expect(extracted.transactionDateTime.getUTCDate()).toBe(23);
        // 22:48 Bangkok time = 15:48 UTC
        expect(extracted.transactionDateTime.getUTCHours()).toBe(15);
        expect(extracted.transactionDateTime.getUTCMinutes()).toBe(48);
      }
    });

    it("should detect bank as KBANK", () => {
      const extracted = extractSlipData(KBANK_NESTED_JSON_SAMPLE, 85);
      expect(extracted.detectedBank).toBe("KBANK");
    });

    it("should extract masked account", () => {
      const extracted = extractSlipData(KBANK_NESTED_JSON_SAMPLE, 85);
      expect(extracted.maskedAccount).toBe("xxx-x-x6622-x");
    });

    it("should extract confidence from ocr_confidence field", () => {
      const extracted = extractSlipData(KBANK_NESTED_JSON_SAMPLE, 85);
      expect(extracted.confidence).toBeGreaterThan(0);
    });
  });

  describe("extractSlipData - KBank Thai labels", () => {
    it("should extract reference from Thai label เลขที่รายการ", () => {
      const extracted = extractSlipData(KBANK_THAI_LABELS_SAMPLE, 85);
      expect(extracted.reference).toBe("016143224852AQR07610");
    });

    it("should extract amount from Thai label จำนวนเงิน: '200.00 บาท'", () => {
      const extracted = extractSlipData(KBANK_THAI_LABELS_SAMPLE, 85);
      expect(extracted.amount).toBe(200);
    });

    it("should extract shop name from Thai label ชื่อร้านค้า_หรือ_ชื่อผู้รับ", () => {
      const extracted = extractSlipData(KBANK_THAI_LABELS_SAMPLE, 85);
      expect(extracted.shopName).toBeDefined();
      if (extracted.shopName) {
        expect(extracted.shopName.toLowerCase()).toContain("ipe novel");
      }
    });

    it("should extract dateTime from Thai label วันที่_เวลา with short year 69", () => {
      const extracted = extractSlipData(KBANK_THAI_LABELS_SAMPLE, 85);
      expect(extracted.transactionDate).toBeDefined();
      if (extracted.transactionDateTime) {
        expect(extracted.transactionDate.getUTCFullYear()).toBe(2026);
        expect(extracted.transactionDateTime.getUTCMonth()).toBe(4);
        expect(extracted.transactionDateTime.getUTCDate()).toBe(23);
      }
    });

    it("should extract masked account from nested ผู้โอน.เลขที่บัญชี_masked", () => {
      const extracted = extractSlipData(KBANK_THAI_LABELS_SAMPLE, 85);
      expect(extracted.maskedAccount).toBe("xxx-x-x6622-x");
    });

    it("should detect bank as KBANK from Thai label ธนาคาร", () => {
      const extracted = extractSlipData(KBANK_THAI_LABELS_SAMPLE, 85);
      expect(extracted.detectedBank).toBe("KBANK");
    });

    it("should extract confidence from OCR_Confidence_Score field", () => {
      const extracted = extractSlipData(KBANK_THAI_LABELS_SAMPLE, 85);
      expect(extracted.confidence).toBeGreaterThan(0);
    });
  });

  describe("extractSlipData - KBank simple", () => {
    it("should extract reference from Thai label เลขที่รายการ", () => {
      const extracted = extractSlipData(KBANK_SIMPLE_SAMPLE, 85);
      expect(extracted.reference).toBe("016143223733CQR08572");
    });

    it("should extract amount from Thai label จำนวนเงิน: '100.00 บาท'", () => {
      const extracted = extractSlipData(KBANK_SIMPLE_SAMPLE, 85);
      expect(extracted.amount).toBe(100);
    });

    it("should extract shop name from Thai label ชื่อร้านค้า / ชื่อผู้รับ", () => {
      const extracted = extractSlipData(KBANK_SIMPLE_SAMPLE, 85);
      expect(extracted.shopName).toBeDefined();
      if (extracted.shopName) {
        expect(extracted.shopName.toLowerCase()).toContain("ipe novel");
      }
    });

    it("should extract dateTime from Thai label วันที่ with short year 69 and time 22:37", () => {
      const extracted = extractSlipData(KBANK_SIMPLE_SAMPLE, 85);
      expect(extracted.transactionDate).toBeDefined();
      if (extracted.transactionDateTime) {
        expect(extracted.transactionDate.getUTCFullYear()).toBe(2026);
        expect(extracted.transactionDateTime.getUTCMonth()).toBe(4);
        expect(extracted.transactionDateTime.getUTCDate()).toBe(23);
        // 22:37 Bangkok time = 15:37 UTC
        expect(extracted.transactionDateTime.getUTCHours()).toBe(15);
        expect(extracted.transactionDateTime.getUTCMinutes()).toBe(37);
      }
    });

    it("should detect bank as KBANK from Thai label ธนาคาร: K+", () => {
      const extracted = extractSlipData(KBANK_SIMPLE_SAMPLE, 85);
      expect(extracted.detectedBank).toBe("KBANK");
    });

    it("should extract masked account from Thai label เลขที่บัญชีผู้ส่ง (masked)", () => {
      const extracted = extractSlipData(KBANK_SIMPLE_SAMPLE, 85);
      expect(extracted.maskedAccount).toBe("xxx-x-x9666-x");
    });
  });

  describe("extractSlipData - SCB plain text", () => {
    it("should extract amount from plain text 'จำนวนเงิน: 100.00'", () => {
      const extracted = extractSlipData(SCB_PLAINTEXT_SAMPLE, 85);
      expect(extracted.amount).toBe(100);
    });

    it("should extract reference from plain text 'รหัสอ้างอิง: 202605238QdR7aQOjwWv1OBr4'", () => {
      const extracted = extractSlipData(SCB_PLAINTEXT_SAMPLE, 85);
      expect(extracted.reference).toBe("202605238QDR7AQOJWWV1OBR4");
    });

    it("should extract shop name from plain text 'ชื่อผู้รับ: Ipe Novel'", () => {
      const extracted = extractSlipData(SCB_PLAINTEXT_SAMPLE, 85);
      expect(extracted.shopName).toBeDefined();
      if (extracted.shopName) {
        expect(extracted.shopName.toLowerCase()).toContain("ipe novel");
      }
    });

    it("should extract date from plain text Thai Buddhist year 2569", () => {
      const extracted = extractSlipData(SCB_PLAINTEXT_SAMPLE, 85);
      expect(extracted.transactionDate).toBeDefined();
      if (extracted.transactionDate) {
        expect(extracted.transactionDate.getUTCFullYear()).toBe(2026);
        expect(extracted.transactionDate.getUTCMonth()).toBe(4);
        expect(extracted.transactionDate.getUTCDate()).toBe(23);
      }
    });

    it("should extract time 17:29 when date and time are separate fields", () => {
      const extracted = extractSlipData(SCB_PLAINTEXT_SAMPLE, 85);
      expect(extracted.transactionDate).toBeDefined();
      if (extracted.transactionDateTime) {
        // 17:29 Bangkok time = 10:29 UTC
        expect(extracted.transactionDateTime.getUTCHours()).toBe(10);
        expect(extracted.transactionDateTime.getUTCMinutes()).toBe(29);
      }
    });

    it("should extract merchant code from plain text", () => {
      const extracted = extractSlipData(SCB_PLAINTEXT_SAMPLE, 85);
      expect(extracted.merchantCode).toBe("KB000002283068");
    });

    it("should extract transaction code from plain text", () => {
      const extracted = extractSlipData(SCB_PLAINTEXT_SAMPLE, 85);
      expect(extracted.merchantTransactionCode).toBe("KPS004KB000002283068");
    });

    it("should extract confidence from 'OCR Confidence Score: 98/100'", () => {
      const extracted = extractSlipData(SCB_PLAINTEXT_SAMPLE, 85);
      expect(extracted.confidence).toBeGreaterThan(0);
    });

    it("should detect bank as SCB", () => {
      const extracted = extractSlipData(SCB_PLAINTEXT_SAMPLE, 85);
      expect(extracted.detectedBank).toBe("SCB");
    });
  });

  describe("Thai Buddhist year parsing", () => {
    it("should parse short Buddhist year 67 → 2024", () => {
      const text = "23 พ.ค. 67 22:48 น.";
      const extracted = extractSlipData(text, 85);
      expect(extracted.transactionDate).toBeDefined();
      if (extracted.transactionDateTime) {
        expect(extracted.transactionDateTime.getUTCFullYear()).toBe(2024);
      }
    });

    it("should parse short Buddhist year 68 → 2025", () => {
      const text = "23 พ.ค. 68 22:48 น.";
      const extracted = extractSlipData(text, 85);
      expect(extracted.transactionDate).toBeDefined();
      if (extracted.transactionDateTime) {
        expect(extracted.transactionDateTime.getUTCFullYear()).toBe(2025);
      }
    });

    it("should parse short Buddhist year 69 → 2026", () => {
      const text = "23 พ.ค. 69 22:48 น.";
      const extracted = extractSlipData(text, 85);
      expect(extracted.transactionDate).toBeDefined();
      if (extracted.transactionDateTime) {
        expect(extracted.transactionDate.getUTCFullYear()).toBe(2026);
      }
    });

    it("should parse full Buddhist year 2569 → 2026", () => {
      const text = "23 พ.ค. 2569";
      const extracted = extractSlipData(text, 85);
      expect(extracted.transactionDate).toBeDefined();
      if (extracted.transactionDateTime) {
        expect(extracted.transactionDate.getUTCFullYear()).toBe(2026);
      }
    });
  });

  describe("Timezone handling", () => {
    it("should convert Bangkok time to UTC correctly (22:48 Bangkok → 15:48 UTC)", () => {
      const text = "23 พ.ค. 69 22:48 น.";
      const extracted = extractSlipData(text, 85);
      expect(extracted.transactionDate).toBeDefined();
      if (extracted.transactionDateTime) {
        // 22:48 Bangkok (UTC+7) = 15:48 UTC
        expect(extracted.transactionDateTime.getUTCHours()).toBe(15);
        expect(extracted.transactionDateTime.getUTCMinutes()).toBe(48);
      }
    });

    it("should handle Bangkok time within 120-minute window", () => {
      // Submitted at 23:05 Thailand time
      const submittedAt = new Date("2026-05-23T16:05:00Z"); // 23:05 Bangkok
      // Transaction at 22:48 Thailand time
      const extracted = extractSlipData(KBANK_NESTED_JSON_SAMPLE, 85);

      const context: OrderPaymentContext = {
        orderId: 1,
        paymentId: 100,
        orderTotal: 200,
        orderCreatedAt: new Date("2026-05-23T15:00:00Z"),
        paymentCreatedAt: new Date("2026-05-23T15:05:00Z"),
        slipSubmittedAt: submittedAt,
      };

      const result = verifySlipData(
        extracted,
        context,
        new Set(),
        new Set(),
        85,
        120
      );

      expect(result.isAutoApproved).toBe(true);
      expect(result.status).toBe("approved");
    });
  });

  describe("verifySlipData - Auto-approval", () => {
    it("should auto-approve SCB JSON when amount matches, duplicate false, config enabled", () => {
      const extracted = extractSlipData(SCB_JSON_SAMPLE, 85);
      const result = verifySlipData(
        extracted,
        testContext,
        new Set(),
        new Set(),
        85,
        120
      );

      expect(result.isAutoApproved).toBe(true);
      expect(result.status).toBe("approved");
    });

    it("should auto-approve SCB plain text when config allows and amount matches", () => {
      const extracted = extractSlipData(SCB_PLAINTEXT_SAMPLE, 85);
      const result = verifySlipData(
        extracted,
        testContext,
        new Set(),
        new Set(),
        85,
        120
      );

      expect(result.isAutoApproved).toBe(true);
      expect(result.status).toBe("approved");
    });

    it("should auto-approve KBank nested when amount matches and duplicate false", () => {
      const extracted = extractSlipData(KBANK_NESTED_JSON_SAMPLE, 85);
      const context: OrderPaymentContext = {
        ...testContext,
        orderTotal: 200,
      };

      const result = verifySlipData(
        extracted,
        context,
        new Set(),
        new Set(),
        85,
        120
      );

      expect(result.isAutoApproved).toBe(true);
      expect(result.status).toBe("approved");
    });
  });

  describe("verifySlipData - Duplicate detection", () => {
    it("should NOT auto-approve when duplicateFingerprint=true", () => {
      const extracted = extractSlipData(KBANK_NESTED_JSON_SAMPLE, 85);
      const context: OrderPaymentContext = {
        ...testContext,
        orderTotal: 200,
      };

      // Simulate existing duplicate fingerprint
      const fingerprint = generateFingerprint(extracted);
      const existingFingerprints = new Set([fingerprint]);

      const result = verifySlipData(
        extracted,
        context,
        new Set(),
        existingFingerprints,
        85,
        120
      );

      expect(result.isAutoApproved).toBe(false);
      expect(result.status).toBe("pending_review");
      expect(result.reviewReason).toBe("DUPLICATE_FINGERPRINT");
    });

    it("should NOT auto-approve when duplicate reference exists", () => {
      const extracted = extractSlipData(SCB_JSON_SAMPLE, 85);
      const existingReferences = new Set([extracted.reference!]);

      const result = verifySlipData(
        extracted,
        testContext,
        existingReferences,
        new Set(),
        85,
        120
      );

      expect(result.isAutoApproved).toBe(false);
      expect(result.status).toBe("pending_review");
      expect(result.reviewReason).toBe("DUPLICATE_REFERENCE");
    });
  });

  describe("verifySlipData - Failure cases", () => {
    it("should return pending_review when amount is missing", () => {
      const extracted: ExtractedSlipData = {
        reference: "REF123",
        transactionDate: new Date("2026-05-23"),
        detectedBank: "SCB",
        confidence: 90,
      };

      const result = verifySlipData(
        extracted,
        testContext,
        new Set(),
        new Set(),
        85,
        120
      );

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("MISSING_AMOUNT");
    });

    it("should return pending_review when amount does not match order total", () => {
      const extracted = extractSlipData(SCB_JSON_SAMPLE, 85);
      const context: OrderPaymentContext = {
        ...testContext,
        orderTotal: 999,
      };

      const result = verifySlipData(
        extracted,
        context,
        new Set(),
        new Set(),
        85,
        120
      );

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("AMOUNT_MISMATCH");
    });

    it("should return pending_review when transaction date is missing", () => {
      const extracted: ExtractedSlipData = {
        amount: 100,
        reference: "REF123",
        detectedBank: "SCB",
        confidence: 90,
      };

      const result = verifySlipData(
        extracted,
        testContext,
        new Set(),
        new Set(),
        85,
        120
      );

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("MISSING_TRANSACTION_DATE");
    });

    it("should return pending_review when reference is missing", () => {
      const extracted: ExtractedSlipData = {
        amount: 100,
        transactionDate: new Date("2026-05-23"),
        detectedBank: "SCB",
        confidence: 90,
      };

      const result = verifySlipData(
        extracted,
        testContext,
        new Set(),
        new Set(),
        85,
        120
      );

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("MISSING_REFERENCE");
    });

    it("should return pending_review when confidence is below minimum", () => {
      const extracted = extractSlipData(SCB_JSON_SAMPLE, 50);
      const result = verifySlipData(
        extracted,
        testContext,
        new Set(),
        new Set(),
        85,
        120
      );

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("LOW_CONFIDENCE");
    });

    it("should return pending_review when transaction is outside time window", () => {
      const extracted = extractSlipData(SCB_JSON_SAMPLE, 85);
      const context: OrderPaymentContext = {
        ...testContext,
        slipSubmittedAt: new Date("2026-05-25T16:10:00Z"), // 2 days later
      };

      const result = verifySlipData(
        extracted,
        context,
        new Set(),
        new Set(),
        85,
        120
      );

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("TRANSACTION_OUTSIDE_TIME_WINDOW");
    });
  });

  describe("Fingerprint generation", () => {
    it("should generate reference-based fingerprint when reference exists", () => {
      const extracted: ExtractedSlipData = {
        amount: 100,
        reference: "REF123",
        transactionDate: new Date("2026-05-23"),
        detectedBank: "SCB",
      };

      const fingerprint = generateFingerprint(extracted);
      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/); // SHA256 hex
    });

    it("should generate bank+account fingerprint when reference is missing", () => {
      const extracted: ExtractedSlipData = {
        amount: 100,
        detectedBank: "SCB",
        maskedAccount: "xxx-xxx431-4",
        transactionDate: new Date("2026-05-23"),
      };

      const fingerprint = generateFingerprint(extracted);
      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    });

    it("should generate shop-based fingerprint when reference and account are missing", () => {
      const extracted: ExtractedSlipData = {
        amount: 100,
        shopName: "Ipe Novel",
        transactionDate: new Date("2026-05-23"),
      };

      const fingerprint = generateFingerprint(extracted);
      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe("Confidence parsing", () => {
    it("should extract confidence from 'OCR Confidence Score: 98/100'", () => {
      const text = "**OCR Confidence Score:** 98/100";
      const extracted = extractSlipData(text, 85);
      expect(extracted.confidence).toBeGreaterThan(0);
    });

    it("should extract confidence from 'ocr_confidence: 98'", () => {
      const text = '"ocr_confidence": 98';
      const extracted = extractSlipData(text, 85);
      expect(extracted.confidence).toBeGreaterThan(0);
    });

    it("should extract confidence from 'OCR_Confidence_Score: 98'", () => {
      const text = '"OCR_Confidence_Score": 98';
      const extracted = extractSlipData(text, 85);
      expect(extracted.confidence).toBeGreaterThan(0);
    });

    it("should extract confidence from 'confidence: 98'", () => {
      const text = '"confidence": 98';
      const extracted = extractSlipData(text, 85);
      expect(extracted.confidence).toBeGreaterThan(0);
    });
  });

  describe("OCR processing error handling", () => {
    it("should handle empty OCR text gracefully", () => {
      const extracted = extractSlipData("", 85);
      expect(extracted.confidence).toBe(0);
      expect(extracted.amount).toBeUndefined();
    });

    it("should handle malformed JSON gracefully", () => {
      const text = "```json\n{invalid json}\n```";
      const extracted = extractSlipData(text, 85);
      expect(extracted.confidence).toBeLessThan(50);
    });

    it("should fallback to regex when JSON parsing fails", () => {
      const text = "จำนวนเงิน: 100.00 บาท\nเลขที่รายการ: REF123";
      const extracted = extractSlipData(text, 85);
      expect(extracted.amount).toBe(100);
      expect(extracted.reference).toBe("REF123");
    });
  });
});
