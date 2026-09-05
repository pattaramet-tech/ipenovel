import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  prepareLegacySlipRelinkPlan,
  summarizeRelinkPlan,
  relinkTargetFingerprint,
  type RelinkReaders,
  type RelinkPlanMetadata,
} from "../scripts/lib/legacySlipRelinkPlan";
import {
  AuditReadError,
  type AuditTarget,
} from "../scripts/lib/legacySlipAuditRuntime";
import {
  type RelinkSourceSnapshot,
  type RelinkCrossReferences,
} from "../scripts/lib/legacySlipRelinkRead";
import {
  PREVIEW_AUDIT_TARGETS,
  validateLegacySlipAuditEnvironment,
} from "../scripts/lib/legacySlipAuditOptions";

const SECRET = "PRIVATE_SLIP_DO_NOT_PRINT";
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const metadata: RelinkPlanMetadata = {
  runId: "12345678-1234-4234-a234-123456789012",
  preparedAt: "2026-09-05T12:00:00.000Z",
  declaredCodeSha: "a".repeat(40),
  toolSourceDigest: "b".repeat(64),
  targetFingerprint: "c".repeat(64),
};

function source(target: AuditTarget): RelinkSourceSnapshot {
  return {
    source: {
      ...target,
      ownerUserId: 55,
      status: "approved",
      slipImageUrl: `https://d2xsxph8kpxj0f.cloudfront.net/${SECRET}/${target.sourceId}`,
      slipEvidenceClass: "legacy_compatibility_required",
      evidenceVersion: 0,
      slipEvidenceId: null,
      extractedEvidenceVersion: null,
      extractedData: null,
      bindings: [],
      claims: [],
      relatedReadTruncated: false,
    },
    record: {
      id: target.sourceId,
      approvedByLabel: SECRET,
      amount: "12.34",
      updatedAt: "2026-09-01 01:02:03",
    },
    order:
      target.sourceType === "order_payment"
        ? { id: 123, userId: 55, notes: SECRET }
        : null,
    related: { claims: [], bindings: [], unknowns: [], collisions: [] },
    truncated: false,
  };
}
const cross = (): RelinkCrossReferences => ({
  claims: [],
  collisions: [],
  bindings: [],
  uploads: [],
  references: [],
  truncated: false,
});
function readers(): RelinkReaders {
  return {
    readSource: vi.fn(async target => source(target)),
    listCandidate: vi.fn(async target => ({
      listing: {
        candidateCount: 1,
        unexpectedObjectCount: 0,
        truncated: false,
      },
      candidate: {
        key: `payment-slips/legacy/${target.sourceType === "order_payment" ? "payments" : "wallet-topups"}/${target.sourceId}/123-abc.jpg`,
        etag: '"privateetag"',
        size: 32,
      },
    })),
    readCandidate: vi.fn(async candidate => ({
      rawHash: digest(`raw${candidate.key}`),
      canonicalHash: digest(candidate.key),
      byteLength: 32,
      mimeType: "image/jpeg" as const,
    })),
    readCrossReferences: vi.fn(async () => cross()),
  };
}

describe("prepare-only legacy relink review plan", () => {
  it("collects exactly the ten authorized version-0 mappings, never grants approval", async () => {
    const io = readers();
    const plan = await prepareLegacySlipRelinkPlan(io, metadata);
    expect(plan.rows.map(r => [r.sourceType, r.sourceId])).toEqual([
      ["order_payment", 11280001],
      ["order_payment", 11310001],
      ["order_payment", 11340002],
      ["order_payment", 11340004],
      ["order_payment", 11370001],
      ["wallet_topup", 180001],
      ["wallet_topup", 210001],
      ["wallet_topup", 240001],
      ["wallet_topup", 270001],
      ["wallet_topup", 300001],
    ]);
    expect(io.readSource).toHaveBeenCalledTimes(20);
    expect(io.readCandidate).toHaveBeenCalledTimes(10);
    expect(io.readCrossReferences).toHaveBeenCalledTimes(10);
    for (const row of plan.rows) {
      expect(row.status).toBe("NEEDS_ATTESTATION");
      expect(row.proposal?.after).toBe(`r2p:${row.candidate?.candidate?.key}`);
      expect(row.approval).toBeNull();
      expect(row.mappingProvenance).toBe("UNREVIEWED");
      expect(row.historicalByteIdentity).toBe("UNPROVEN");
      expect(row.snapshot.before!.source.evidenceVersion).toBe(0);
      expect(row.snapshot.after!.source.extractedData).toBeNull();
      expect(row.writeAuthorized).toBe(false);
    }
    expect(plan.isApplyManifest).toBe(false);
    expect(plan.historicalCoverageComplete).toBe(false);
    expect(plan.codeShaVerification).toBe("OPERATOR_DECLARED_NOT_VERIFIED");
  });

  it("reads source again after the cross-source lookups and detects protected snapshot drift", async () => {
    const io = readers();
    const order: string[] = [];
    io.readSource = vi.fn(async target => {
      order.push("source");
      const s = source(target);
      if (order.filter(x => x === "source").length === 2)
        s.record.updatedAt = "2026-09-02 01:02:03";
      return s;
    });
    io.readCrossReferences = vi.fn(async () => {
      order.push("cross");
      return cross();
    });
    const plan = await prepareLegacySlipRelinkPlan(io, metadata);
    expect(order.slice(0, 3)).toEqual(["source", "cross", "source"]);
    expect(plan.rows[0].blockers).toContain("SOURCE_CHANGED");
    expect(plan.rows[0].proposal).toBeNull();
  });

  it.each([
    [
      "not approved",
      (s: RelinkSourceSnapshot) => {
        s.source.status = "pending_review";
      },
      "SOURCE_NOT_APPROVED",
    ],
    [
      "new version",
      (s: RelinkSourceSnapshot) => {
        s.source.evidenceVersion = 1;
      },
      "SOURCE_NOT_VERSION_ZERO",
    ],
    [
      "new extraction",
      (s: RelinkSourceSnapshot) => {
        s.source.extractedData = "{}";
      },
      "EXTRACTION_STATE_CHANGED",
    ],
    [
      "new extraction binding",
      (s: RelinkSourceSnapshot) => {
        s.source.extractedEvidenceVersion = 0;
      },
      "EXTRACTION_STATE_CHANGED",
    ],
    [
      "new evidence binding",
      (s: RelinkSourceSnapshot) => {
        s.source.slipEvidenceId = 1;
      },
      "EXISTING_EVIDENCE_BINDING",
    ],
    [
      "protected class",
      (s: RelinkSourceSnapshot) => {
        s.source.slipEvidenceClass = "modern_immutable";
      },
      "SOURCE_NOT_LEGACY_COMPATIBILITY",
    ],
    [
      "bad owner",
      (s: RelinkSourceSnapshot) => {
        s.source.ownerUserId = null;
      },
      "OWNER_UNPROVEN",
    ],
    [
      "new source claim",
      (s: RelinkSourceSnapshot) => {
        s.related.claims = [{ id: 1 }];
      },
      "SOURCE_CLAIMS_PRESENT",
    ],
    [
      "source collision",
      (s: RelinkSourceSnapshot) => {
        s.related.collisions = [{ id: 1 }];
      },
      "KNOWN_SOURCE_COLLISION",
    ],
    [
      "truncated source",
      (s: RelinkSourceSnapshot) => {
        s.truncated = true;
      },
      "RELATED_READ_INCOMPLETE",
    ],
    [
      "untrusted source",
      (s: RelinkSourceSnapshot) => {
        s.source.slipImageUrl = "https://untrusted.invalid/slip";
      },
      "SOURCE_REFERENCE_NOT_TRUSTED_LEGACY",
    ],
  ] as const)(
    "blocks %s before storage reads",
    async (_label, mutate, reason) => {
      const io = readers();
      io.readSource = vi.fn(async target => {
        const s = source(target);
        mutate(s);
        return s;
      });
      const plan = await prepareLegacySlipRelinkPlan(io, metadata);
      expect(io.listCandidate).not.toHaveBeenCalled();
      expect(
        plan.rows.every(
          row => row.status === "BLOCKED" && row.blockers.includes(reason)
        )
      ).toBe(true);
    }
  );

  it("skips already-private sources without touching their objects", async () => {
    const io = readers();
    io.readSource = vi.fn(async target => {
      const s = source(target);
      s.source.slipImageUrl = "r2p:private-key";
      return s;
    });
    const plan = await prepareLegacySlipRelinkPlan(io, metadata);
    expect(io.listCandidate).not.toHaveBeenCalled();
    expect(
      plan.rows.every(row => row.status === "SKIPPED" && row.proposal === null)
    ).toBe(true);
  });

  it.each([
    "claims",
    "collisions",
    "bindings",
    "uploads",
    "references",
  ] as const)("blocks known global %s hits", async type => {
    const io = readers();
    io.readCrossReferences = vi.fn(async () => ({
      ...cross(),
      [type]: [{ id: 5, fileHash: SECRET }],
    }));
    const plan = await prepareLegacySlipRelinkPlan(io, metadata);
    expect(
      plan.rows.every(row => row.status === "BLOCKED" && row.proposal === null)
    ).toBe(true);
    expect(JSON.stringify(summarizeRelinkPlan(plan))).not.toContain(SECRET);
  });

  it("does not turn truncated global checks into a conflict-free plan", async () => {
    const io = readers();
    io.readCrossReferences = vi.fn(async () => ({
      ...cross(),
      truncated: true,
    }));
    const plan = await prepareLegacySlipRelinkPlan(io, metadata);
    expect(plan.rows[0].blockers).toContain("CROSS_REFERENCE_READ_INCOMPLETE");
  });

  it("blocks both sides of duplicates found only after later objects are read", async () => {
    const io = readers();
    io.readCandidate = vi.fn(async () => ({
      rawHash: "a".repeat(64),
      canonicalHash: "b".repeat(64),
      byteLength: 32,
      mimeType: "image/jpeg" as const,
    }));
    const plan = await prepareLegacySlipRelinkPlan(io, metadata);
    expect(
      plan.rows.every(
        row =>
          row.blockers.includes("DUPLICATE_CANDIDATE_IN_BATCH") &&
          row.proposal === null
      )
    ).toBe(true);
  });

  it.each([
    {
      listing: {
        candidateCount: 2,
        unexpectedObjectCount: 0,
        truncated: false,
      },
    },
    {
      listing: {
        candidateCount: 1,
        unexpectedObjectCount: 1,
        truncated: false,
      },
    },
    {
      listing: { candidateCount: 1, unexpectedObjectCount: 0, truncated: true },
    },
    {
      listing: {
        candidateCount: 1,
        unexpectedObjectCount: 0,
        truncated: false,
      },
      candidate: { key: "wrong-key", etag: '"x"', size: 32 },
    },
  ])("never downloads an unsafe listing", async listed => {
    const io = readers();
    io.listCandidate = vi.fn(async () => listed);
    const plan = await prepareLegacySlipRelinkPlan(io, metadata);
    expect(io.readCandidate).not.toHaveBeenCalled();
    expect(plan.rows[0].status).toBe("BLOCKED");
  });

  it("preserves source unknown records without authorizing changes or calling them collisions", async () => {
    const io = readers();
    io.readSource = vi.fn(async target => {
      const s = source(target);
      s.related.unknowns = [{ id: 3, reason: "file_hash_recovery_failed" }];
      return s;
    });
    const plan = await prepareLegacySlipRelinkPlan(io, metadata);
    expect(plan.rows[0].status).toBe("NEEDS_ATTESTATION");
    expect(plan.rows[0].snapshot.before!.related.unknowns).toHaveLength(1);
  });

  it("keeps missing-ETag blocked observations plain-JSON serializable", async () => {
    const io = readers();
    const original = io.listCandidate;
    io.listCandidate = vi.fn(async target => {
      const result = await original(target);
      result.candidate!.etag = undefined;
      return result;
    });
    const plan = await prepareLegacySlipRelinkPlan(io, metadata);
    expect(io.readCandidate).not.toHaveBeenCalled();
    expect(plan.rows[0].status).toBe("BLOCKED");
    expect(plan.rows[0].candidate?.candidate?.etag).toBeNull();
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });

  it("retains private mapping/context while public output excludes URLs, hashes, owner/amount/context", async () => {
    const plan = await prepareLegacySlipRelinkPlan(readers(), metadata);
    expect(JSON.stringify(plan)).toContain(SECRET);
    const publicText = JSON.stringify(summarizeRelinkPlan(plan));
    for (const forbidden of [
      SECRET,
      "r2p:",
      "https:",
      "privateetag",
      "12.34",
      plan.rows[0].candidate!.bytes!.canonicalHash,
      "ownerUserId",
      "extractedData",
    ]) {
      expect(publicText).not.toContain(forbidden);
    }
  });

  it("uses fixed error codes and still reports all ten targets on read failure", async () => {
    const io = readers();
    io.readSource = vi.fn(async () => {
      throw new Error(SECRET);
    });
    const plan = await prepareLegacySlipRelinkPlan(io, metadata);
    expect(plan.rows).toHaveLength(10);
    expect(plan.rows[0].blockers).toContain("OPERATION_FAILED");
    expect(JSON.stringify(plan)).not.toContain(SECRET);
  });

  it("retains only allowed operational codes, including timeout", async () => {
    const io = readers();
    io.listCandidate = vi.fn(async () => {
      throw new AuditReadError("OBJECT_READ_TIMEOUT");
    });
    const plan = await prepareLegacySlipRelinkPlan(io, metadata);
    expect(plan.rows[0].blockers).toContain("OBJECT_READ_TIMEOUT");
    expect(io.readSource).toHaveBeenCalledTimes(20);
  });

  it("reports unattempted targets when the cooperative budget expires", async () => {
    const io = readers();
    let calls = 0;
    const plan = await prepareLegacySlipRelinkPlan(io, metadata, () =>
      ++calls === 1 ? 0 : 240_000
    );
    expect(io.readSource).not.toHaveBeenCalled();
    expect(
      plan.rows.every(row => row.blockers.includes("RUN_DEADLINE_EXCEEDED"))
    ).toBe(true);
  });

  it("rejects unvalidated metadata before any remote reads", async () => {
    const io = readers();
    await expect(
      prepareLegacySlipRelinkPlan(io, { ...metadata, declaredCodeSha: SECRET })
    ).rejects.toThrow("INVALID_PLAN_METADATA");
    expect(io.readSource).not.toHaveBeenCalled();
  });

  it("target fingerprint excludes credentials and changes with actual target configuration", () => {
    const config = validateLegacySlipAuditEnvironment({
      DATABASE_URL: "mysql://user:pass@z71vl8sxkolha3jf644qgsgr/ipenovel",
      R2_PRIVATE_ACCOUNT_ID: "account",
      R2_PRIVATE_ACCESS_KEY_ID: "access",
      R2_PRIVATE_SECRET_ACCESS_KEY: "secret",
      R2_PRIVATE_ENDPOINT: "https://account.r2.cloudflarestorage.com",
      R2_PRIVATE_BUCKET_NAME: "ipenovel-staging-private",
    });
    const hash = relinkTargetFingerprint(config);
    expect(
      relinkTargetFingerprint({
        ...config,
        db: { ...config.db, user: SECRET, password: SECRET },
        r2: {
          ...config.r2,
          credentials: { accessKeyId: SECRET, secretAccessKey: SECRET },
        },
      })
    ).toBe(hash);
    expect(
      relinkTargetFingerprint({
        ...config,
        db: { ...config.db, database: "different" },
      })
    ).not.toBe(hash);
  });
});
