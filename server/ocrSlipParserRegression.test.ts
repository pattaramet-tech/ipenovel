import { describe, expect, it } from "vitest";
import { extractSlipData, parseOcrConfidence } from "./ocr-slip-verification-v2";
import {
  buildSemanticFingerprint,
  classifyDuplicateEvidence,
  hashQrPayload,
  hashSlipFileBytes,
  hashSlipReference,
  normalizeOcrTextForParsing,
  normalizeSlipReference,
} from "./services/slipIdentifierService";

/**
 * Regression fixtures built from REAL production-like slip OCR output where
 * the text was read correctly but the parser mis-converted it, producing
 * false MISSING_REFERENCE / MISSING_AMOUNT verdicts.
 *
 * These assert PARSER behavior on raw OCR text. They never call an LLM,
 * never touch a database, and never assert on invented values - every
 * expectation below is derived from the literal sample text.
 */

// ─── KBank ────────────────────────────────────────────────────────────────

const KBANK_1 = `ธนาคารกสิกรไทย
K PLUS
โอนเงินสำเร็จ
22 ส.ค. 69 22:29
จาก นาย ทดสอบ ร.
xxx-x-x5456-x
ไปยัง Ipe Novel
เลขที่รายการ: 016234222922AQR05745
จำนวน: 100.00 บาท

Estimated OCR Confidence: 99%`;

const KBANK_2 = `ธนาคารกสิกรไทย
K PLUS
โอนเงินสำเร็จ
22 ส.ค. 67 21:03
จาก นาย ทดสอบ ร.
xxx-x-x5456-x
ไปยัง Ipe Novel
เลขที่รายการ: 016234210331AQR07912
จำนวน: 100.00 บาท

Estimated OCR Confidence: 99/100`;

const KBANK_3 = `ธนาคารกสิกรไทย
K PLUS
22 ส.ค. 69 20:08
xxx-x-x5456-x
เลขที่รายการ: 016234200857AQR04942
จำนวน: 100.00 บาท

OCR Confidence Score: 99%`;

const SCB = `ธนาคารไทยพาณิชย์
SCB EASY
โอนเงินสำเร็จ
22 ส.ค. 2569 - 14:22

**จำนวนเงิน**
100.00

รหัสอ้างอิง: 202608225ApOyxElgdOo7YVwv
Biller ID : 010753600031501
รหัสร้านค้า : KB000002283068
รหัสธุรกรรม : KPS004KB000002283068

OCR Confidence Estimation: 99/100`;

const KTB = `ธนาคารกรุงไทย
Krungthai NEXT
22 ส.ค. 2569 - 13:59
รหัสอ้างอิง: C20260822623413057719
รหัสร้านค้า: KB000002283068
รหัสธุรกรรม: KPS004KB000002283068
จำนวนเงิน: 100.00 บาท

OCR Confidence Score: 99/100`;

describe("KBANK reference extraction (เลขที่รายการ)", () => {
  it("KBANK #1 extracts the transaction reference - no MISSING_REFERENCE", () => {
    const extracted = extractSlipData(KBANK_1);
    expect(extracted.reference).toBe("016234222922AQR05745");
    expect(extracted.referenceRaw).toBe("016234222922AQR05745");
  });

  it("KBANK #1 extracts amount, datetime and confidence 99", () => {
    const extracted = extractSlipData(KBANK_1);
    expect(extracted.amount).toBe(100);
    expect(extracted.transactionDate).toBeInstanceOf(Date);
    expect(extracted.visionConfidence).toBe(99);
    expect(extracted.confidenceKnown).toBe(true);
  });

  it("KBANK #2 extracts reference and amount even though the OCR year is wrong", () => {
    const extracted = extractSlipData(KBANK_2);
    expect(extracted.reference).toBe("016234210331AQR07912");
    expect(extracted.amount).toBe(100);
    expect(extracted.visionConfidence).toBe(99);
  });

  it("KBANK #2 does NOT silently correct the misread year 67 to 69", () => {
    const extracted = extractSlipData(KBANK_2);
    // The slip was really from year 69 (2026) but OCR read "67". Neither
    // candidate for "67" (2067 AD, 2024 BE-derived) falls inside the allowed
    // window, so the parser yields NO date rather than snapping to the
    // "intended" year. Failing safe to review is required; guessing 69 is
    // explicitly forbidden.
    expect(extracted.transactionDate).toBeUndefined();
    expect(extracted.transactionDateTime).toBeUndefined();

    // Critically, it must not have silently produced the *correct* year
    // either - that would mean the parser repaired the OCR misread.
    expect(extracted.transactionDate?.getUTCFullYear()).not.toBe(2026);
  });

  it("KBANK #2's unresolvable date routes to review, not to an invented value", () => {
    const extracted = extractSlipData(KBANK_2);
    // Everything else on the slip parsed fine; only the date is unusable.
    // That combination is exactly what must reach an admin.
    expect(extracted.reference).toBe("016234210331AQR07912");
    expect(extracted.amount).toBe(100);
    expect(extracted.transactionDate).toBeUndefined();
  });

  it("KBANK #3 extracts reference and amount", () => {
    const extracted = extractSlipData(KBANK_3);
    expect(extracted.reference).toBe("016234200857AQR04942");
    expect(extracted.amount).toBe(100);
  });

  it("does NOT promote a receiver account/biller id to the transaction reference", () => {
    const withReceiverId = `ธนาคารกสิกรไทย
เลขที่บัญชีผู้รับ: 202608223588503
เลขที่รายการ: 016234222922AQR05745
จำนวน: 100.00 บาท`;
    const extracted = extractSlipData(withReceiverId);
    expect(extracted.reference).toBe("016234222922AQR05745");
    expect(extracted.reference).not.toBe("202608223588503");
  });
});

describe("SCB amount + reference extraction", () => {
  it("extracts an amount rendered as markdown-bold label on its own line", () => {
    const extracted = extractSlipData(SCB);
    expect(extracted.amount).toBe(100);
  });

  it("extracts the mixed-case reference preserving its original casing", () => {
    const extracted = extractSlipData(SCB);
    expect(extracted.referenceRaw).toBe("202608225ApOyxElgdOo7YVwv");
  });

  it("extracts merchant/biller evidence", () => {
    const extracted = extractSlipData(SCB);
    expect(extracted.merchantCode).toBe("KB000002283068");
    expect(extracted.merchantTransactionCode).toBe("KPS004KB000002283068");
  });

  it("reads confidence from 'OCR Confidence Estimation: 99/100'", () => {
    const extracted = extractSlipData(SCB);
    expect(extracted.visionConfidence).toBe(99);
    expect(extracted.confidenceKnown).toBe(true);
  });
});

describe("Krungthai extraction", () => {
  it("extracts reference, amount and merchant codes", () => {
    const extracted = extractSlipData(KTB);
    expect(extracted.reference).toBe("C20260822623413057719");
    expect(extracted.amount).toBe(100);
    expect(extracted.merchantCode).toBe("KB000002283068");
    expect(extracted.merchantTransactionCode).toBe("KPS004KB000002283068");
  });
});

describe("parseOcrConfidence", () => {
  it.each([
    ["OCR Confidence Score: 99%", 99],
    ["OCR Confidence Score: 99/100", 99],
    ["Estimated OCR Confidence: 99%", 99],
    ["Estimated OCR Confidence: 99/100", 99],
    ["OCR Confidence Estimation: 99%", 99],
    ["OCR Confidence Estimation: 99/100", 99],
    ["**OCR Confidence Score:** 98/100", 98],
  ])("parses %j as %i", (text, expected) => {
    expect(parseOcrConfidence(text)).toBe(expected);
  });

  it("returns undefined - never 85 - when no confidence is stated", () => {
    expect(parseOcrConfidence("ธนาคารกสิกรไทย\nจำนวน: 100.00 บาท")).toBeUndefined();
  });

  it("never mistakes the /100 denominator for the score", () => {
    expect(parseOcrConfidence("OCR Confidence Score: 7/100")).toBe(7);
  });
});

describe("confidence fallback removal", () => {
  it("marks confidence unknown when the OCR text states none", () => {
    const extracted = extractSlipData("ธนาคารกสิกรไทย\nเลขที่รายการ: ABCD1234\nจำนวน: 100.00 บาท");
    expect(extracted.confidenceKnown).toBe(false);
    // The invented 85 must be gone - an unstated confidence never produces it.
    expect(extracted.visionConfidence).not.toBe(85);
    expect(extracted.visionConfidence).toBe(0);
  });

  it("treats an explicitly supplied vision confidence as known", () => {
    const extracted = extractSlipData("เลขที่รายการ: ABCD1234", 91);
    expect(extracted.confidenceKnown).toBe(true);
    expect(extracted.visionConfidence).toBe(91);
  });
});

describe("normalizeOcrTextForParsing", () => {
  it("strips markdown emphasis without altering the numbers", () => {
    expect(normalizeOcrTextForParsing("**จำนวนเงิน**\n100.00")).toContain("100.00");
    expect(normalizeOcrTextForParsing("**จำนวนเงิน**\n100.00")).toContain("จำนวนเงิน");
  });

  it("preserves thousands separators and decimals exactly", () => {
    expect(normalizeOcrTextForParsing("*ยอด* 1,234.56")).toContain("1,234.56");
  });

  it("preserves a reference token untouched", () => {
    expect(normalizeOcrTextForParsing("- รหัสอ้างอิง: 202608225ApOyxElgdOo7YVwv")).toContain(
      "202608225ApOyxElgdOo7YVwv"
    );
  });

  it("keeps newlines so label-on-previous-line layouts still parse", () => {
    expect(normalizeOcrTextForParsing("จำนวนเงิน\n100.00")).toBe("จำนวนเงิน\n100.00");
  });
});

// ─── Strong vs weak duplicate model ───────────────────────────────────────

describe("normalizeSlipReference", () => {
  it("strips OCR line-wrap whitespace", () => {
    expect(normalizeSlipReference(" 0162342229 22AQR05745 ")).toBe("016234222922AQR05745");
  });

  it("PRESERVES case - upper-casing would collide distinct SCB references", () => {
    expect(normalizeSlipReference("202608225ApOyxElgdOo7YVwv")).toBe(
      "202608225ApOyxElgdOo7YVwv"
    );
  });

  it("keeps two references that differ only by case distinct", () => {
    expect(normalizeSlipReference("aBcD1234")).not.toBe(normalizeSlipReference("AbCd1234"));
    expect(hashSlipReference("aBcD1234")).not.toBe(hashSlipReference("AbCd1234"));
  });

  it("returns undefined for empty/too-short input rather than an empty key", () => {
    expect(normalizeSlipReference("")).toBeUndefined();
    expect(normalizeSlipReference("  ")).toBeUndefined();
    expect(normalizeSlipReference("ab")).toBeUndefined();
    expect(hashSlipReference(undefined)).toBeUndefined();
  });

  it("is deterministic", () => {
    expect(hashSlipReference("016234222922AQR05745")).toBe(
      hashSlipReference("016234222922AQR05745")
    );
  });
});

describe("hash namespacing", () => {
  it("a reference hash never collides with a file hash of the same text", () => {
    const text = "016234222922AQR05745";
    expect(hashSlipReference(text)).not.toBe(hashSlipFileBytes(Buffer.from(text)));
  });

  it("a QR hash never collides with a reference hash of the same payload", () => {
    const payload = "00020101021229370016A00000067701011101";
    expect(hashQrPayload(payload)).not.toBe(hashSlipReference(payload));
  });

  it("identical slip bytes produce an identical file hash", () => {
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    expect(hashSlipFileBytes(bytes)).toBe(hashSlipFileBytes(Buffer.from([1, 2, 3, 4, 5])));
  });

  it("different slip bytes produce different file hashes", () => {
    expect(hashSlipFileBytes(Buffer.from([1, 2, 3]))).not.toBe(
      hashSlipFileBytes(Buffer.from([1, 2, 4]))
    );
  });
});

describe("semanticFingerprint is a WEAK signal", () => {
  const base = {
    detectedBank: "KBANK",
    maskedAccount: "xxx-x-x5456-x",
    amount: 100,
    transactionDate: new Date(Date.UTC(2026, 7, 22)),
  };

  it("collides for two legitimate same-day same-amount transfers - by design", () => {
    // This is exactly why it must never be treated as proof.
    expect(buildSemanticFingerprint(base)).toBe(buildSemanticFingerprint({ ...base }));
  });

  it("returns undefined when too few fields are present to mean anything", () => {
    expect(buildSemanticFingerprint({})).toBeUndefined();
    expect(buildSemanticFingerprint({ detectedBank: "KBANK" })).toBeUndefined();
  });
});

describe("classifyDuplicateEvidence", () => {
  it("an exact reference match is STRONG", () => {
    const e = classifyDuplicateEvidence({ matchedStrong: "reference" });
    expect(e.strength).toBe("strong");
    expect(e.reasonCode).toBe("DUPLICATE_REFERENCE");
  });

  it("an exact file-hash match is STRONG", () => {
    expect(classifyDuplicateEvidence({ matchedStrong: "file" }).reasonCode).toBe(
      "DUPLICATE_FILE"
    );
  });

  it("a QR payload-hash match is STRONG", () => {
    expect(classifyDuplicateEvidence({ matchedStrong: "qr" }).reasonCode).toBe("DUPLICATE_QR");
  });

  it("same bank+account+amount+date with a DIFFERENT reference is WEAK only", () => {
    const e = classifyDuplicateEvidence({ matchedWeak: true });
    expect(e.strength).toBe("weak");
    expect(e.reasonCode).toBe("WEAK_DUPLICATE_RISK");
    expect(e.detail).toMatch(/NOT proof/i);
  });

  it("no reference + same bank/account/amount/date is never a confirmed duplicate", () => {
    const e = classifyDuplicateEvidence({ matchedWeak: true });
    expect(e.strength).not.toBe("strong");
    expect(e.strongKind).toBeUndefined();
  });

  it("strong evidence wins when both are present", () => {
    const e = classifyDuplicateEvidence({ matchedStrong: "reference", matchedWeak: true });
    expect(e.strength).toBe("strong");
  });

  it("no match at all yields 'none'", () => {
    expect(classifyDuplicateEvidence({}).strength).toBe("none");
  });
});
