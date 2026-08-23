import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getTableConfig } from "drizzle-orm/mysql-core";
import { paymentSlipClaims } from "../../drizzle/schema";
import { claimSlip } from "./slipClaimService";
import { getRawReferenceForLegacyLookup, hashSlipReference } from "./slipIdentifierService";
import * as backfillState from "./slipBackfillStateService";

/**
 * P1: retiring the historical scan must not retire mixed-case protection.
 *
 * `--mark-complete` disables the legacy scan, which was the ONLY place the
 * upper-cased candidate was compared. A legacy approval holding only an
 * upper-cased `reference` (true casing unrecoverable, no rawText) is stored by
 * the backfill under the upper-case hash, so a replay whose fresh OCR keeps
 * the original mixed case has a different case-preserving hash and could take
 * a new claim once the scan was off.
 *
 * The fix is an INDEXED, non-unique `referenceHashUpper` alias on the claim
 * registry, checked on every claim regardless of scan state.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const SCB_MIXED = "202608225ApOyxElgdOo7YVwv";
const SCB_UPPER = SCB_MIXED.toUpperCase();
const MIXED_HASH = hashSlipReference(SCB_MIXED)!;
const UPPER_HASH = hashSlipReference(SCB_UPPER)!;

/** Registry fake honouring the UNIQUE hashes and the alias index. */
function makeRegistry(seed: any[] = []) {
  const claims = [...seed];
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
          return {
            where(cond: any) {
              const wanted = findHash(cond);
              return {
                orderBy() {
                  return { limit: async () => [] };
                },
                limit: async () => {
                  if (name !== "paymentSlipClaims") return [];
                  if (!wanted) return [];
                  // Match only the COLUMNS the query actually targets, so an
                  // alias lookup cannot accidentally be satisfied by a plain
                  // referenceHash match (which is what the bug relied on).
                  const cols = findColumns(cond);
                  const candidates = cols.length
                    ? cols
                    : ["referenceHash", "fileHash", "qrPayloadHash"];
                  return claims.filter((c) => candidates.some((col) => c[col] === wanted));
                },
              };
            },
          };
        },
      };
    },
  };
}

/**
 * Collects the claim column names a drizzle condition actually TARGETS.
 *
 * Reads `queryChunks[].name` directly rather than walking the whole tree: each
 * condition embeds the entire table object, so a naive recursive walk collects
 * every column name and makes an alias-only query look like it targets
 * referenceHash too - which would mask the very bug under test.
 */
function findColumns(cond: any): string[] {
  const names = new Set<string>();
  const known = ["referenceHash", "referenceHashUpper", "fileHash", "qrPayloadHash"];

  const visit = (node: any, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 4) return;
    for (const chunk of node.queryChunks ?? []) {
      if (chunk && typeof chunk === "object") {
        if (typeof chunk.name === "string" && known.includes(chunk.name)) {
          names.add(chunk.name);
        }
        // or(...) nests further conditions inside its chunks.
        visit(chunk, depth + 1);
      }
    }
  };
  visit(cond);
  return [...names];
}

/** Pulls the 64-hex bound value out of a drizzle eq() condition tree. */
function findHash(cond: any): string | undefined {
  const found: string[] = [];
  const walk = (node: any, depth = 0) => {
    if (!node || depth > 8) return;
    if (typeof node === "string" && /^[0-9a-f]{64}$/.test(node)) found.push(node);
    if (Array.isArray(node)) return node.forEach((n) => walk(n, depth + 1));
    if (typeof node === "object") for (const k of Object.keys(node)) walk(node[k], depth + 1);
  };
  walk(cond);
  return found[0];
}

/** A backfilled legacy claim: upper-case reference only, alias populated. */
const LEGACY_CLAIM = {
  sourceType: "order_payment",
  sourceId: 42,
  userId: 7,
  referenceHash: UPPER_HASH,
  referenceHashUpper: UPPER_HASH,
  fileHash: null,
  qrPayloadHash: null,
};

function replayRequest(sourceId = 900) {
  const persisted = JSON.stringify({ referenceRaw: SCB_MIXED });
  return {
    sourceType: "wallet_topup" as const,
    sourceId,
    userId: 999,
    identifiers: { referenceHash: MIXED_HASH },
    referenceRawForLegacyLookup: getRawReferenceForLegacyLookup(persisted),
  };
}

describe("mixed-case protection survives backfill completion", () => {
  it("AFTER completion, a mixed-case replay of an upper-case legacy claim is BLOCKED", async () => {
    // The historical scan is off - the alias index is the only thing left.
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeRegistry([LEGACY_CLAIM]);

    const outcome = await claimSlip(replayRequest(), tx);

    expect(outcome.claimed).toBe(false);
    if (!outcome.claimed && outcome.reason === "already_claimed") {
      expect(outcome.existingSourceType).toBe("order_payment");
      expect(outcome.existingSourceId).toBe(42);
      expect(outcome.viaLegacyCompatibility).toBe(true);
    }
    // No value created.
    expect(tx._claims).toHaveLength(1);
  });

  it("BEFORE completion it is blocked too (belt and braces)", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(true);
    const tx = makeRegistry([LEGACY_CLAIM]);
    const outcome = await claimSlip(replayRequest(), tx);
    expect(outcome.claimed).toBe(false);
  });

  it("the alias check runs even when the scan is skipped", async () => {
    // Distinguishing evidence: with the scan off and NO alias on the legacy
    // claim, the replay would succeed - so the alias is what blocks it.
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const withoutAlias = { ...LEGACY_CLAIM, referenceHashUpper: null };
    const tx = makeRegistry([withoutAlias]);

    const outcome = await claimSlip(replayRequest(), tx);
    expect(outcome.claimed).toBe(true);
  });

  it("a genuinely new reference still claims successfully after completion", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeRegistry([LEGACY_CLAIM]);

    const persisted = JSON.stringify({ referenceRaw: "016234222922AQR05745" });
    const outcome = await claimSlip(
      {
        sourceType: "order_payment",
        sourceId: 1000,
        userId: 3,
        identifiers: { referenceHash: hashSlipReference("016234222922AQR05745")! },
        referenceRawForLegacyLookup: getRawReferenceForLegacyLookup(persisted),
      },
      tx
    );
    expect(outcome.claimed).toBe(true);
  });

  it("a claim never matches its OWN alias on re-approval", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const own = { ...LEGACY_CLAIM, sourceType: "order_payment", sourceId: 42 };
    const tx = makeRegistry([own]);

    const persisted = JSON.stringify({ referenceRaw: SCB_MIXED });
    const outcome = await claimSlip(
      {
        sourceType: "order_payment",
        sourceId: 42, // same record
        userId: 7,
        identifiers: { referenceHash: MIXED_HASH },
        referenceRawForLegacyLookup: getRawReferenceForLegacyLookup(persisted),
      },
      tx
    );
    // Not reported as someone else's replay.
    expect(outcome.claimed).toBe(true);
  });

  it("new claims persist their own alias for future replays", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeRegistry();

    await claimSlip(replayRequest(1234), tx);
    expect(tx._claims[0].referenceHashUpper).toBe(UPPER_HASH);
    // The authoritative hash is still the case-preserving one.
    expect(tx._claims[0].referenceHash).toBe(MIXED_HASH);
    expect(tx._claims[0].referenceHash).not.toBe(UPPER_HASH);
  });

  it("no alias is stored when there is no raw reference evidence", async () => {
    vi.spyOn(backfillState, "isLegacyScanRequired").mockResolvedValue(false);
    const tx = makeRegistry();
    await claimSlip(
      {
        sourceType: "order_payment",
        sourceId: 5,
        userId: 1,
        identifiers: { fileHash: "f".repeat(64) },
      },
      tx
    );
    expect(tx._claims[0].referenceHashUpper).toBeNull();
  });
});

describe("the alias is a lookup, never a constraint", () => {
  const { indexes, uniqueConstraints } = getTableConfig(paymentSlipClaims);

  it("referenceHashUpper has a NON-unique index", () => {
    const idx = indexes.find(
      (i: any) => i.config.name === "paymentSlipClaims_referenceHashUpper_idx"
    );
    expect(idx).toBeDefined();
    expect(idx?.config.unique).toBeFalsy();
  });

  it("referenceHashUpper is NOT a unique constraint - folding is lossy", () => {
    const names = [
      ...indexes.filter((i: any) => i.config.unique).map((i: any) => i.config.name),
      ...(uniqueConstraints ?? []).map((u: any) => u.name),
    ];
    expect(names.some((n) => String(n).includes("referenceHashUpper"))).toBe(false);
  });

  it("the case-preserving referenceHash remains UNIQUE - it is the authority", () => {
    const names = [
      ...indexes.filter((i: any) => i.config.unique).map((i: any) => i.config.name),
      ...(uniqueConstraints ?? []).map((u: any) => u.name),
    ];
    expect(names.some((n) => String(n).includes("referenceHash_unique"))).toBe(true);
  });
});

describe("migration 0038 is additive only", () => {
  const sql = fs.readFileSync(
    path.resolve(process.cwd(), "drizzle/0038_add_slip_claim_reference_alias.sql"),
    "utf-8"
  );

  it("adds the column and its index, nothing else", () => {
    expect(sql).toMatch(/ADD `referenceHashUpper` varchar\(64\)/);
    expect(sql).toMatch(/CREATE INDEX `paymentSlipClaims_referenceHashUpper_idx`/);
  });

  it("contains no destructive statement", () => {
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("does not add a UNIQUE constraint on the alias", () => {
    expect(sql).not.toMatch(/UNIQUE[^;]*referenceHashUpper/i);
  });
});
