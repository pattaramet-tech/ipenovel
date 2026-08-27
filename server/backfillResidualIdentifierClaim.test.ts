/**
 * IPE-004-C04 P1: "Partial duplicate insert" - claimResidualIdentifiers
 * ensures every present, non-colliding strong identifier ends the run
 * safely claimed, even when a SIBLING axis on the same failed multi-column
 * INSERT genuinely collided.
 */
import { describe, expect, it, vi } from "vitest";
import { claimResidualIdentifiers } from "../scripts/lib/backfillResidualIdentifierClaim.mjs";

const STRONG_FIELDS = [
  ["reference", "referenceHash"],
  ["file", "fileHash"],
  ["qr", "qrPayloadHash"],
];

const REF = "r".repeat(64);
const FILE = "f".repeat(64);
const QR = "q".repeat(64);

function dupError() {
  const e: any = new Error("Duplicate entry");
  e.code = "ER_DUP_ENTRY";
  return e;
}

describe("claimResidualIdentifiers", () => {
  it("only reference collided -> file and QR are claimed together in one residual insert", async () => {
    const ids = { referenceHash: REF, fileHash: FILE, qrPayloadHash: QR };
    const insertClaim = vi.fn().mockResolvedValue(undefined);
    const resolveCollisions = vi.fn();

    const result = await claimResidualIdentifiers({
      ids,
      confirmedKinds: new Set(["reference"]),
      strongFields: STRONG_FIELDS,
      insertClaim,
      resolveCollisions,
    });

    expect(result.claimedKinds.sort()).toEqual(["file", "qr"]);
    expect(result.uncoveredKinds).toEqual([]);
    expect(result.failed).toBe(false);
    expect(insertClaim).toHaveBeenCalledTimes(1);
    expect(insertClaim).toHaveBeenCalledWith({ fileHash: FILE, qrPayloadHash: QR });
    expect(resolveCollisions).not.toHaveBeenCalled();
  });

  it("only file collided -> reference and QR are claimed", async () => {
    const ids = { referenceHash: REF, fileHash: FILE, qrPayloadHash: QR };
    const result = await claimResidualIdentifiers({
      ids,
      confirmedKinds: new Set(["file"]),
      strongFields: STRONG_FIELDS,
      insertClaim: vi.fn().mockResolvedValue(undefined),
      resolveCollisions: vi.fn(),
    });

    expect(result.claimedKinds.sort()).toEqual(["qr", "reference"]);
    expect(result.failed).toBe(false);
  });

  it("only QR collided -> reference and file are claimed", async () => {
    const ids = { referenceHash: REF, fileHash: FILE, qrPayloadHash: QR };
    const result = await claimResidualIdentifiers({
      ids,
      confirmedKinds: new Set(["qr"]),
      strongFields: STRONG_FIELDS,
      insertClaim: vi.fn().mockResolvedValue(undefined),
      resolveCollisions: vi.fn(),
    });

    expect(result.claimedKinds.sort()).toEqual(["file", "reference"]);
    expect(result.failed).toBe(false);
  });

  it("every present axis already confirmed a collision -> nothing to claim, no insert attempted", async () => {
    const ids = { referenceHash: REF, fileHash: FILE };
    const insertClaim = vi.fn();
    const result = await claimResidualIdentifiers({
      ids,
      confirmedKinds: new Set(["reference", "file"]),
      strongFields: STRONG_FIELDS,
      insertClaim,
      resolveCollisions: vi.fn(),
    });

    expect(result.claimedKinds).toEqual([]);
    expect(result.uncoveredKinds).toEqual([]);
    expect(result.failed).toBe(false);
    expect(insertClaim).not.toHaveBeenCalled();
  });

  it("residual insert itself hits a genuine TOCTOU collision on retry read -> that axis is subtracted, the rest claimed on attempt 2", async () => {
    const ids = { referenceHash: REF, fileHash: FILE, qrPayloadHash: QR };
    const insertClaim = vi
      .fn()
      .mockRejectedValueOnce(dupError())
      .mockResolvedValueOnce(undefined);
    // The residual retry finds file ALSO collides (a race just discovered).
    const resolveCollisions = vi.fn().mockResolvedValue({
      confirmed: 1,
      selfOwnsEvery: false,
      collisions: [{ kind: "file" }],
    });

    const result = await claimResidualIdentifiers({
      ids,
      confirmedKinds: new Set(["reference"]),
      strongFields: STRONG_FIELDS,
      insertClaim,
      resolveCollisions,
    });

    expect(insertClaim).toHaveBeenCalledTimes(2);
    // Attempt 1 tried {file, qr}; attempt 2 (after file is subtracted) tries {qr} only.
    expect(insertClaim).toHaveBeenNthCalledWith(2, { qrPayloadHash: QR });
    expect(result.claimedKinds).toEqual(["qr"]);
    expect(result.failed).toBe(false);
  });

  it("residual insert fails twice with no identifiable owner either time -> uncovered, failed, never invents coverage", async () => {
    const ids = { referenceHash: REF, fileHash: FILE };
    const insertClaim = vi.fn().mockRejectedValue(dupError());
    const resolveCollisions = vi.fn().mockResolvedValue({
      confirmed: 0,
      selfOwnsEvery: false,
      collisions: [],
    });

    const result = await claimResidualIdentifiers({
      ids,
      confirmedKinds: new Set(["reference"]),
      strongFields: STRONG_FIELDS,
      insertClaim,
      resolveCollisions,
    });

    expect(insertClaim).toHaveBeenCalledTimes(2);
    expect(result.claimedKinds).toEqual([]);
    expect(result.uncoveredKinds).toEqual(["file"]);
    expect(result.failed).toBe(true);
  });

  it("a non-duplicate-key error aborts immediately, uncovered and failed - never retried", async () => {
    const ids = { referenceHash: REF, fileHash: FILE };
    const insertClaim = vi.fn().mockRejectedValue(new Error("connection reset"));
    const resolveCollisions = vi.fn();

    const result = await claimResidualIdentifiers({
      ids,
      confirmedKinds: new Set(["reference"]),
      strongFields: STRONG_FIELDS,
      insertClaim,
      resolveCollisions,
    });

    expect(insertClaim).toHaveBeenCalledTimes(1);
    expect(resolveCollisions).not.toHaveBeenCalled();
    expect(result.uncoveredKinds).toEqual(["file"]);
    expect(result.failed).toBe(true);
  });
});
