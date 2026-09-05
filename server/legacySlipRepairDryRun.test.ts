import { describe, it, expect, vi } from "vitest";
import { dryRunLegacySlipRepair } from "../scripts/lib/legacySlipRepairDryRun";
import { createRepairFixture } from "./fixtures/legacySlipRepairFixtures";
import type { RelinkReaders } from "../scripts/lib/legacySlipRelinkPlan";

function setup() {
  const fixture = createRepairFixture();
  const c = fixture.intent.candidate;
  const readers: RelinkReaders = {
    readSource: vi.fn(async () =>
      JSON.parse(JSON.stringify(fixture.intent.before))
    ),
    listCandidate: vi.fn(async () => ({
      listing: {
        candidateCount: 1,
        unexpectedObjectCount: 0,
        truncated: false,
      },
      candidate: { key: c.key, etag: c.etag, size: c.size },
    })),
    readCandidate: vi.fn(async () => ({
      rawHash: c.rawHash,
      canonicalHash: c.canonicalHash,
      byteLength: c.size,
      mimeType: c.mimeType,
    })),
    readCrossReferences: vi.fn(async () => ({
      claims: [],
      bindings: [],
      collisions: [],
      uploads: [],
      references: [],
      truncated: false,
    })),
  };
  const options = { targetFingerprint: fixture.intent.targetFingerprint };
  return {
    ...fixture,
    readers,
    options,
    run: () =>
      dryRunLegacySlipRepair(
        fixture.intent,
        fixture.attestation,
        readers,
        options
      ),
  };
}

describe("single legacy reference repair dry-run", () => {
  it("revalidates ordinary DB objects against parsed plan, no live authorization", async () => {
    const s = setup();
    const result = await s.run();
    expect(result).toMatchObject({
      status: "DRY_RUN_MATCH",
      sourceId: 11280001,
      databaseWrites: 0,
      objectWrites: 0,
      writeAuthorized: false,
      liveApplyAvailable: false,
      independentReview: "PENDING",
      historicalCoverageComplete: false,
    });
    expect(s.readers.readSource).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(s.readers.readSource).mock.calls)
      expect(call).toEqual([
        { sourceType: "order_payment", sourceId: 11280001 },
      ]);
    expect(s.readers.readCandidate).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(s.readers.readCrossReferences).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(s.readers.readSource).mock.invocationCallOrder[1]);
    const serialized = JSON.stringify(result);
    for (const privateValue of [
      s.intent.candidate.key,
      s.intent.candidate.rawHash,
      s.intent.before.source.slipImageUrl!,
      s.attestation.reviewer,
    ])
      expect(serialized).not.toContain(privateValue);
  });
  it("rejects changed target before any reads", async () => {
    const s = setup();
    s.options.targetFingerprint = "f".repeat(64);
    expect((await s.run()).code).toBe("TARGET_FINGERPRINT_MISMATCH");
    expect(s.readers.readSource).not.toHaveBeenCalled();
  });
  it.each(["record", "order", "source", "related"])(
    "blocks full snapshot drift in %s",
    async section => {
      const s = setup();
      const changed: any = JSON.parse(JSON.stringify(s.intent.before));
      if (section === "related") changed.related.unknowns.push({ id: 99 });
      else if (section === "record")
        changed.record.updatedAt = "2026-09-06 00:00:00";
      else if (section === "order") changed.order.notes = "drift";
      else changed.source.ownerUserId = 999;
      vi.mocked(s.readers.readSource).mockResolvedValue(changed);
      expect((await s.run()).code).toBe("SOURCE_DRIFT");
      expect(s.readers.listCandidate).not.toHaveBeenCalled();
    }
  );
  it("blocks changes after global lookups", async () => {
    const s = setup();
    vi.mocked(s.readers.readSource)
      .mockResolvedValueOnce(s.intent.before)
      .mockResolvedValueOnce(null);
    expect((await s.run()).code).toBe("SOURCE_DRIFT");
  });
  it.each(["key", "etag", "size", "count", "truncated", "unexpected"])(
    "blocks candidate %s drift without GET",
    async field => {
      const s = setup();
      const listed: any = await s.readers.listCandidate({
        sourceType: "order_payment",
        sourceId: 11280001,
      });
      vi.mocked(s.readers.listCandidate).mockClear();
      if (field === "count") listed.listing.candidateCount = 2;
      else if (field === "truncated") listed.listing.truncated = true;
      else if (field === "unexpected") listed.listing.unexpectedObjectCount = 1;
      else listed.candidate[field] = field === "size" ? 999 : "changed";
      vi.mocked(s.readers.listCandidate).mockResolvedValue(listed);
      expect((await s.run()).code).toBe("OBJECT_DRIFT");
      expect(s.readers.readCandidate).not.toHaveBeenCalled();
    }
  );
  it.each(["rawHash", "canonicalHash", "byteLength", "mimeType"])(
    "blocks byte %s drift",
    async field => {
      const s = setup();
      const bytes: any = {
        ...(await s.readers.readCandidate(s.intent.candidate)),
      };
      bytes[field] = field === "byteLength" ? 999 : "changed";
      vi.mocked(s.readers.readCandidate).mockResolvedValue(bytes);
      expect((await s.run()).code).toBe("OBJECT_DRIFT");
      expect(s.readers.readCrossReferences).not.toHaveBeenCalled();
    }
  );
  it.each(["claims", "bindings", "collisions", "uploads", "references"])(
    "blocks global %s match",
    async field => {
      const s = setup();
      const cross: any = {
        claims: [],
        bindings: [],
        collisions: [],
        uploads: [],
        references: [],
        truncated: false,
      };
      cross[field] = [{ id: 123 }];
      vi.mocked(s.readers.readCrossReferences).mockResolvedValue(cross);
      expect((await s.run()).code).toBe("CROSS_REFERENCE_CONFLICT");
      expect(s.readers.readSource).toHaveBeenCalledTimes(2);
    }
  );
  it("blocks truncated query", async () => {
    const s = setup();
    vi.mocked(s.readers.readCrossReferences).mockResolvedValue({
      claims: [],
      bindings: [],
      collisions: [],
      uploads: [],
      references: [],
      truncated: true,
    });
    expect((await s.run()).code).toBe("READ_INCOMPLETE");
  });
  it.each([
    "readSource",
    "listCandidate",
    "readCandidate",
    "readCrossReferences",
  ] as const)("sanitizes %s failure", async method => {
    const s = setup();
    vi.mocked(s.readers[method]).mockRejectedValue(
      new Error("SECRET_URL_CREDENTIAL_OCR")
    );
    const result = await s.run();
    expect(result.code).toBe("READ_FAILED");
    expect(JSON.stringify(result)).not.toContain("SECRET_URL_CREDENTIAL_OCR");
  });
  it("cooperative deadline blocks before slow work can continue", async () => {
    const s = setup();
    let calls = 0;
    const result = await dryRunLegacySlipRepair(
      s.intent,
      s.attestation,
      s.readers,
      { ...s.options, now: () => (++calls <= 2 ? 0 : 60_001) }
    );
    expect(result.code).toBe("DEADLINE_EXCEEDED");
    expect(s.readers.listCandidate).not.toHaveBeenCalled();
  });
  it("rejects tampered operator attestation before network", async () => {
    const s = setup();
    await expect(
      dryRunLegacySlipRepair(
        s.intent,
        { ...s.attestation, sourceId: 11310001 } as any,
        s.readers,
        s.options
      )
    ).rejects.toBeDefined();
    expect(s.readers.readSource).not.toHaveBeenCalled();
  });
});
