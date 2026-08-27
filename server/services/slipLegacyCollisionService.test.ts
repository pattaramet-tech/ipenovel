import { describe, expect, it } from "vitest";
import {
  clearLegacyUnknownRow,
  describeLegacyCollision,
  findKnownLegacyCollision,
  recordLegacyCollisionMember,
  recordLegacyUnknownRow,
} from "./slipLegacyCollisionService";

/**
 * Durable legacy evidence registry: KNOWN COLLISIONS and PERMANENTLY UNKNOWN
 * rows. See the module doc for the incident this fixes (IPE-004): a
 * production dry-run found 915 historical rows whose file identity can never
 * be recovered and 114 genuine strong-identifier collisions among historical
 * rows. Both facts are now recorded durably, ONCE, by the backfill - never
 * re-derived by a live O(N) scan on every approval.
 */

class FakeDupError extends Error {
  code = "ER_DUP_ENTRY";
  errno = 1062;
}

interface CollisionRow {
  id: number;
  kind: string;
  identifierHash: string;
  sourceType: string;
  sourceId: number;
}

interface UnknownRow {
  id: number;
  sourceType: string;
  sourceId: number;
  reason: string;
}

/** Minimal drizzle-shaped fake covering only what this service touches. */
function makeFakeTx() {
  const collisions: CollisionRow[] = [];
  const unknowns: UnknownRow[] = [];
  let nextId = 1;

  const tx = {
    insert(table: any) {
      const name = String(table?.[Symbol.for("drizzle:Name")] ?? "");
      return {
        async values(v: any) {
          if (name === "paymentSlipLegacyCollisions") {
            const dup = collisions.some(
              (c) =>
                c.kind === v.kind &&
                c.identifierHash === v.identifierHash &&
                c.sourceType === v.sourceType &&
                c.sourceId === v.sourceId
            );
            if (dup) throw new FakeDupError("Duplicate entry for key 'member_unique'");
            collisions.push({ id: nextId++, ...v });
            return [{ insertId: nextId }];
          }
          if (name === "paymentSlipLegacyUnknown") {
            const dup = unknowns.some(
              (u) => u.sourceType === v.sourceType && u.sourceId === v.sourceId
            );
            if (dup) throw new FakeDupError("Duplicate entry for key 'source_unique'");
            unknowns.push({ id: nextId++, ...v });
            return [{ insertId: nextId }];
          }
          throw new Error(`unexpected insert into ${name}`);
        },
      };
    },
    select() {
      return {
        from(table: any) {
          const name = String(table?.[Symbol.for("drizzle:Name")] ?? "");
          return {
            where(cond: any) {
              const pairs = extractColumnValuePairs(cond);
              const get = (col: string) => pairs.find(([c]) => c === col)?.[1];
              return {
                limit: async (n: number) => {
                  if (name === "paymentSlipLegacyCollisions") {
                    const kind = get("kind");
                    const identifierHash = get("identifierHash");
                    return collisions
                      .filter((c) => c.kind === kind && c.identifierHash === identifierHash)
                      .slice(0, n);
                  }
                  if (name === "paymentSlipLegacyUnknown") {
                    const sourceType = get("sourceType");
                    const sourceId = get("sourceId");
                    return unknowns
                      .filter((u) => u.sourceType === sourceType && u.sourceId === sourceId)
                      .slice(0, n);
                  }
                  return [];
                },
              };
            },
          };
        },
      };
    },
    delete(table: any) {
      const name = String(table?.[Symbol.for("drizzle:Name")] ?? "");
      return {
        where: async (cond: any) => {
          const pairs = extractColumnValuePairs(cond);
          const get = (col: string) => pairs.find(([c]) => c === col)?.[1];
          if (name === "paymentSlipLegacyUnknown") {
            const sourceType = get("sourceType");
            const sourceId = get("sourceId");
            for (let i = unknowns.length - 1; i >= 0; i--) {
              if (unknowns[i].sourceType === sourceType && unknowns[i].sourceId === sourceId) {
                unknowns.splice(i, 1);
              }
            }
          }
        },
      };
    },
    _collisions: collisions,
    _unknowns: unknowns,
  };
  return tx;
}

/**
 * Extracts [columnName, value] pairs from a drizzle `eq(col, value)` /
 * `and(...)` condition tree. Naive string-walking is NOT safe here: a
 * mysqlEnum column embeds its full set of enum values ("reference", "file",
 * "qr") in its own metadata, so a flat string search for "reference" matches
 * regardless of which value the condition actually compares against. Instead
 * this pairs each SQL sub-node's Column chunk (has `.name` + `.columnType`)
 * with its sibling Param chunk (has `.value`, not an array - a StringChunk's
 * `.value` is always an array of literal SQL text).
 */
function extractColumnValuePairs(node: any, pairs: Array<[string, unknown]> = [], depth = 0) {
  if (!node || depth > 15 || typeof node !== "object") return pairs;
  if (Array.isArray(node.queryChunks)) {
    let col: string | undefined;
    let param: unknown;
    let hasParam = false;
    for (const chunk of node.queryChunks) {
      if (!chunk || typeof chunk !== "object") continue;
      if (typeof chunk.name === "string" && typeof chunk.columnType === "string") {
        col = chunk.name;
      } else if ("value" in chunk && !("columnType" in chunk) && !Array.isArray(chunk.value)) {
        param = chunk.value;
        hasParam = true;
      }
    }
    if (col && hasParam) pairs.push([col, param]);
    for (const chunk of node.queryChunks) extractColumnValuePairs(chunk, pairs, depth + 1);
    return pairs;
  }
  return pairs;
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("findKnownLegacyCollision", () => {
  it("finds nothing when the collision table is empty", async () => {
    const tx = makeFakeTx();
    const match = await findKnownLegacyCollision({ referenceHash: HASH_A }, tx);
    expect(match).toBeUndefined();
  });

  it("finds a durably recorded reference collision by indexed lookup", async () => {
    const tx = makeFakeTx();
    await recordLegacyCollisionMember(
      { kind: "reference", identifierHash: HASH_A, sourceType: "order_payment", sourceId: 7 },
      tx
    );

    const match = await findKnownLegacyCollision({ referenceHash: HASH_A }, tx);
    expect(match).toEqual({
      kind: "reference",
      identifierHash: HASH_A,
      matchedSourceType: "order_payment",
      matchedSourceId: 7,
    });
  });

  it("finds a durably recorded file collision", async () => {
    const tx = makeFakeTx();
    await recordLegacyCollisionMember(
      { kind: "file", identifierHash: HASH_B, sourceType: "wallet_topup", sourceId: 3 },
      tx
    );
    const match = await findKnownLegacyCollision({ fileHash: HASH_B }, tx);
    expect(match?.kind).toBe("file");
    expect(match?.matchedSourceType).toBe("wallet_topup");
  });

  it("a reference collision on one hash never matches an unrelated fileHash", async () => {
    const tx = makeFakeTx();
    await recordLegacyCollisionMember(
      { kind: "reference", identifierHash: HASH_A, sourceType: "order_payment", sourceId: 7 },
      tx
    );
    const match = await findKnownLegacyCollision({ fileHash: HASH_A }, tx);
    expect(match).toBeUndefined();
  });

  it("an incoming submission with no strong identifiers at all finds nothing (no lookup possible)", async () => {
    const tx = makeFakeTx();
    const match = await findKnownLegacyCollision({}, tx);
    expect(match).toBeUndefined();
  });
});

describe("recordLegacyCollisionMember - idempotent, no winner picked", () => {
  it("records both sides of a clash under the same hash - no single owner", async () => {
    const tx = makeFakeTx();
    await recordLegacyCollisionMember(
      { kind: "reference", identifierHash: HASH_A, sourceType: "order_payment", sourceId: 1 },
      tx
    );
    await recordLegacyCollisionMember(
      { kind: "reference", identifierHash: HASH_A, sourceType: "wallet_topup", sourceId: 2 },
      tx
    );
    expect((tx as any)._collisions).toHaveLength(2);
  });

  it("re-recording the SAME member twice is a no-op, not a duplicate row", async () => {
    const tx = makeFakeTx();
    const first = await recordLegacyCollisionMember(
      { kind: "file", identifierHash: HASH_A, sourceType: "order_payment", sourceId: 1 },
      tx
    );
    const second = await recordLegacyCollisionMember(
      { kind: "file", identifierHash: HASH_A, sourceType: "order_payment", sourceId: 1 },
      tx
    );
    expect(first).toEqual({ recorded: true, alreadyPresent: false });
    expect(second).toEqual({ recorded: true, alreadyPresent: true });
    expect((tx as any)._collisions).toHaveLength(1);
  });

  it("running the whole backfill twice produces the same durable state (idempotency)", async () => {
    const tx = makeFakeTx();
    const member = {
      kind: "reference" as const,
      identifierHash: HASH_A,
      sourceType: "order_payment" as const,
      sourceId: 5,
    };
    await recordLegacyCollisionMember(member, tx);
    await recordLegacyCollisionMember(member, tx);
    await recordLegacyCollisionMember(member, tx);
    expect((tx as any)._collisions).toHaveLength(1);
  });
});

describe("recordLegacyUnknownRow / clearLegacyUnknownRow", () => {
  it("records a permanently-unresolvable row exactly once, idempotently", async () => {
    const tx = makeFakeTx();
    const row = { sourceType: "order_payment" as const, sourceId: 42, reason: "no_slip_image_url" };
    const first = await recordLegacyUnknownRow(row, tx);
    const second = await recordLegacyUnknownRow(row, tx);
    expect(first.recorded).toBe(true);
    expect(second).toEqual({ recorded: true, alreadyPresent: true });
    expect((tx as any)._unknowns).toHaveLength(1);
  });

  it("clearing removes the record so a later-resolved row is not stuck showing unknown", async () => {
    const tx = makeFakeTx();
    await recordLegacyUnknownRow(
      { sourceType: "wallet_topup", sourceId: 9, reason: "file_hash_recovery_failed" },
      tx
    );
    expect((tx as any)._unknowns).toHaveLength(1);
    await clearLegacyUnknownRow({ sourceType: "wallet_topup", sourceId: 9 }, tx);
    expect((tx as any)._unknowns).toHaveLength(0);
  });

  it("clearing a row that was never recorded is a harmless no-op", async () => {
    const tx = makeFakeTx();
    await expect(
      clearLegacyUnknownRow({ sourceType: "order_payment", sourceId: 1 }, tx)
    ).resolves.toBeUndefined();
  });
});

describe("describeLegacyCollision", () => {
  it("never claims proof, and never leaks the hash", () => {
    const msg = describeLegacyCollision({
      kind: "reference",
      identifierHash: HASH_A,
      matchedSourceType: "order_payment",
      matchedSourceId: 12,
    });
    expect(msg).toMatch(/order payment #12/);
    expect(msg).toMatch(/NOT proof/i);
    expect(msg).not.toMatch(new RegExp(HASH_A));
  });

  it("names the file axis distinctly from the reference axis", () => {
    const msg = describeLegacyCollision({
      kind: "file",
      identifierHash: HASH_B,
      matchedSourceType: "wallet_topup",
      matchedSourceId: 3,
    });
    expect(msg).toMatch(/exact slip image/i);
    expect(msg).toMatch(/wallet top-up #3/);
  });
});
