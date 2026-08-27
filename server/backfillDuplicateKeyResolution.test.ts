/**
 * IPE-004-C03 P2: "Duplicate-key handling identifies and records only
 * actually colliding identifier axes; it does not conservatively poison
 * unrelated reference/file/QR hashes."
 *
 * A driver duplicate-key error (ER_DUP_ENTRY) does not say WHICH unique
 * constraint collided. `resolveDuplicateKeyCollisions` re-reads
 * `paymentSlipClaims` by each present identifier hash and records a
 * collision ONLY for the axis(es) actually owned by another source.
 */
import { describe, expect, it } from "vitest";
import { resolveDuplicateKeyCollisions } from "../scripts/lib/backfillDuplicateKeyResolution.mjs";

const STRONG_FIELDS = [
  ["reference", "referenceHash"],
  ["file", "fileHash"],
  ["qr", "qrPayloadHash"],
];

const REF = "r".repeat(64);
const FILE = "f".repeat(64);
const QR = "q".repeat(64);

function lookupFrom(ownersByField: Record<string, Array<{ sourceType: string; sourceId: number }>>) {
  return async (field: string, _hash: string) => ownersByField[field] ?? [];
}

describe("resolveDuplicateKeyCollisions", () => {
  it("multiple present identifiers, only ONE axis actually owned by a foreign source -> only that axis becomes a collision", async () => {
    const ids = { referenceHash: REF, fileHash: FILE, qrPayloadHash: QR };
    const result = await resolveDuplicateKeyCollisions({
      ids,
      sourceType: "order_payment",
      rowId: 42,
      stage: "insert",
      strongFields: STRONG_FIELDS,
      // Only the FILE hash is actually owned by someone else. The reference
      // and QR hashes are owned by nobody at all (empty owners) - they must
      // never be poisoned just because the driver rejected the whole insert.
      lookupOwners: lookupFrom({
        referenceHash: [],
        fileHash: [{ sourceType: "wallet_topup", sourceId: 7 }],
        qrPayloadHash: [],
      }),
    });

    expect(result.confirmed).toBe(1);
    expect(result.selfOwnsEvery).toBe(false);
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0].kind).toBe("file");
    expect(result.collisions[0].hash).toBe(FILE);
    expect(result.collisions[0].firstSource).toEqual({ sourceType: "wallet_topup", sourceId: 7 });
    expect(result.collisions[0].secondSource).toEqual({ sourceType: "order_payment", sourceId: 42 });
  });

  it("this row already owns every present identifier -> selfOwnsEvery true, zero collisions (idempotent re-run, not a clash)", async () => {
    const ids = { referenceHash: REF, fileHash: FILE };
    const result = await resolveDuplicateKeyCollisions({
      ids,
      sourceType: "order_payment",
      rowId: 42,
      stage: "insert",
      strongFields: STRONG_FIELDS,
      lookupOwners: lookupFrom({
        referenceHash: [{ sourceType: "order_payment", sourceId: 42 }],
        fileHash: [{ sourceType: "order_payment", sourceId: 42 }],
      }),
    });

    expect(result.selfOwnsEvery).toBe(true);
    expect(result.confirmed).toBe(0);
    expect(result.collisions).toHaveLength(0);
  });

  it("neither this row nor a foreign owner is visible on re-read (transient race) -> zero confirmed, caller must not invent a collision", async () => {
    const ids = { referenceHash: REF };
    const result = await resolveDuplicateKeyCollisions({
      ids,
      sourceType: "order_payment",
      rowId: 42,
      stage: "insert",
      strongFields: STRONG_FIELDS,
      lookupOwners: lookupFrom({ referenceHash: [] }),
    });

    expect(result.confirmed).toBe(0);
    expect(result.selfOwnsEvery).toBe(false);
    expect(result.collisions).toHaveLength(0);
  });

  it("both reference AND file genuinely collide with foreign owners -> both axes recorded, each as its own two-member finding", async () => {
    const ids = { referenceHash: REF, fileHash: FILE };
    const result = await resolveDuplicateKeyCollisions({
      ids,
      sourceType: "order_payment",
      rowId: 42,
      stage: "insert",
      strongFields: STRONG_FIELDS,
      lookupOwners: lookupFrom({
        referenceHash: [{ sourceType: "wallet_topup", sourceId: 1 }],
        fileHash: [{ sourceType: "wallet_topup", sourceId: 2 }],
      }),
    });

    expect(result.confirmed).toBe(2);
    expect(result.collisions.map((c) => c.kind).sort()).toEqual(["file", "reference"]);
  });

  it("a foreign owner appears alongside this row's own membership on the same axis -> still records only the foreign owner as the collision", async () => {
    // Multiple rows can be returned by the LIMIT 5 lookup; this row's own
    // membership must never itself be reported as "the colliding owner".
    const ids = { referenceHash: REF };
    const result = await resolveDuplicateKeyCollisions({
      ids,
      sourceType: "order_payment",
      rowId: 42,
      stage: "insert",
      strongFields: STRONG_FIELDS,
      lookupOwners: lookupFrom({
        referenceHash: [
          { sourceType: "order_payment", sourceId: 42 },
          { sourceType: "wallet_topup", sourceId: 9 },
        ],
      }),
    });

    expect(result.confirmed).toBe(1);
    expect(result.selfOwnsEvery).toBe(true);
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0].firstSource).toEqual({ sourceType: "wallet_topup", sourceId: 9 });
  });

  it("no present identifiers at all -> nothing to look up, nothing recorded", async () => {
    const result = await resolveDuplicateKeyCollisions({
      ids: {},
      sourceType: "order_payment",
      rowId: 42,
      stage: "insert",
      strongFields: STRONG_FIELDS,
      lookupOwners: lookupFrom({}),
    });

    expect(result.confirmed).toBe(0);
    expect(result.selfOwnsEvery).toBe(true);
    expect(result.collisions).toHaveLength(0);
  });
});
