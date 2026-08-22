import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { claimSlip } from "./slipClaimService";
import { getRawReferenceForLegacyLookup, hashSlipReference } from "./slipIdentifierService";
import * as backfillState from "./slipBackfillStateService";

/**
 * P1: `referenceRawForLegacyLookup` existed but no production caller supplied
 * it, so the reverse mixed-case compatibility branch was dead code and a
 * replay could still take the first claim against a legacy approval that kept
 * only the upper-cased reference.
 *
 * Behavioral tests below drive the real claimSlip with the exact shape each
 * live caller now passes; the structural test pins every live call site so a
 * future caller cannot quietly omit it again.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const SCB_MIXED = "202608225ApOyxElgdOo7YVwv";
const SCB_UPPER = SCB_MIXED.toUpperCase();
const SCB_MIXED_HASH = hashSlipReference(SCB_MIXED)!;

/** Approved legacy row: UPPER-CASED reference only, no rawText to reparse. */
const LEGACY_UPPER_ONLY = {
  id: 77,
  extractedData: JSON.stringify({ reference: SCB_UPPER, amount: 100 }),
};

function makeTx(options: {
  approvedPayments?: Array<{ id: number; extractedData: string }>;
  approvedTopups?: Array<{ id: number; extractedData: string }>;
} = {}) {
  const claims: any[] = [];
  return {
    _claims: claims,
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
            where() {
              return {
                orderBy() {
                  return { limit: async () => rows };
                },
                limit: async () => (name === "paymentSlipClaims" ? [] : rows),
              };
            },
          };
        },
      };
    },
  };
}

/** Exactly what every live caller now derives and passes. */
function liveClaimArgs(sourceType: "order_payment" | "wallet_topup", sourceId: number) {
  const persisted = JSON.stringify({ referenceRaw: SCB_MIXED, amount: 100 });
  return {
    sourceType,
    sourceId,
    userId: 4242,
    identifiers: { referenceHash: SCB_MIXED_HASH },
    referenceRawForLegacyLookup: getRawReferenceForLegacyLookup(persisted),
  };
}

describe("every live claim path detects the mixed-case legacy replay", () => {
  it("ORDER auto-approval", async () => {
    const tx = makeTx({ approvedPayments: [LEGACY_UPPER_ONLY] });
    const outcome = await claimSlip(liveClaimArgs("order_payment", 501), tx);

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed && outcome.reason === "already_claimed") {
      expect(outcome.existingSourceId).toBe(77);
    }
    // No financial value: nothing was written.
    expect(tx._claims).toHaveLength(0);
  });

  it("ORDER manual approval", async () => {
    const tx = makeTx({ approvedPayments: [LEGACY_UPPER_ONLY] });
    const outcome = await claimSlip(liveClaimArgs("order_payment", 502), tx);
    expect(outcome.claimed).toBe(false);
    expect(tx._claims).toHaveLength(0);
  });

  it("WALLET auto-approval", async () => {
    const tx = makeTx({ approvedPayments: [LEGACY_UPPER_ONLY] });
    const outcome = await claimSlip(liveClaimArgs("wallet_topup", 503), tx);
    expect(outcome.claimed).toBe(false);
    expect(tx._claims).toHaveLength(0);
  });

  it("WALLET manual approval", async () => {
    const tx = makeTx({ approvedTopups: [LEGACY_UPPER_ONLY] });
    const outcome = await claimSlip(liveClaimArgs("wallet_topup", 504), tx);
    expect(outcome.claimed).toBe(false);
    expect(tx._claims).toHaveLength(0);
  });

  it("WITHOUT the raw reference the same replay would succeed - proving it matters", async () => {
    const tx = makeTx({ approvedPayments: [LEGACY_UPPER_ONLY] });
    const outcome = await claimSlip(
      {
        sourceType: "order_payment",
        sourceId: 505,
        userId: 1,
        identifiers: { referenceHash: SCB_MIXED_HASH },
        // referenceRawForLegacyLookup deliberately omitted (the old behavior).
      },
      tx
    );
    expect(outcome.claimed).toBe(true);
  });

  it("the CLAIM itself still stores the case-preserving hash, never uppercased", async () => {
    const tx = makeTx();
    const outcome = await claimSlip(liveClaimArgs("order_payment", 600), tx);
    expect(outcome.claimed).toBe(true);
    expect(tx._claims[0].referenceHash).toBe(SCB_MIXED_HASH);
    expect(tx._claims[0].referenceHash).not.toBe(hashSlipReference(SCB_UPPER));
  });
});

describe("getRawReferenceForLegacyLookup", () => {
  it("prefers referenceRaw", () => {
    expect(
      getRawReferenceForLegacyLookup(
        JSON.stringify({ reference: SCB_UPPER, referenceRaw: SCB_MIXED })
      )
    ).toBe(SCB_MIXED);
  });

  it("falls back to the legacy reference field", () => {
    expect(getRawReferenceForLegacyLookup(JSON.stringify({ reference: SCB_UPPER }))).toBe(
      SCB_UPPER
    );
  });

  it("returns undefined when there is no usable evidence", () => {
    expect(getRawReferenceForLegacyLookup(JSON.stringify({ amount: 100 }))).toBeUndefined();
    expect(getRawReferenceForLegacyLookup(JSON.stringify({ reference: "ab" }))).toBeUndefined();
    expect(getRawReferenceForLegacyLookup(null)).toBeUndefined();
  });

  it("never throws on malformed JSON", () => {
    expect(() => getRawReferenceForLegacyLookup("{broken")).not.toThrow();
    expect(getRawReferenceForLegacyLookup("{broken")).toBeUndefined();
  });

  it("invents no casing - it returns exactly what was persisted", () => {
    expect(getRawReferenceForLegacyLookup(JSON.stringify({ referenceRaw: SCB_MIXED }))).toBe(
      SCB_MIXED
    );
  });
});

// ─── Structural: no live caller may omit it ──────────────────────────────

describe("every live claimSlip call supplies the compatibility evidence", () => {
  const LIVE_CLAIM_FILES = [
    "server/services/slipSubmissionService.ts",
    "server/services/orderService.ts",
    "server/db.ts",
  ];

  it.each(LIVE_CLAIM_FILES)("%s passes referenceRawForLegacyLookup at every call", (file) => {
    const code = fs
      .readFileSync(path.resolve(process.cwd(), file), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");

    // Every claimSlip({...}) invocation in a live path must carry it.
    const calls = code.match(/claimSlip\(\s*\{[\s\S]*?\},\s*tx\s*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toMatch(/referenceRawForLegacyLookup/);
    }
  });

  it("the repo has no live claimSlip call outside those files", () => {
    const roots = ["server"];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
          const rel = path.relative(process.cwd(), full).replace(/\\/g, "/");
          if (rel.endsWith("slipClaimService.ts")) continue; // the definition
          const src = fs.readFileSync(full, "utf-8");
          if (/\bclaimSlip\(\s*\{/.test(src) && !LIVE_CLAIM_FILES.includes(rel)) {
            offenders.push(rel);
          }
        }
      }
    };
    for (const r of roots) walk(path.resolve(process.cwd(), r));
    expect(offenders).toEqual([]);
  });

  it("only the backfill may bypass the legacy check, via skipLegacyCheck", () => {
    // skipLegacyCheck must not appear in any live server path.
    for (const file of LIVE_CLAIM_FILES) {
      const code = fs.readFileSync(path.resolve(process.cwd(), file), "utf-8");
      expect(code).not.toMatch(/skipLegacyCheck:\s*true/);
    }
  });
});

// ─── P2: the durable completion switch ───────────────────────────────────

describe("the legacy scan is skipped only after a verified backfill", () => {
  const REF = hashSlipReference("016234222922AQR05745")!;

  it("BEFORE completion the historical scan runs and blocks a legacy replay", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    const tx = makeTx({
      approvedPayments: [
        { id: 9, extractedData: JSON.stringify({ reference: "016234222922AQR05745" }) },
      ],
    });

    const outcome = await claimSlip(
      { sourceType: "wallet_topup", sourceId: 1, userId: 1, identifiers: { referenceHash: REF } },
      tx
    );
    expect(outcome.claimed).toBe(false);
  });

  it("AFTER completion the historical scan is skipped", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      approvedPayments: [
        { id: 9, extractedData: JSON.stringify({ reference: "016234222922AQR05745" }) },
      ],
    });

    // The historical row is no longer consulted - the backfill is asserted to
    // have written a real claim for it, and the registry is the authority.
    const outcome = await claimSlip(
      { sourceType: "wallet_topup", sourceId: 1, userId: 1, identifiers: { referenceHash: REF } },
      tx
    );
    expect(outcome.claimed).toBe(true);
  });

  it("AFTER completion an existing REGISTRY duplicate is still blocked", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx();

    const first = await claimSlip(
      { sourceType: "order_payment", sourceId: 1, userId: 1, identifiers: { referenceHash: REF } },
      tx
    );
    const replay = await claimSlip(
      { sourceType: "wallet_topup", sourceId: 2, userId: 2, identifiers: { referenceHash: REF } },
      tx
    );

    expect(first.claimed).toBe(true);
    expect(replay.claimed).toBe(false);
  });

  it("AFTER completion a new unique claim succeeds without scanning history", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeTx({
      approvedPayments: Array.from({ length: 50 }, (_, i) => ({
        id: i + 1,
        extractedData: JSON.stringify({ reference: `HIST${i}REF` }),
      })),
    });

    const outcome = await claimSlip(
      {
        sourceType: "order_payment",
        sourceId: 999,
        userId: 1,
        identifiers: { referenceHash: hashSlipReference("BRANDNEWREF1")! },
      },
      tx
    );
    expect(outcome.claimed).toBe(true);
  });
});
