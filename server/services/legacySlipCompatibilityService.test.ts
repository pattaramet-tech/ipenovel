import { describe, expect, it } from "vitest";
import {
  describeLegacyMatch,
  fileHashFromExtractedData,
  referenceHashCandidatesFromExtractedData,
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
  pageSize?: number;
} = {}) {
  const claims: any[] = [];
  const pageSize = options.pageSize ?? 500;
  // Records which cursor values the scan actually requested, so a test can
  // prove it really paged rather than reading one capped batch.
  const cursorsSeen: Record<string, number[]> = { payments: [], walletTopups: [] };

  return {
    _claims: claims,
    _cursorsSeen: cursorsSeen,
    insert() {
      return {
        async values(v: any) {
          for (const key of ["referenceHash", "fileHash", "qrPayloadHash"]) {
            if (v[key] && claims.some((c) => c[key] === v[key])) {
              const err: any = new Error("Duplicate entry for key " + key);
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
          const name = String(table?.[Symbol.for("drizzle:Name")] ?? "");
          const rows =
            name === "payments"
              ? (options.approvedPayments ?? [])
              : name === "walletTopups"
                ? (options.approvedTopups ?? [])
                : [];
          return {
            where(cond: any) {
              const cursor = extractCursor(cond);
              if (name in cursorsSeen) cursorsSeen[name].push(cursor);
              return {
                orderBy() {
                  return {
                    limit(n: number) {
                      if (name === "paymentSlipClaims") return Promise.resolve([]);
                      const page = rows
                        .filter((r) => r.id > cursor)
                        .sort((a, b) => a.id - b.id)
                        .slice(0, Math.min(n, pageSize));
                      return Promise.resolve(page);
                    },
                  };
                },
                limit(n: number) {
                  if (name === "paymentSlipClaims") return Promise.resolve([]);
                  return Promise.resolve(rows.slice(0, n));
                },
              };
            },
          };
        },
      };
    },
  };
}

/** Digs the numeric cursor out of a drizzle and(..., gt(id, cursor)) tree. */
function extractCursor(cond: any): number {
  const found: number[] = [];
  const walk = (node: any, depth = 0) => {
    if (!node || depth > 8) return;
    if (typeof node === "number") found.push(node);
    if (Array.isArray(node)) return node.forEach((n) => walk(n, depth + 1));
    if (typeof node === "object") {
      for (const key of Object.keys(node)) walk((node as any)[key], depth + 1);
    }
  };
  walk(cond);
  return found.length ? Math.max(...found) : 0;
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
        // IPE-001-C07: every REAL caller supplies this (see
        // getRawReferenceForLegacyLookup at every db.ts/orderService.ts/
        // slipSubmissionService.ts call site) - without it, the legacy-case
        // ambiguity check never engages at all, matching neither production
        // behavior nor what this test means to exercise.
        referenceRawForLegacyLookup: KBANK_REF,
      },
      tx
    );

    // KBANK_REF has no lowercase to lose, so this row's ONLY evidence is the
    // legacy_uppercase fold - never reference_exact (IPE-001-C07), only the
    // resolvable advisory ambiguity every other uppercase-only row gets.
    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed && outcome.reason === "legacy_case_ambiguity") {
      expect(outcome.matchedSourceType).toBe("order_payment");
      expect(outcome.matchedSourceId).toBe(11);
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
        referenceRawForLegacyLookup: KBANK_REF,
      },
      tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed && outcome.reason === "legacy_case_ambiguity") {
      expect(outcome.matchedSourceType).toBe("wallet_topup");
      expect(outcome.matchedSourceId).toBe(77);
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
        referenceRawForLegacyLookup: KBANK_REF,
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
                  orderBy() {
                    return {
                      limit() {
                        return Promise.reject(new Error("ER_LOCK_WAIT_TIMEOUT"));
                      },
                    };
                  },
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
    // Derivation now re-parses the stored rawText itself, so the reference is
    // recovered directly rather than the caller having to do it.
    expect(referenceHashFromExtractedData(legacyBlob)).toBe(KBANK_HASH);

    // And it agrees with parsing the stored text by hand.
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


// ─── P1: legacy MIXED-CASE reference recovery ────────────────────────────

const SCB_MIXED = "202608225ApOyxElgdOo7YVwv";
const SCB_UPPER = SCB_MIXED.toUpperCase();
const SCB_MIXED_HASH = hashSlipReference(SCB_MIXED)!;

const SCB_RAW_TEXT = [
  "ธนาคารไทยพาณิชย์",
  "SCB EASY",
  "22 ส.ค. 2569 - 14:22",
  "จำนวนเงิน",
  "100.00",
  "รหัสอ้างอิง: " + SCB_MIXED,
  "รหัสร้านค้า : KB000002283068",
].join(String.fromCharCode(10));

describe("legacy rows holding only an UPPER-CASED reference", () => {
  it("re-parses stored rawText so a mixed-case replay is still detected", async () => {
    // The historical row predates referenceRaw: it stored the upper-cased
    // reference, but its rawText still holds the original mixed case.
    const legacy = {
      id: 31,
      extractedData: JSON.stringify({ reference: SCB_UPPER, rawText: SCB_RAW_TEXT }),
    };
    const tx = makeFakeTx({ approvedPayments: [legacy] });

    // A fresh submission whose OCR preserves the original casing.
    const outcome = await claimSlip(
      {
        sourceType: "wallet_topup",
        sourceId: 500,
        userId: 77,
        identifiers: { referenceHash: SCB_MIXED_HASH },
      },
      tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed && outcome.reason === "already_claimed") {
      expect(outcome.existingSourceType).toBe("order_payment");
      expect(outcome.existingSourceId).toBe(31);
    }
  });

  it("prefers reparsed rawText over the uppercase field", () => {
    const candidates = referenceHashCandidatesFromExtractedData(
      JSON.stringify({ reference: SCB_UPPER, rawText: SCB_RAW_TEXT })
    );
    const mixed = candidates.find((c) => c.hash === SCB_MIXED_HASH);
    expect(mixed).toBeDefined();
    expect(mixed!.evidence).toBe("reparsed_raw_text");
    // The uppercase fallback is retained as a lower-priority candidate.
    expect(candidates.some((c) => c.hash === hashSlipReference(SCB_UPPER))).toBe(true);
  });

  it("referenceRaw wins over rawText reparsing when it exists", () => {
    const candidates = referenceHashCandidatesFromExtractedData(
      JSON.stringify({ reference: SCB_UPPER, referenceRaw: SCB_MIXED, rawText: SCB_RAW_TEXT })
    );
    expect(candidates[0].evidence).toBe("reference_raw");
    expect(candidates[0].hash).toBe(SCB_MIXED_HASH);
  });

  it("a stored referenceHash wins over everything", () => {
    const stored = "a".repeat(64);
    const candidates = referenceHashCandidatesFromExtractedData(
      JSON.stringify({ referenceHash: stored, reference: SCB_UPPER, rawText: SCB_RAW_TEXT })
    );
    expect(candidates[0]).toEqual({ hash: stored, evidence: "stored_hash" });
  });

  it("an uppercase-only row with NO rawText is still matched via the upper candidate", async () => {
    const legacy = { id: 32, extractedData: JSON.stringify({ reference: SCB_UPPER }) };
    const tx = makeFakeTx({ approvedPayments: [legacy] });

    const outcome = await claimSlip(
      {
        sourceType: "order_payment",
        sourceId: 900,
        userId: 5,
        identifiers: { referenceHash: SCB_MIXED_HASH },
        // The claim path supplies the raw reference so the LOOKUP can also try
        // its upper-cased form. The claim itself still uses the
        // case-preserving hash - this only widens detection.
        referenceRawForLegacyLookup: SCB_MIXED,
      },
      tx
    );

    expect(outcome.claimed).toBe(false);
  });

  it("the backfill derives the same case-preserving hash as a new submission", () => {
    // Backfill derivation (reparse-first) and fresh OCR must agree, or a
    // backfilled claim would never match the replay it is meant to block.
    const backfillHash = referenceHashFromExtractedData(
      JSON.stringify({ reference: SCB_UPPER, rawText: SCB_RAW_TEXT })
    );
    const freshOcr = extractSlipData(SCB_RAW_TEXT);
    const freshHash = hashSlipReference(freshOcr.referenceRaw ?? freshOcr.reference);
    expect(backfillHash).toBe(freshHash);
    expect(backfillHash).toBe(SCB_MIXED_HASH);
  });

  it("a KBank uppercase/numeric reference is unaffected", () => {
    const candidates = referenceHashCandidatesFromExtractedData(
      JSON.stringify({ reference: KBANK_REF })
    );
    // No lowercase exists, so every derivation path agrees.
    expect(candidates.some((c) => c.hash === KBANK_HASH)).toBe(true);
  });

  it("a rawText that fails to parse falls back safely", () => {
    const candidates = referenceHashCandidatesFromExtractedData(
      JSON.stringify({ reference: SCB_UPPER, rawText: "%%% not a slip %%%" })
    );
    expect(candidates.some((c) => c.hash === hashSlipReference(SCB_UPPER))).toBe(true);
  });

  it("malformed JSON yields no candidates rather than throwing", () => {
    expect(() => referenceHashCandidatesFromExtractedData("{broken")).not.toThrow();
    expect(referenceHashCandidatesFromExtractedData("{broken")).toEqual([]);
  });
});

// ─── P1: the scan must cover EVERY approved row ──────────────────────────

describe("the legacy scan has no correctness cap", () => {
  const filler = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      extractedData: JSON.stringify({ reference: "FILLER" + i + "REF" }),
    }));

  it("finds a duplicate that lives BEYOND the first page", async () => {
    const rows = filler(1200);
    rows[rows.length - 1] = { id: 1200, extractedData: JSON.stringify({ reference: KBANK_REF }) };

    const tx = makeFakeTx({ approvedPayments: rows, pageSize: 500 });
    const outcome = await claimSlip(
      {
        sourceType: "wallet_topup",
        sourceId: 7000,
        userId: 3,
        identifiers: { referenceHash: KBANK_HASH },
        referenceRawForLegacyLookup: KBANK_REF,
      },
      tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed && outcome.reason === "legacy_case_ambiguity") {
      expect(outcome.matchedSourceId).toBe(1200);
    }
  });

  it("actually pages rather than reading one capped batch", async () => {
    const tx = makeFakeTx({ approvedPayments: filler(1200), pageSize: 500 });
    await claimSlip(
      {
        sourceType: "order_payment",
        sourceId: 9999,
        userId: 1,
        identifiers: { referenceHash: hashSlipReference("NOTHINGMATCHES1")! },
      },
      tx
    );

    const cursors = tx._cursorsSeen.payments;
    expect(cursors.length).toBeGreaterThan(2);
    expect(cursors[0]).toBe(0);
    expect(Math.max(...cursors)).toBeGreaterThanOrEqual(1000);
  });

  it("also pages the wallet top-up side", async () => {
    const topups = filler(900);
    topups[899] = { id: 900, extractedData: JSON.stringify({ reference: KBANK_REF }) };

    const tx = makeFakeTx({ approvedTopups: topups, pageSize: 500 });
    const outcome = await claimSlip(
      {
        sourceType: "order_payment",
        sourceId: 4242,
        userId: 8,
        identifiers: { referenceHash: KBANK_HASH },
        referenceRawForLegacyLookup: KBANK_REF,
      },
      tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed && outcome.reason === "legacy_case_ambiguity") {
      expect(outcome.matchedSourceType).toBe("wallet_topup");
      expect(outcome.matchedSourceId).toBe(900);
    }
  });
});

describe("legacy_uppercase provenance can never become an exact match, IPE-001-C07", () => {
  const MIXED_REF = "202608225ApOyxElgdOo7YVwv";
  const MIXED_HASH = hashSlipReference(MIXED_REF)!;
  const DISTINCT_CURRENT_REF = "202608225XyZaBcDeFgH7YVwv";

  it("never adds the uppercase fallback when referenceRaw already preserves casing", () => {
    const candidates = referenceHashCandidatesFromExtractedData(
      JSON.stringify({ reference: MIXED_REF.toUpperCase(), referenceRaw: MIXED_REF })
    );
    expect(candidates.some((c) => c.evidence === "legacy_uppercase")).toBe(false);
  });

  it("never adds the uppercase fallback when rawText reparsing already recovered casing", () => {
    const candidates = referenceHashCandidatesFromExtractedData(
      JSON.stringify({ reference: SCB_UPPER, rawText: SCB_RAW_TEXT })
    );
    expect(candidates.some((c) => c.evidence === "legacy_uppercase")).toBe(false);
  });

  it("never adds the uppercase fallback when a stored referenceHash already exists", () => {
    const stored = "b".repeat(64);
    const candidates = referenceHashCandidatesFromExtractedData(
      JSON.stringify({ referenceHash: stored, reference: MIXED_REF.toUpperCase() })
    );
    expect(candidates.some((c) => c.evidence === "legacy_uppercase")).toBe(false);
  });

  it("DOES add the uppercase fallback when nothing case-preserving was recovered", () => {
    const candidates = referenceHashCandidatesFromExtractedData(
      JSON.stringify({ reference: MIXED_REF.toUpperCase() })
    );
    expect(candidates.some((c) => c.evidence === "legacy_uppercase")).toBe(true);
  });

  it("a case-preserving reference distinct from the legacy row's casing does not manufacture ambiguity", async () => {
    // The historical row has genuine case-preserving evidence (referenceRaw)
    // for a DIFFERENT reference than the current submission. Before
    // IPE-001-C07 the unconditional legacy_uppercase fallback let a
    // same-when-uppercased-but-different current reference collide with this
    // row via the fold, even though real case-preserving evidence already
    // proved they are two distinct references.
    const legacy = {
      id: 41,
      extractedData: JSON.stringify({
        reference: MIXED_REF.toUpperCase(),
        referenceRaw: MIXED_REF,
      }),
    };
    const tx = makeFakeTx({ approvedPayments: [legacy] });

    const outcome = await claimSlip(
      {
        sourceType: "wallet_topup",
        sourceId: 501,
        userId: 1,
        identifiers: { referenceHash: hashSlipReference(DISTINCT_CURRENT_REF) },
        referenceRawForLegacyLookup: DISTINCT_CURRENT_REF,
      },
      tx
    );

    expect(outcome.claimed).toBe(true);
  });

  it("an incoming reference that is itself all-uppercase never becomes reference_exact against a legacy_uppercase-only row", async () => {
    // KBANK_REF has no lowercase, so the CURRENT submission's own hash equals
    // the legacy row's fold exactly - the scenario Codex flagged as
    // permanently hard-blocking with no resolution path. It must still only
    // ever be legacy_case_ambiguity (resolvable), never already_claimed.
    const tx = makeFakeTx({ approvedPayments: [legacyRow(42, KBANK_REF)] });

    const outcome = await claimSlip(
      {
        sourceType: "wallet_topup",
        sourceId: 502,
        userId: 1,
        identifiers: { referenceHash: KBANK_HASH },
        referenceRawForLegacyLookup: KBANK_REF,
      },
      tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed) {
      expect(outcome.reason).toBe("legacy_case_ambiguity");
      expect(outcome.reason).not.toBe("already_claimed");
    }
  });

  it("a genuine exact case-preserving match still hard-blocks as before", async () => {
    const legacy = {
      id: 43,
      extractedData: JSON.stringify({
        reference: MIXED_REF.toUpperCase(),
        referenceRaw: MIXED_REF,
      }),
    };
    const tx = makeFakeTx({ approvedPayments: [legacy] });

    const outcome = await claimSlip(
      {
        sourceType: "wallet_topup",
        sourceId: 503,
        userId: 1,
        identifiers: { referenceHash: MIXED_HASH },
        referenceRawForLegacyLookup: MIXED_REF,
      },
      tx
    );

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed && outcome.reason === "already_claimed") {
      expect(outcome.viaLegacyCompatibility).toBe(true);
    } else {
      throw new Error(`expected already_claimed, got ${JSON.stringify(outcome)}`);
    }
  });
});
