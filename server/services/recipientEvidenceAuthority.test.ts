/**
 * IPE-001 P1-B: "Require field-bound exact recipient aliases".
 *
 * ── The bugs (confirmed by the repo-wide recipient authority audit) ────────
 *
 * 1. SUBSTRING AUTHORITY. verifyRecipient's shop/receiver-name fallback used
 *    `normalized.includes(alias)`, so "Ipe Novel Fake", "Fake Ipe Novel" and
 *    "Ipe Novel Shop 2" all satisfied the check for "Ipe Novel" - a value
 *    merely CONTAINING an approved name verified as though it WERE that name.
 *
 * 2. WHOLE-TEXT SYNTHESIS. extractShopName's last-resort fallback scanned the
 *    ENTIRE OCR text for any configured alias and, on a hit, fabricated the
 *    canonical "Ipe Novel" as the shop name - regardless of whether the
 *    match came from a note, a memo, the SENDER field, or an unrelated
 *    footer. verifyRecipient then matched that synthesized value exactly.
 *
 * Recipient verification participates in AUTO_APPROVE (see the RECIPIENT
 * GATE in verifySlipData), so a transfer to someone else could satisfy a
 * financial gate purely because the word "Ipe Novel" appeared anywhere in
 * the slip's OCR text.
 *
 * 3. UNBOUNDED IDENTIFIER REGEX (found during the audit, not named by either
 *    Codex finding). extractMerchantCode's label-less fallback pattern
 *    `/([A-Z]{2}\d{12})/` was unanchored, so "KB000002283068XYZ" yielded the
 *    substring "KB000002283068" - which then compared EQUAL to the
 *    configured merchant code. The same class of bug as (1), one level
 *    deeper: substring extraction feeding an exact-equality check.
 *
 * ── The fix ────────────────────────────────────────────────────────────────
 * - verifyRecipient's shop/receiver fallback is now EXACT membership in an
 *   explicit allowlist (`Set.has`), never `.includes()`.
 * - extractShopName's whole-text fallback is REMOVED from authoritative
 *   extraction. A raw-text mention is still detected, but surfaced
 *   separately as `recipientRawTextMention` - documented as diagnostic only,
 *   incapable of setting `recipientVerified`.
 * - extractMerchantCode's fallback regex is bounded with lookaround
 *   assertions so a merchant code must match in full, never as a substring
 *   of a longer token.
 *
 * Priority order (unchanged, still exact-only): merchant transaction code >
 * merchant code > biller ID > exact field-bound shop/receiver name > none.
 * Missing evidence -> `recipientVerified: false` -> RECIPIENT_NOT_VERIFIED ->
 * NEEDS_REVIEW. OCR never auto-rejects on this or any other gate.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  verifyRecipient,
  extractSlipData,
  detectRecipientRawTextMention,
  verifySlipData,
  type ExtractedSlipData,
  type OrderPaymentContext,
} from "../ocr-slip-verification-v2";

function readCode(relativePath: string): string {
  return fs
    .readFileSync(path.resolve(process.cwd(), relativePath), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const BILLER_ID = "010753600031501";
const MERCHANT_CODE = "KB000002283068";
const MERCHANT_TXN_CODE = "KPS004KB000002283068";

// ════════════════════════════════════════════════════════════════════════
// UNIT LEVEL: verifyRecipient itself
// ════════════════════════════════════════════════════════════════════════

describe("verifyRecipient: exact allowlist match, never substring", () => {
  // ── §15 MUST-FAIL ────────────────────────────────────────────────────
  it("A. 'Ipe Novel Fake' in the shop field does NOT verify", () => {
    const result = verifyRecipient({ shopName: "Ipe Novel Fake" });
    expect(result.recipientVerified).toBe(false);
    expect(result.recipientEvidenceType).toBe("insufficient");
  });

  it("B. 'Fake Ipe Novel' in the shop field does NOT verify", () => {
    const result = verifyRecipient({ shopName: "Fake Ipe Novel" });
    expect(result.recipientVerified).toBe(false);
  });

  it("C. 'Ipe Novel Shop 2' in the shop field does NOT verify", () => {
    const result = verifyRecipient({ shopName: "Ipe Novel Shop 2" });
    expect(result.recipientVerified).toBe(false);
  });

  it("the same three impostor values are also rejected via receiverName", () => {
    for (const impostor of ["Ipe Novel Fake", "Fake Ipe Novel", "Ipe Novel Shop 2"]) {
      const result = verifyRecipient({ receiverName: impostor });
      expect(result.recipientVerified, impostor).toBe(false);
    }
  });

  it("H. a merchant code that is a superstring of the real one does NOT verify", () => {
    const result = verifyRecipient({ merchantCode: "KB000002283068XYZ" });
    expect(result.recipientVerified).toBe(false);
  });

  it("no whitespace/prefix/suffix trimming manufactures a match either", () => {
    for (const impostor of [
      "  Ipe Novel Fake  ",
      "IPE NOVEL FAKE",
      "ipe novel fakeshop",
      "notIpe Novel",
    ]) {
      expect(verifyRecipient({ shopName: impostor }).recipientVerified, impostor).toBe(false);
    }
  });

  // ── §16 MUST-PASS ────────────────────────────────────────────────────
  it("A. an exact, field-bound 'Ipe Novel' DOES verify", () => {
    const result = verifyRecipient({ shopName: "Ipe Novel" });
    expect(result.recipientVerified).toBe(true);
    expect(result.recipientEvidenceType).toBe("shop_alias");
    expect(result.recipientEvidenceStrength).toBe("fallback");
  });

  it("B. an exact legitimate alias variant (case/whitespace-normalized) verifies", () => {
    for (const legit of ["ipenovel", "IPE NOVEL", "  Ipe   Novel  ", "ไอพี โนเวล"]) {
      expect(verifyRecipient({ shopName: legit }).recipientVerified, legit).toBe(true);
    }
  });

  it("C. an exact Biller ID verifies with strong evidence, priority over shop alias", () => {
    const result = verifyRecipient({
      receiverAccountOrId: BILLER_ID,
      shopName: "Someone Else Entirely",
    });
    expect(result.recipientVerified).toBe(true);
    expect(result.recipientEvidenceType).toBe("biller_id");
    expect(result.recipientEvidenceStrength).toBe("strong");
  });

  it("D. an exact merchant code verifies with strong evidence", () => {
    const result = verifyRecipient({ merchantCode: MERCHANT_CODE });
    expect(result.recipientVerified).toBe(true);
    expect(result.recipientEvidenceType).toBe("merchant_code");
    expect(result.recipientEvidenceStrength).toBe("strong");
  });

  it("E. an exact merchant transaction code verifies with the HIGHEST-priority strong evidence", () => {
    const result = verifyRecipient({
      merchantTransactionCode: MERCHANT_TXN_CODE,
      merchantCode: "not-the-real-one",
    });
    expect(result.recipientVerified).toBe(true);
    expect(result.recipientEvidenceType).toBe("merchant_transaction_code");
  });

  it("priority: merchant transaction code > merchant code > biller ID > shop alias", () => {
    const all = verifyRecipient({
      merchantTransactionCode: MERCHANT_TXN_CODE,
      merchantCode: MERCHANT_CODE,
      receiverAccountOrId: BILLER_ID,
      shopName: "Ipe Novel",
    });
    expect(all.recipientEvidenceType).toBe("merchant_transaction_code");
  });

  it("G. no recipient field at all -> insufficient, never verified", () => {
    const result = verifyRecipient({});
    expect(result.recipientVerified).toBe(false);
    expect(result.recipientEvidenceType).toBe("insufficient");
    expect(result.recipientEvidenceStrength).toBe("none");
  });
});

// ════════════════════════════════════════════════════════════════════════
// UNIT LEVEL: detectRecipientRawTextMention - diagnostic, never authority
// ════════════════════════════════════════════════════════════════════════

describe("detectRecipientRawTextMention: presentation only", () => {
  it("detects a bare mention anywhere in text", () => {
    expect(detectRecipientRawTextMention("โอนเงินให้ Ipe Novel เรียบร้อยแล้ว")).toBe(true);
    expect(detectRecipientRawTextMention("Note: this was for Ipe Novel merchandise")).toBe(true);
  });

  it("returns false when there is truly no mention", () => {
    expect(detectRecipientRawTextMention("โอนเงินให้ร้านอื่น")).toBe(false);
    expect(detectRecipientRawTextMention("")).toBe(false);
  });

  it("its result cannot set recipientVerified: it is a separate field entirely", () => {
    const code = readCode("server/ocr-slip-verification-v2.ts");
    const start = code.indexOf("export function verifyRecipient(");
    const end = code.indexOf("\n}", start);
    const body = code.slice(start, end);
    expect(body).not.toMatch(/recipientRawTextMention/);
    expect(body).not.toMatch(/detectRecipientRawTextMention/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// PIPELINE LEVEL: extractSlipData -> verifyRecipient, whole-text is inert
// ════════════════════════════════════════════════════════════════════════

describe("extractSlipData: whole-text alias mention synthesizes NOTHING authoritative", () => {
  it("D/G. actual recipient elsewhere, unrelated body text mentions Ipe Novel -> not extracted as shopName", () => {
    const text = [
      "SCB สลิปการโอนเงิน",
      "จำนวนเงิน: 100.00",
      "ผู้รับ: นาย ก ข ค",
      "หมายเหตุ: ซื้อสินค้า Ipe Novel ให้เพื่อน",
    ].join("\n");
    const extracted = extractSlipData(text, 90);
    // The field-bound label ("ผู้รับ:") extracted the REAL recipient, not
    // the merchant alias mentioned in the note.
    expect(extracted.shopName).toBeDefined();
    expect(extracted.shopName?.toLowerCase()).not.toContain("ipe novel");
    expect(verifyRecipient(extracted).recipientVerified).toBe(false);
    // But the mention is still visible to an admin as a diagnostic.
    expect(extracted.recipientRawTextMention).toBe(true);
  });

  it("E. the SENDER mentions Ipe Novel; the recipient field does not -> not extracted, not verified", () => {
    const text = [
      "KBank สลิปโอนเงิน",
      "จำนวนเงิน: 250.00",
      "ผู้โอน: Ipe Novel",
      "ผู้รับ: บริษัท อื่น จำกัด",
    ].join("\n");
    const extracted = extractSlipData(text, 90);
    expect(extracted.shopName?.toLowerCase()).not.toContain("ipe novel");
    expect(verifyRecipient(extracted).recipientVerified).toBe(false);
    expect(extracted.recipientRawTextMention).toBe(true);
  });

  it("F. a footer mentions Ipe Novel with no recipient field context at all -> not verified", () => {
    const text = [
      "จำนวนเงิน: 500.00",
      "วันที่ 23/08/2026",
      "---",
      "Powered by Ipe Novel payment gateway",
    ].join("\n");
    const extracted = extractSlipData(text, 90);
    expect(extracted.shopName).toBeUndefined();
    expect(verifyRecipient(extracted).recipientVerified).toBe(false);
    expect(extracted.recipientRawTextMention).toBe(true);
  });

  it("G. arbitrary OCR body contains 'Ipe Novel' with no field/label anywhere -> not verified", () => {
    const text = "Random unrelated OCR noise mentioning Ipe Novel somewhere in the middle.";
    const extracted = extractSlipData(text, 90);
    expect(extracted.shopName).toBeUndefined();
    expect(verifyRecipient(extracted).recipientVerified).toBe(false);
  });

  it("the whole-text fallback is structurally gone from extractShopName", () => {
    const code = readCode("server/ocr-slip-verification-v2.ts");
    const start = code.indexOf("function extractShopName(");
    const end = code.indexOf("\nfunction ", start + 10);
    const body = code.slice(start, end);
    expect(body).not.toMatch(/return "Ipe Novel"/);
    expect(body).not.toMatch(/for \(const alias of MERCHANT_CONFIG\.shopNameAliases\)/);
  });
});

describe("field-bound extraction still works for real recipient labels", () => {
  it("A. field-bound exact valid recipient still extracts and verifies", () => {
    const text = "ผู้รับ: Ipe Novel\nจำนวนเงิน: 100.00";
    const extracted = extractSlipData(text, 90);
    expect(extracted.shopName).toBe("Ipe Novel");
    expect(verifyRecipient(extracted).recipientVerified).toBe(true);
  });

  it("Thai label ชื่อร้านค้า_หรือ_ชื่อผู้รับ (JSON-style) still field-binds", () => {
    const json = JSON.stringify({
      ผู้รับ: { ชื่อร้านค้า_หรือ_ชื่อผู้รับ: "Ipe Novel" },
      amount: "100.00",
    });
    const extracted = extractSlipData(json, 90);
    expect(extracted.shopName).toBe("Ipe Novel");
    expect(verifyRecipient(extracted).recipientVerified).toBe(true);
  });
});

describe("H. merchant/biller identifiers require full-length exact match", () => {
  it("KB000002283068XYZ in raw text does not extract as the real merchant code", () => {
    const text = "รหัสร้านค้า KB000002283068XYZ เพิ่มเติม";
    const extracted = extractSlipData(text, 90);
    expect(extracted.merchantCode).not.toBe(MERCHANT_CODE);
  });

  it("the exact merchant code, unambiguously bounded, still extracts", () => {
    const text = `merchant code: ${MERCHANT_CODE}`;
    const extracted = extractSlipData(text, 90);
    expect(extracted.merchantCode).toBe(MERCHANT_CODE);
  });
});

// ════════════════════════════════════════════════════════════════════════
// IPE-001 (fourth authority-origin round): "Require labeled evidence for
// the biller ID"
//
// ── The bug ─────────────────────────────────────────────────────────────
// extractBillerId ended with an UNLABELED fallback, `/([0-9]{12,15})/` -
// any 12-15 digit run anywhere in the OCR text, with no requirement that it
// follow a biller-id label. Because an exact Biller ID match is STRONG
// recipient evidence (verifyRecipient treats it as sufficient proof on its
// own, no other signal required), a transfer to a DIFFERENT recipient could
// auto-approve merely because IpeNovel's public biller ID digits happened
// to appear in a memo, a sender field, a reference, or unrelated footer
// text. Same class as the whole-text shop-alias synthesis and the
// unbounded merchant-code regex above - evidence VALUE was exact, but
// evidence ORIGIN was never checked.
//
// extractMerchantCode and extractMerchantTransactionCode had the identical
// gap (their fallbacks were unlabeled too, just format-narrower). All three
// are now label-bound only - empirically verified against every real
// KBank/SCB/Krungthai fixture in this repo (server/ocr-slip-verification-v2.test.ts,
// server/ocr-slip-hardening.test.ts, server/ocr-slip-e2e.test.ts,
// server/ocr-slip-integration.test.ts) with zero regressions before this
// fix was written - see the extractBillerId/extractMerchantCode/
// extractMerchantTransactionCode source comments for the exact audit note.
// ════════════════════════════════════════════════════════════════════════

describe("no unlabeled whole-text fallback remains in ANY strong recipient identifier extractor", () => {
  const code = readCode("server/ocr-slip-verification-v2.ts");

  function patternsBlockOf(fn: string): string {
    const start = code.indexOf(`function ${fn}(`);
    expect(start, fn).toBeGreaterThan(-1);
    const end = code.indexOf("\n}", start);
    const body = code.slice(start, end);
    const patternsStart = body.indexOf("const patterns = [");
    expect(patternsStart, fn).toBeGreaterThan(-1);
    const patternsEnd = body.indexOf("];", patternsStart);
    return body.slice(patternsStart, patternsEnd);
  }

  it("extractMerchantCode's patterns list contains no bare, label-less regex", () => {
    const block = patternsBlockOf("extractMerchantCode");
    // The specific unlabeled fallback this round removed - must never come back.
    expect(block).not.toMatch(/\(\?<!\[A-Z0-9\]\)/);
    expect(block).not.toMatch(/^\s*\/\(\[A-Z\]/m);
    // Every remaining alternative requires a label/value separator.
    for (const line of block.split("\n").filter((l) => l.trim().startsWith("/"))) {
      expect(line, line).toMatch(/\[:：\]/);
    }
  });

  it("extractMerchantTransactionCode's patterns list contains no bare, label-less regex", () => {
    const block = patternsBlockOf("extractMerchantTransactionCode");
    expect(block).not.toMatch(/\/\(\[A-Z\]\{3\}/);
    for (const line of block.split("\n").filter((l) => l.trim().startsWith("/"))) {
      expect(line, line).toMatch(/\[:：\]/);
    }
  });

  it("extractBillerId's patterns list contains no bare, label-less regex", () => {
    const block = patternsBlockOf("extractBillerId");
    // The specific unlabeled fallback this round removed - must never come back.
    expect(block).not.toMatch(/\/\(\[0-9\]\{12,15\}\)\//);
    for (const line of block.split("\n").filter((l) => l.trim().startsWith("/"))) {
      expect(line, line).toMatch(/\[:：\]/);
    }
  });
});

describe("extractBillerId: label-bound only (IPE-001 biller-id authority-origin fix)", () => {
  // ── MUST-FAIL: the exact biller ID appearing WITHOUT a label ───────────
  it("A. biller ID in a memo does not extract, and does not verify the recipient", () => {
    const text = `โอนเงินสำเร็จ\nไปยัง: Some Other Shop\nmemo: ${BILLER_ID}\nจำนวนเงิน 100.00`;
    const extracted = extractSlipData(text, 90);
    expect(extracted.receiverAccountOrId).not.toBe(BILLER_ID);
    const verification = verifyRecipient({ ...extracted, shopName: "Some Other Shop" });
    expect(verification.recipientVerified).toBe(false);
  });

  it("B. biller ID in the sender field does not extract", () => {
    const text = `จาก: ${BILLER_ID}\nไปยัง: Some Other Shop\nจำนวนเงิน 100.00`;
    const extracted = extractSlipData(text, 90);
    expect(extracted.receiverAccountOrId).not.toBe(BILLER_ID);
  });

  it("C. biller ID inside a transaction reference does not extract", () => {
    const text = `Reference: TXN-${BILLER_ID}-END\nไปยัง: Some Other Shop\nจำนวนเงิน 100.00`;
    const extracted = extractSlipData(text, 90);
    expect(extracted.receiverAccountOrId).not.toBe(BILLER_ID);
  });

  it("D. biller ID as bare digits with no field at all does not extract", () => {
    const text = `โอนเงินสำเร็จ\n${BILLER_ID}\nไปยัง: Some Other Shop\nจำนวนเงิน 100.00`;
    const extracted = extractSlipData(text, 90);
    expect(extracted.receiverAccountOrId).not.toBe(BILLER_ID);
  });

  it("E. biller ID in unrelated footer text does not extract", () => {
    const text = `ไปยัง: Some Other Shop\nจำนวนเงิน 100.00\nCustomer service: ${BILLER_ID}`;
    const extracted = extractSlipData(text, 90);
    expect(extracted.receiverAccountOrId).not.toBe(BILLER_ID);
  });

  it("F. an unrelated 12-15 digit number never becomes receiverAccountOrId authority", () => {
    const text = `ไปยัง: Some Other Shop\nจำนวนเงิน 100.00\nAccount ref: 999888777666555`;
    const extracted = extractSlipData(text, 90);
    expect(extracted.receiverAccountOrId).toBeUndefined();
  });

  // ── MUST-PASS: the exact biller ID with an explicit field/label ────────
  it("A. explicit English 'Biller ID:' label extracts", () => {
    const text = `ไปยัง: Ipe Novel\nBiller ID: ${BILLER_ID}\nจำนวนเงิน 100.00`;
    const extracted = extractSlipData(text, 90);
    expect(extracted.receiverAccountOrId).toBe(BILLER_ID);
  });

  it("B. explicit Thai 'รหัสบิลเลอร์:' label extracts", () => {
    const text = `ไปยัง: Ipe Novel\nรหัสบิลเลอร์: ${BILLER_ID}\nจำนวนเงิน 100.00`;
    const extracted = extractSlipData(text, 90);
    expect(extracted.receiverAccountOrId).toBe(BILLER_ID);
  });

  it("B2. the real SCB label variant 'บิลเลอร์ ID:' (Thai + Latin 'ID') extracts - a genuine production fixture depends on this", () => {
    const text = `ไปยัง: Ipe Novel\nบิลเลอร์ ID: ${BILLER_ID}\nจำนวนเงิน 100.00`;
    const extracted = extractSlipData(text, 90);
    expect(extracted.receiverAccountOrId).toBe(BILLER_ID);
  });

  it("C. structured biller_id field (JSON-style OCR block) extracts", () => {
    // extractSlipData flattens a JSON-style block itself; exercised more
    // fully by the structured-fixture tests in ocr-slip-verification-v2.test.ts
    // (the "```json ... biller_id ..." fixtures) - this proves the
    // structured path is untouched by the raw-text fallback removal.
    const jsonText = `\`\`\`json\n{"biller_id": "${BILLER_ID}", "receiver_name": "Ipe Novel"}\n\`\`\``;
    const extracted = extractSlipData(jsonText, 90);
    expect(extracted.receiverAccountOrId).toBe(BILLER_ID);
  });

  it("does not verify the recipient when the biller ID belongs to a DIFFERENT slip's raw text than the current shop field", () => {
    // Exact value, explicit label - but for a shop that isn't the approved
    // one. Only the LABEL requirement is this describe block's concern;
    // verifyRecipient's own exact-match gate (tested elsewhere) is what
    // ultimately decides recipientVerified for a mismatched shop name. This
    // proves the two gates compose correctly rather than one silently
    // overriding the other.
    const extracted = extractSlipData(
      `ไปยัง: Some Other Shop\nBiller ID: 999999999999999\nจำนวนเงิน 100.00`,
      90
    );
    expect(extracted.receiverAccountOrId).toBe("999999999999999");
    const verification = verifyRecipient({ ...extracted, shopName: "Some Other Shop" });
    expect(verification.recipientVerified).toBe(false);
  });
});

describe("real production SCB/KTB bill-payment fixtures still extract and auto-approve (regression)", () => {
  // The exhaustive field-by-field assertions for these exact fixtures
  // already live in server/ocr-slip-verification-v2.test.ts ("Real SCB slip
  // from production" describe blocks) and are re-measured as part of the
  // standard gate; this is a focused proof that this round's label-bound
  // biller-id/merchant-code/transaction-code fix specifically does not
  // regress the two real production texts that motivated it.
  it("the 00:26 fixture's exact recipient evidence still extracts", () => {
    const text = `SCB+\nจ่ายเงินสำเร็จ\n25 พ.ค. 2569 - 00:26\nรหัสอ้างอิง: 2026052560P28bjxEWJQmsbB5\n\nจาก\nนาย ทัชชกร ป.\nxxx-xxx791-1\n\nไปยัง\nIpe Novel\nBiller ID: ${BILLER_ID}\nรหัสร้านค้า : ${MERCHANT_CODE}\nรหัสธุรกรรม : ${MERCHANT_TXN_CODE}\n\nจำนวนเงิน\n100.00`;
    const extracted = extractSlipData(text, 98);
    expect(extracted.receiverAccountOrId).toBe(BILLER_ID);
    expect(extracted.merchantCode).toBe(MERCHANT_CODE);
    expect(extracted.merchantTransactionCode).toBe(MERCHANT_TXN_CODE);
  });

  it("the 09:22 fixture's exact recipient evidence still extracts (บิลเลอร์ ID Thai/Latin label)", () => {
    const text = `SCB+\nจ่ายบิลสำเร็จ\n25 พ.ค. 2569 - 09:22\nรหัสอ้างอิง: 202605253xbL9Yu73dw4SaAnz\n\nจาก\nนาย วีระศักดิ์ เ.\nxxx-xxx244-1\n\nไปยัง\nอิปี นิยายแปล\nบิลเลอร์ ID: ${BILLER_ID}\nรหัสร้านค้า : ${MERCHANT_CODE}\nรหัสธุรกรรม : ${MERCHANT_TXN_CODE}\n\nจำนวนเงิน\n100.00`;
    const extracted = extractSlipData(text, 98);
    expect(extracted.receiverAccountOrId).toBe(BILLER_ID);
    expect(extracted.merchantCode).toBe(MERCHANT_CODE);
    expect(extracted.merchantTransactionCode).toBe(MERCHANT_TXN_CODE);
  });
});

// ════════════════════════════════════════════════════════════════════════
// FULL VERIFYSLIPDATA GATE: invalid/insufficient recipient never blocks
// harder than NEEDS_REVIEW, and never auto-rejects
// ════════════════════════════════════════════════════════════════════════

const context: OrderPaymentContext = {
  orderId: 1,
  paymentId: 1,
  orderTotal: 100,
  orderCreatedAt: new Date("2026-08-24T10:00:00Z"),
  paymentCreatedAt: new Date("2026-08-24T10:05:00Z"),
  slipSubmittedAt: new Date("2026-08-24T10:10:00Z"),
};

function baseExtracted(overrides: Partial<ExtractedSlipData> = {}): ExtractedSlipData {
  return {
    amount: 100,
    transactionDate: new Date("2026-08-24T10:08:00Z"),
    transactionDateTime: new Date("2026-08-24T10:08:00Z"),
    reference: "REF123456789",
    referenceRaw: "REF123456789",
    confidence: 95,
    confidenceKnown: true,
    detectedBank: "SCB",
    ...overrides,
  };
}

describe("an unverified recipient routes to NEEDS_REVIEW, never blocks harder", () => {
  it("insufficient recipient evidence -> RECIPIENT_NOT_VERIFIED, isAutoApproved stays false", () => {
    const result = verifySlipData(
      baseExtracted({ shopName: "Someone Else" }),
      context,
      new Set(),
      new Set()
    );
    expect(result.reviewReason).toBe("RECIPIENT_NOT_VERIFIED");
    expect(result.isAutoApproved).toBe(false);
    // Never an auto-reject: the module has no reject verdict at all.
    expect((result as any).isAutoRejected).toBeUndefined();
  });

  it("an impostor alias in the recipient field is also RECIPIENT_NOT_VERIFIED, not silently accepted", () => {
    const result = verifySlipData(
      baseExtracted({ shopName: "Ipe Novel Fake" }),
      context,
      new Set(),
      new Set()
    );
    expect(result.reviewReason).toBe("RECIPIENT_NOT_VERIFIED");
    expect(result.isAutoApproved).toBe(false);
  });

  it("valid strong recipient evidence lets verification proceed past the recipient gate", () => {
    const result = verifySlipData(
      baseExtracted({ receiverAccountOrId: BILLER_ID }),
      context,
      new Set(),
      new Set()
    );
    expect(result.reviewReason).not.toBe("RECIPIENT_NOT_VERIFIED");
  });

  it("the module never auto-approves on recipient evidence alone if OCR module has no reject path", () => {
    const code = readCode("server/ocr-slip-verification-v2.ts");
    expect(code).not.toMatch(/isAutoRejected\s*:\s*true/);
    expect(code).not.toMatch(/reviewReason:\s*["']AUTO_REJECT/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// REAL BANK REGRESSION: existing fixtures parse correctly through KBank/
// SCB/Krungthai formats already covered by ocr-slip-verification-v2.test.ts
// ════════════════════════════════════════════════════════════════════════

describe("real bank formats: legitimate slips still verify, mentions still don't", () => {
  it("SCB JSON receiver_name field-binds and verifies (KBank/SCB style)", () => {
    const scbJson = JSON.stringify({
      amount: "100.00",
      receiver_name: "Ipe Novel",
      biller_id: BILLER_ID,
    });
    const extracted = extractSlipData(scbJson, 90);
    expect(verifyRecipient(extracted).recipientVerified).toBe(true);
  });

  it("Krungthai-style split merchant transaction code label still extracts and verifies", () => {
    const text = [
      "รหัสธุรกรรม",
      "KPS004KB00000228",
      "3068",
      "จำนวนเงิน: 300.00",
    ].join("\n");
    const extracted = extractSlipData(text, 90);
    expect(extracted.merchantTransactionCode).toBe(MERCHANT_TXN_CODE);
    expect(verifyRecipient(extracted).recipientVerified).toBe(true);
  });

  it("a genuine different-recipient slip whose note happens to mention Ipe Novel fails safe to NEEDS_REVIEW, not a hard reject", () => {
    // The recipient-extraction half is exercised through the real
    // field-scoped parser (proving the note does not leak into shopName);
    // amount/date/reference come from the clean base fixture so this test
    // is not sensitive to unrelated Thai-date-parsing behaviour and
    // actually reaches the recipient gate rather than an earlier one.
    const noteOnlyText = [
      "ผู้รับ: ร้านค้าอื่น จำกัด",
      "หมายเหตุ: ค่าสินค้า Ipe Novel merchandise",
    ].join("\n");
    const { shopName, recipientRawTextMention } = extractSlipData(noteOnlyText, 90);
    expect(shopName?.toLowerCase()).not.toContain("ipe novel");
    expect(recipientRawTextMention).toBe(true);

    const extracted = baseExtracted({ shopName });
    const result = verifySlipData(extracted, context, new Set(), new Set());
    expect(result.reviewReason).toBe("RECIPIENT_NOT_VERIFIED");
    expect(result.isAutoApproved).toBe(false);
  });
});
