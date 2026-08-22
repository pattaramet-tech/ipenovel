import { describe, expect, it } from "vitest";
import {
  describeLegacyMatch,
  fileHashFromExtractedData,
  referenceHashFromExtractedData,
} from "./legacySlipCompatibilityService";
import { claimSlip } from "./slipClaimService";
import { hashSlipReference } from "./slipIdentifierService";
import { extractSlipData } from "../ocr-slip-verification-v2";

/**
 * Legacy approved-slip compatibility (Codex P1).
 *
 * paymentSlipClaims starts EMPTY at migration time, so a payment or top-up
 * approved BEFORE the registry existed has no claim row and would otherwise
 * be replayable. These tests prove the compatibility layer closes that gap
 * globally - across users AND across both financial sources.
 */

const KBANK_REF = "016234222922AQR05745";
const KBANK_HASH = hashSlipReference(KBANK_REF)!;

/**
 * Fake transaction whose `select().from(table)` returns whichever approved
 * rows the test configured, and whose claim inserts enforce the UNIQUE
 * indexes. Mirrors how the real query shapes are consumed.
 */
function makeFakeTx(options: {
  approvedPayments?: Array<{ id: number; extractedData: string }>;
  approvedTopups?: Array<{ id: number; extractedData: string }>;
} = {}) {
  const claims: any[] = [];
  let call = 0;

  return {
    _claims: claims,
    insert() {
      return {
        async values(v: any) {
          for (const key of ["referenceHash", "fileHash", "qrPayloadHash"]) {
            if (v[key] && claims.some((c) => c[key] === v[key])) {
              const err: any = new Error(`Duplicate entry for key '${key}'`);
              err.code = "ER_DUP_ENTRY";
              throw err;
            }
          }
          claims.push(v);
          return [{ insertId: claims.length }];
        },
      };
    },
    select() {
      return {
        from(table: any) {
          const name = table?.[Symbol.for("drizzle:Name")] ?? "";
          return {
            where() {
              return {
                limit() {
                  // paymentSlipClaims lookups come from findExistingClaim.
                  if (name === "paymentSlipClaims") return Promise.resolve([]);
                  if (name === "payments") {
                    return Promise.resolve(options.approvedPayments ?? []);
                  }
                  if (name === "walletTopups") {
                    return Promise.resolve(options.approvedTopups ?? []);
                  }
                  // Fallback ordering for environments where the table name
                  // symbol is unavailable: payments then topups.
                  call += 1;
                  return Promise.resolve(
                    call === 1 ? (options.approvedPayments ?? []) : (options.approvedTopups ?? [])
                  );
                },
              };
            },
          };
        },
      };
    },
  };
}

function legacyRow(id: number, reference: string) {
  return { id, extractedData: JSON.stringify({ reference, amount: 100 }) };
}

describe("referenceHashFromExtractedData", () => {
  it("hashes a legacy row that stored only `reference`", () => {
    expect(referenceHashFromExtractedData(JSON.stringify({ reference: KBANK_REF }))).toBe(
      KBANK_HASH
    );
  });

  it("prefers referenceRaw (original casing) over the upper-cased legacy field", () => {
    const raw = "202608225ApOyxElgdOo7YVwv";
    const hash = referenceHashFromExtractedData(
      JSON.stringify({ reference: raw.toUpperCase(), referenceRaw: raw })
    );
    expect(hash).toBe(hashSlipReference(raw));
  });

  it("uses a stored referenceHash when present", () => {
    const stored = "c".repeat(64);
    expect(referenceHashFromExtractedData(JSON.stringify({ referenceHash: stored }))).toBe(stored);
  });

  it("returns undefined for malformed JSON rather than throwing", () => {
    expect(() => referenceHashFromExtractedData("{broken")).not.toThrow();
    expect(referenceHashFromExtractedData("{broken")).toBeUndefined();
    expect(referenceHashFromExtractedData(null)).toBeUndefined();
  });

  it("reads a stored fileHash", () => {
    const f = "d".repeat(64);
    expect(fileHashFromExtractedData(JSON.stringify({ fileHash: f }))).toBe(f);
  });
});

describe("an OLD approved record blocks a NEW replay", () => {
  it("an approved ORDER payment blocks a new WALLET top-up replay", async () => {
    const tx = makeFakeTx({ approvedPayments: [legacyRow(11, KBANK_REF)] });

    const outcome = await claimSlip(
      {
        sourceType: "wallet_topup",
        sourceId: 99,
        userId: 4242,
        identifiers: { referenceHash: KBANK_HASH },
      },
      tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed && outcome.reason === "already_claimed") {
      expect(outcome.existingSourceType).toBe("order_payment");
      expect(outcome.existingSourceId).toBe(11);
      expect(outcome.viaLegacyCompatibility).toBe(true);
    }
    // Nothing may be written when the legacy gate refuses.
    expect(tx._claims).toHaveLength(0);
  });

  it("an approved WALLET top-up blocks a new ORDER payment replay", async () => {
    const tx = makeFakeTx({ approvedTopups: [legacyRow(77, KBANK_REF)] });

    const outcome = await claimSlip(
      {
        sourceType: "order_payment",
        sourceId: 5,
        userId: 1,
        identifiers: { referenceHash: KBANK_HASH },
      },
      tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed && outcome.reason === "already_claimed") {
      expect(outcome.existingSourceType).toBe("wallet_topup");
      expect(outcome.existingSourceId).toBe(77);
    }
  });

  it("blocks the replay even when it is a DIFFERENT user", async () => {
    const tx = makeFakeTx({ approvedPayments: [legacyRow(11, KBANK_REF)] });
    const outcome = await claimSlip(
      {
        sourceType: "wallet_topup",
        sourceId: 100,
        userId: 999999, // unrelated user
        identifiers: { referenceHash: KBANK_HASH },
      },
      tx
    );
    expect(outcome.claimed).toBe(false);
  });

  it("an exact FILE hash match in a legacy row is also blocked", async () => {
    const fileHash = "e".repeat(64);
    const tx = makeFakeTx({
      approvedPayments: [{ id: 12, extractedData: JSON.stringify({ fileHash }) }],
    });
    const outcome = await claimSlip(
      { sourceType: "wallet_topup", sourceId: 3, userId: 2, identifiers: { fileHash } },
      tx
    );
    expect(outcome.claimed).toBe(false);
  });

  it("a genuinely NEW slip still claims successfully", async () => {
    const tx = makeFakeTx({ approvedPayments: [legacyRow(11, KBANK_REF)] });
    const outcome = await claimSlip(
      {
        sourceType: "order_payment",
        sourceId: 6,
        userId: 1,
        identifiers: { referenceHash: hashSlipReference("016234210331AQR07912")! },
      },
      tx
    );
    expect(outcome.claimed).toBe(true);
  });

  it("a record does not conflict with ITSELF on re-approval", async () => {
    const tx = makeFakeTx({ approvedPayments: [legacyRow(11, KBANK_REF)] });
    const outcome = await claimSlip(
      {
        sourceType: "order_payment",
        sourceId: 11, // same record
        userId: 1,
        identifiers: { referenceHash: KBANK_HASH },
      },
      tx
    );
    expect(outcome.claimed).toBe(true);
  });

  it("a failing legacy lookup is NOT treated as 'no duplicate'", async () => {
    const brokenTx = {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  limit() {
                    return Promise.reject(new Error("ER_LOCK_WAIT_TIMEOUT"));
                  },
                };
              },
            };
          },
        };
      },
      insert() {
        return { async values() { return [{ insertId: 1 }]; } };
      },
    };

    // Must propagate so the surrounding transaction rolls back, rather than
    // silently proceeding as if the slip were unique.
    await expect(
      claimSlip(
        {
          sourceType: "order_payment",
          sourceId: 1,
          userId: 1,
          identifiers: { referenceHash: KBANK_HASH },
        },
        brokenTx
      )
    ).rejects.toThrow(/ER_LOCK_WAIT_TIMEOUT/);
  });
});

describe("legacy rows that previously failed MISSING_REFERENCE can be re-parsed locally", () => {
  const KBANK_RAW_TEXT = `ธนาคารกสิกรไทย
K PLUS
22 ส.ค. 69 22:29
xxx-x-x5456-x
เลขที่รายการ: 016234222922AQR05745
จำนวน: 100.00 บาท`;

  it("the old rawText yields a reference through the LOCAL parser - no LLM call", () => {
    // This is exactly the KBank case that produced MISSING_REFERENCE before
    // `เลขที่รายการ` was a recognised label. The text was always sufficient;
    // only the parser could not read it. The backfill re-parses stored
    // rawText locally to recover these references.
    const reparsed = extractSlipData(KBANK_RAW_TEXT);
    expect(reparsed.reference).toBe(KBANK_REF);
    expect(hashSlipReference(reparsed.referenceRaw ?? reparsed.reference)).toBe(KBANK_HASH);
  });

  it("a legacy row storing rawText but no reference is recoverable", () => {
    const legacyBlob = JSON.stringify({ rawText: KBANK_RAW_TEXT, amount: 100 });
    // Direct derivation finds nothing...
    expect(referenceHashFromExtractedData(legacyBlob)).toBeUndefined();
    // ...but re-parsing the stored text does.
    const parsed = JSON.parse(legacyBlob);
    const recovered = extractSlipData(parsed.rawText);
    expect(hashSlipReference(recovered.referenceRaw ?? recovered.reference)).toBe(KBANK_HASH);
  });
});

describe("describeLegacyMatch", () => {
  it("names the owning record without leaking a hash", () => {
    const msg = describeLegacyMatch({
      sourceType: "wallet_topup",
      sourceId: 42,
      kind: "reference",
    });
    expect(msg).toMatch(/wallet top-up #42/);
    expect(msg).toMatch(/predates the claim registry/i);
    expect(msg).not.toMatch(/[0-9a-f]{32,}/);
  });

  it("describes a file match distinctly", () => {
    expect(
      describeLegacyMatch({ sourceType: "order_payment", sourceId: 7, kind: "file" })
    ).toMatch(/exact slip image/i);
  });
});
