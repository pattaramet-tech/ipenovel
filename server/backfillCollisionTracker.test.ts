import { describe, expect, it } from "vitest";
import { createCollisionTracker } from "../scripts/lib/backfillCollisionTracker.mjs";

/**
 * P2: the dry-run audit missed file collisions.
 *
 * Keying rows on `referenceHash ?? fileHash` gave two rows with DIFFERENT
 * references but the SAME fileHash different keys, so dry-run called both
 * claimable and the live UNIQUE index was left to discover the conflict -
 * defeating the documented dry-run-first audit.
 */

const REF_A = "a".repeat(64);
const REF_B = "b".repeat(64);
const FILE_X = "x".repeat(64);
const FILE_Y = "y".repeat(64);
const QR_1 = "1".repeat(64);

const src = (id: number) => ({ sourceType: "order_payment" as const, sourceId: id });

describe("dry-run collision matrix", () => {
  it("A: same reference, different files -> REFERENCE collision", () => {
    const t = createCollisionTracker();
    t.remember({ referenceHash: REF_A, fileHash: FILE_X }, src(1));
    const kinds = t.check({ referenceHash: REF_A, fileHash: FILE_Y }, src(2));

    expect(kinds).toEqual(["reference"]);
    expect(t.collisions).toHaveLength(1);
    expect(t.collisions[0].kind).toBe("reference");
    expect(t.collisions[0].first).toBe("order_payment#1");
    expect(t.collisions[0].second).toBe("order_payment#2");
  });

  it("B: different references, same file -> FILE collision (the missed case)", () => {
    const t = createCollisionTracker();
    t.remember({ referenceHash: REF_A, fileHash: FILE_X }, src(1));
    const kinds = t.check({ referenceHash: REF_B, fileHash: FILE_X }, src(2));

    // Under the old `referenceHash ?? fileHash` key this returned nothing.
    expect(kinds).toEqual(["file"]);
    expect(t.collisions[0].kind).toBe("file");
  });

  it("C: same reference AND same file -> BOTH kinds recorded", () => {
    const t = createCollisionTracker();
    t.remember({ referenceHash: REF_A, fileHash: FILE_X }, src(1));
    const kinds = t.check({ referenceHash: REF_A, fileHash: FILE_X }, src(2));

    expect(kinds).toEqual(["reference", "file"]);
    expect(t.collisions.map((c: any) => c.kind)).toEqual(["reference", "file"]);
  });

  it("D: different reference AND different file -> no collision", () => {
    const t = createCollisionTracker();
    t.remember({ referenceHash: REF_A, fileHash: FILE_X }, src(1));
    const kinds = t.check({ referenceHash: REF_B, fileHash: FILE_Y }, src(2));

    expect(kinds).toEqual([]);
    expect(t.collisions).toHaveLength(0);
  });

  it("E: fileHash-ONLY records still collide", () => {
    const t = createCollisionTracker();
    t.remember({ fileHash: FILE_X }, src(1));
    expect(t.check({ fileHash: FILE_X }, src(2))).toEqual(["file"]);
  });

  it("F: referenceHash-ONLY records still collide", () => {
    const t = createCollisionTracker();
    t.remember({ referenceHash: REF_A }, src(1));
    expect(t.check({ referenceHash: REF_A }, src(2))).toEqual(["reference"]);
  });

  it("QR payload hashes collide independently", () => {
    const t = createCollisionTracker();
    t.remember({ qrPayloadHash: QR_1 }, src(1));
    expect(t.check({ qrPayloadHash: QR_1 }, src(2))).toEqual(["qr"]);
  });

  it("a reference and a file with the SAME hex value do not cross-contaminate", () => {
    const t = createCollisionTracker();
    t.remember({ referenceHash: REF_A }, src(1));
    // Same string, different namespace - must not be treated as a collision.
    expect(t.check({ fileHash: REF_A }, src(2))).toEqual([]);
  });

  it("collisions across SOURCES are reported", () => {
    const t = createCollisionTracker();
    t.remember({ referenceHash: REF_A }, { sourceType: "order_payment", sourceId: 1 });
    t.check({ referenceHash: REF_A }, { sourceType: "wallet_topup", sourceId: 9 });

    expect(t.collisions[0].first).toBe("order_payment#1");
    expect(t.collisions[0].second).toBe("wallet_topup#9");
  });
});

describe("collision reporting hygiene", () => {
  it("only a hash PREFIX is reported, never the full identifier", () => {
    const t = createCollisionTracker();
    t.remember({ referenceHash: REF_A }, src(1));
    t.check({ referenceHash: REF_A }, src(2));

    expect(t.collisions[0].identifier).toBe(`${REF_A.slice(0, 12)}...`);
    expect(t.collisions[0].identifier).not.toBe(REF_A);
    expect(t.collisions[0].identifier.length).toBeLessThan(20);
  });

  it("a colliding row is NOT indexed, so the original owner stays authoritative", () => {
    const t = createCollisionTracker();
    t.remember({ referenceHash: REF_A }, src(1));
    t.check({ referenceHash: REF_A }, src(2)); // collides, not remembered

    // A third row colliding on the same reference still points at row 1.
    t.check({ referenceHash: REF_A }, src(3));
    expect(t.collisions[1].first).toBe("order_payment#1");
  });

  it("ignores absent identifiers without throwing", () => {
    const t = createCollisionTracker();
    expect(() => t.check({}, src(1))).not.toThrow();
    expect(() => t.check(undefined as any, src(1))).not.toThrow();
    expect(t.check({}, src(1))).toEqual([]);
  });

  it("remembering is idempotent - re-remembering keeps the FIRST owner", () => {
    const t = createCollisionTracker();
    t.remember({ referenceHash: REF_A }, src(1));
    t.remember({ referenceHash: REF_A }, src(2));
    t.check({ referenceHash: REF_A }, src(3));
    expect(t.collisions[0].first).toBe("order_payment#1");
  });

  it("indexes each kind separately", () => {
    const t = createCollisionTracker();
    t.remember({ referenceHash: REF_A, fileHash: FILE_X, qrPayloadHash: QR_1 }, src(1));
    expect(t.size("reference")).toBe(1);
    expect(t.size("file")).toBe(1);
    expect(t.size("qr")).toBe(1);
  });
});
