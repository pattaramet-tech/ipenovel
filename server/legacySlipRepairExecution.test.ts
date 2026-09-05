import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createRepairFixture } from "./fixtures/legacySlipRepairFixtures";
import {
  createOperatorAttestation,
  parseRepairPlan,
} from "../scripts/lib/legacySlipRepairContract";
import {
  digestRepairSecondReview,
  validateRepairAuthorityRecords,
  type RepairAuthorityInput,
  type RepairWriterInput,
  type RepairWriterResult,
} from "../scripts/lib/legacySlipRepairWriter";
import {
  relinkTargetFingerprint,
  type RelinkReaders,
} from "../scripts/lib/legacySlipRelinkPlan";
import { validateLegacySlipAuditEnvironment } from "../scripts/lib/legacySlipAuditOptions";
import {
  parseRepairExecutionArgs,
  runPreparedLegacySlipRepairExecution,
  type RepairExecutionArgs,
  type RepairExecutionDependencies,
} from "../scripts/lib/legacySlipRepairExecution";

const pin = vi.hoisted(() => ({ sha: "" }));
vi.mock("../scripts/lib/legacySlipRepairContract", async original => ({
  ...(await original<
    typeof import("../scripts/lib/legacySlipRepairContract")
  >()),
  get PINNED_REPAIR_PLAN_SHA256() {
    return pin.sha;
  },
}));
const NOW = Date.parse("2026-09-06T10:00:00.000Z");
const iso = (delta: number) => new Date(NOW + delta).toISOString();
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));
const ENV = {
  DATABASE_URL:
    "mysql://fixture:FIXTURE_PASSWORD@z71vl8sxkolha3jf644qgsgr:3306/ipenovel",
  R2_PRIVATE_ACCOUNT_ID: "fixture",
  R2_PRIVATE_ENDPOINT: "https://fixture.r2.cloudflarestorage.com",
  R2_PRIVATE_BUCKET_NAME: "ipenovel-staging-private",
  R2_PRIVATE_ACCESS_KEY_ID: "fixture",
  R2_PRIVATE_SECRET_ACCESS_KEY: "FIXTURE_SECRET",
};
const argv = [
  "--execute",
  "--confirm-preview",
  "--plan=/private/p.json",
  "--attestation=/private/a.json",
  "--review=/private/r.json",
  "--authorization=/private/z.json",
  `--code-sha=${"a".repeat(40)}`,
];

function setup() {
  const config = validateLegacySlipAuditEnvironment(ENV);
  const { plan } = createRepairFixture();
  plan.targetFingerprint = relinkTargetFingerprint(config);
  const planBytes = bytes(plan);
  pin.sha = sha(planBytes);
  const intent = parseRepairPlan(planBytes, pin.sha);
  const operatorAttestationBytes = bytes(
    createOperatorAttestation(intent, {
      reviewer: "fixture-primary",
      reason: "Synthetic private mapping review.",
      evidenceReference: "fixture-private-record",
      recordedAt: iso(-120000),
    })
  );
  const secondReview: RepairAuthorityInput["secondReview"] = {
    schema: "legacy-slip-independent-review/v1",
    reviewer: "fixture-second",
    reviewedAt: iso(-60000),
    intentSha256: intent.intentSha256,
    operatorAttestationSha256: sha(operatorAttestationBytes),
    mappingConfirmed: true,
  };
  const authorization: RepairAuthorityInput["authorization"] = {
    schema: "legacy-slip-live-authorization/v1",
    operationId: "bb6a9ff4-647d-4b4d-947c-d34a55e10f4f",
    authorizedBy: "fixture-authorizer",
    authorizedAt: iso(-30000),
    expiresAt: iso(120000),
    intentSha256: intent.intentSha256,
    operatorAttestationSha256: sha(operatorAttestationBytes),
    secondReviewSha256: digestRepairSecondReview(secondReview),
    applyAuthorized: true,
    maintenance: {
      assertionId: "fixture-freeze",
      assertedBy: "fixture-maintainer",
      assertedAt: iso(-10000),
      expiresAt: iso(120000),
      scope: "ALL_PAYMENT_ORDER_ACCOUNT_MERGE_EVIDENCE_AND_R2_WRITERS_STOPPED",
    },
  };
  const args = parseRepairExecutionArgs(argv) as RepairExecutionArgs;
  const files: Record<string, Buffer> = {
    [args.plan]: planBytes,
    [args.attestation]: operatorAttestationBytes,
    [args.review]: bytes(secondReview),
    [args.authorization]: bytes(authorization),
  };
  let clock = NOW,
    mono = 0;
  const c = intent.candidate;
  const readers: RelinkReaders & { close(): void } = {
    readSource: vi.fn(async () => structuredClone(intent.before)),
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
    close: vi.fn(),
  };
  const dependencies: RepairExecutionDependencies = {
    requireLinux: vi.fn(),
    readPrivate: vi.fn(async path => files[path]),
    environment: vi.fn(() => ({ ...ENV })),
    createReaders: vi.fn(() => readers),
    executeWriter: vi.fn(async () => ({
      status: "APPLIED" as const,
      code: "REFERENCE_AND_PRIVATE_AUDIT_COMMITTED",
    })),
    now: () => clock,
    monotonicNow: () => mono,
  };
  return {
    args,
    files,
    intent,
    planBytes,
    operatorAttestationBytes,
    secondReview,
    authorization,
    readers,
    dependencies,
    advance: (ms: number) => {
      clock += ms;
      mono += ms;
    },
    wall: (ms: number) => {
      clock += ms;
    },
    mono: (ms: number) => {
      mono += ms;
    },
    save: () => {
      files[args.review] = bytes(secondReview);
      files[args.authorization] = bytes(authorization);
    },
    run: () => runPreparedLegacySlipRepairExecution(args, dependencies),
  };
}

describe("execution candidate fresh preflight and authority", () => {
  it("read-only authority records reject a grant originally issued over 24h after review", () => {
    const s = setup();
    const input: RepairAuthorityInput = {
      intent: s.intent,
      planBytes: s.planBytes,
      operatorAttestationBytes: s.operatorAttestationBytes,
      secondReview: s.secondReview,
      authorization: s.authorization,
    };
    const config = validateLegacySlipAuditEnvironment(ENV);
    expect(validateRepairAuthorityRecords(input, config).intent).toEqual(
      s.intent
    );
    s.authorization.authorizedAt = iso(86_400_000);
    s.authorization.expiresAt = iso(86_401_000);
    expect(() => validateRepairAuthorityRecords(input, config)).toThrow(
      "INVALID_AUTHORIZATION"
    );
  });
  it("reads exactly one current mapping, closes R2, dispatches writer once with original window", async () => {
    const s = setup();
    const original = s.readers.readCandidate;
    s.readers.readCandidate = vi.fn(async c => {
      s.advance(21000);
      return original(c);
    });
    const result = await s.run();
    expect(result).toMatchObject({
      status: "APPLIED",
      committedDatabaseWrites: 2,
      objectWrites: 0,
      automaticRetry: false,
    });
    expect(s.dependencies.executeWriter).toHaveBeenCalledTimes(1);
    const input = vi.mocked(s.dependencies.executeWriter!).mock.calls[0][0];
    expect(input.preflight.checkedAt).toBe(iso(0));
    expect(input.preflight.expiresAt).toBe(iso(60000));
    expect(input.preflight.candidate).toEqual(s.intent.candidate);
    expect(s.readers.readSource).toHaveBeenCalledTimes(2);
    expect(vi.mocked(s.readers.close).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(s.dependencies.executeWriter!).mock.invocationCallOrder[0]
    );
    for (const call of vi.mocked(s.readers.readSource).mock.calls)
      expect(call[0]).toEqual({
        sourceType: "order_payment",
        sourceId: 11280001,
      });
    for (const value of [
      s.intent.candidate.key,
      s.intent.candidate.rawHash,
      s.intent.before.source.slipImageUrl!,
      "fixture-primary",
      ENV.R2_PRIVATE_SECRET_ACCESS_KEY,
    ])
      expect(JSON.stringify(result)).not.toContain(value);
  });
  it.each(["plan", "attestation", "review", "authorization"] as const)(
    "missing private %s stops before network",
    async key => {
      const s = setup();
      delete s.files[s.args[key]];
      expect((await s.run()).status).toBe("BLOCKED");
      expect(s.dependencies.createReaders).not.toHaveBeenCalled();
      expect(s.dependencies.executeWriter).not.toHaveBeenCalled();
    }
  );
  it.each(["review", "authorization"] as const)(
    "duplicate private JSON members in %s rejected",
    async key => {
      const s = setup();
      s.files[s.args[key]] = Buffer.from('{"schema":"x","schema":"y"}');
      expect((await s.run()).status).toBe("BLOCKED");
      expect(s.dependencies.createReaders).not.toHaveBeenCalled();
    }
  );
  it.each(["plan", "attestation", "review", "authorization"] as const)(
    "strict byte limit requested for %s",
    async key => {
      const s = setup();
      await s.run();
      expect(s.dependencies.readPrivate).toHaveBeenCalledWith(
        s.args[key],
        key === "plan" ? 8 * 1024 * 1024 : 65536
      );
    }
  );
  it.each(["plan", "attestation", "review", "authorization"] as const)(
    "bad UTF8 %s fails closed",
    async key => {
      const s = setup();
      s.files[s.args[key]] = Buffer.from([0xff]);
      expect((await s.run()).status).toBe("BLOCKED");
      expect(s.dependencies.createReaders).not.toHaveBeenCalled();
    }
  );
  it.each([
    [
      "same operator",
      (s: ReturnType<typeof setup>) => {
        s.secondReview.reviewer = "FIXTURE-PRIMARY";
        s.authorization.secondReviewSha256 = digestRepairSecondReview(
          s.secondReview
        );
      },
    ],
    [
      "unconfirmed mapping",
      (s: ReturnType<typeof setup>) => {
        (s.secondReview as any).mappingConfirmed = false;
      },
    ],
    [
      "unapproved apply",
      (s: ReturnType<typeof setup>) => {
        (s.authorization as any).applyAuthorized = false;
      },
    ],
    [
      "wrong intent",
      (s: ReturnType<typeof setup>) => {
        s.authorization.intentSha256 = "0".repeat(64);
      },
    ],
    [
      "wrong attestation",
      (s: ReturnType<typeof setup>) => {
        s.authorization.operatorAttestationSha256 = "0".repeat(64);
      },
    ],
    [
      "wrong review",
      (s: ReturnType<typeof setup>) => {
        s.authorization.secondReviewSha256 = "0".repeat(64);
      },
    ],
    [
      "future authorization",
      (s: ReturnType<typeof setup>) => {
        s.authorization.authorizedAt = iso(1000);
      },
    ],
    [
      "expired authorization",
      (s: ReturnType<typeof setup>) => {
        s.authorization.expiresAt = iso(-1);
      },
    ],
    [
      "future freeze",
      (s: ReturnType<typeof setup>) => {
        s.authorization.maintenance.assertedAt = iso(1);
      },
    ],
    [
      "expired freeze",
      (s: ReturnType<typeof setup>) => {
        s.authorization.maintenance.expiresAt = iso(-1);
      },
    ],
    [
      "broad duration",
      (s: ReturnType<typeof setup>) => {
        s.authorization.expiresAt = iso(900001);
      },
    ],
    [
      "narrow freeze",
      (s: ReturnType<typeof setup>) => {
        (s.authorization.maintenance as any).scope = "PREVIEW_WEB_ONLY";
      },
    ],
    [
      "supplied preflight",
      (s: ReturnType<typeof setup>) => {
        (s.authorization as any).preflight = { checkedAt: iso(0) };
      },
    ],
  ] as const)(
    "rejects %s before first network client",
    async (_label, change) => {
      const s = setup();
      change(s);
      s.save();
      expect((await s.run()).status).toBe("BLOCKED");
      expect(s.dependencies.createReaders).not.toHaveBeenCalled();
      expect(s.dependencies.executeWriter).not.toHaveBeenCalled();
    }
  );
  it("validates Linux before file reads", async () => {
    const s = setup();
    s.dependencies.requireLinux = () => {
      throw new Error("PRIVATE_PATH");
    };
    expect((await s.run()).code).toBe("PRIVATE_INPUT_REJECTED");
    expect(s.dependencies.readPrivate).not.toHaveBeenCalled();
  });
  it("checks exact plan byte pin", async () => {
    const s = setup();
    s.files[s.args.plan] = Buffer.concat([s.planBytes, Buffer.from(" ")]);
    expect((await s.run()).status).toBe("BLOCKED");
    expect(s.dependencies.createReaders).not.toHaveBeenCalled();
  });
  it("does not open clients when environment points elsewhere", async () => {
    const s = setup();
    s.dependencies.environment = () => ({
      ...ENV,
      DATABASE_URL: "mysql://u:p@other/production",
    });
    expect((await s.run()).code).toBe("ENVIRONMENT_REJECTED");
    expect(s.dependencies.createReaders).not.toHaveBeenCalled();
  });
  it("checks reviewed account fingerprint before client creation", async () => {
    const s = setup();
    s.dependencies.environment = () => ({
      ...ENV,
      R2_PRIVATE_ACCOUNT_ID: "other",
      R2_PRIVATE_ENDPOINT: "https://other.r2.cloudflarestorage.com",
    });
    expect((await s.run()).code).toBe("AUTHORITY_REJECTED");
    expect(s.dependencies.createReaders).not.toHaveBeenCalled();
  });
  it.each([
    "readSource",
    "listCandidate",
    "readCandidate",
    "readCrossReferences",
  ] as const)("read failure at %s closes once and never writes", async key => {
    const s = setup();
    vi.mocked(s.readers[key]).mockRejectedValue(
      new Error("PRIVATE_KEY_OR_CREDENTIAL")
    );
    const result = await s.run();
    expect(result.status).toBe("BLOCKED");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_KEY");
    expect(s.readers.close).toHaveBeenCalledTimes(1);
    expect(s.dependencies.executeWriter).not.toHaveBeenCalled();
  });
  it.each([
    "readSource",
    "listCandidate",
    "readCandidate",
    "readCrossReferences",
  ] as const)("60s spent in %s cannot receive a reset expiry", async key => {
    const s = setup();
    const original = s.readers[key];
    s.readers[key] = vi.fn(async (...args: any[]) => {
      s.advance(60000);
      return (original as any)(...args);
    }) as any;
    expect((await s.run()).status).toBe("BLOCKED");
    expect(s.dependencies.executeWriter).not.toHaveBeenCalled();
    expect(s.readers.close).toHaveBeenCalledTimes(1);
  });
  it("expiry during close is not refreshed", async () => {
    const s = setup();
    s.readers.close = vi.fn(() => s.advance(60000));
    expect((await s.run()).status).toBe("BLOCKED");
    expect(s.dependencies.executeWriter).not.toHaveBeenCalled();
  });
  it("close failure prevents locks/writes", async () => {
    const s = setup();
    s.readers.close = vi.fn(() => {
      throw new Error("PRIVATE_CLOSE_ERROR");
    });
    expect((await s.run()).status).toBe("BLOCKED");
    expect(s.dependencies.executeWriter).not.toHaveBeenCalled();
  });
  it("wall clock going backwards fails closed", async () => {
    const s = setup();
    const original = s.readers.readCandidate;
    s.readers.readCandidate = vi.fn(async c => {
      s.wall(-1);
      return original(c);
    });
    expect((await s.run()).status).toBe("BLOCKED");
    expect(s.dependencies.executeWriter).not.toHaveBeenCalled();
  });
  it("monotonic expiry cannot be hidden by frozen wall time", async () => {
    const s = setup();
    const original = s.readers.readCandidate;
    s.readers.readCandidate = vi.fn(async c => {
      s.mono(60000);
      return original(c);
    });
    expect((await s.run()).status).toBe("BLOCKED");
    expect(s.dependencies.executeWriter).not.toHaveBeenCalled();
  });
  it("authorization expiring before 60s clips preflight window", async () => {
    const s = setup();
    s.authorization.expiresAt = iso(30000);
    s.save();
    await s.run();
    expect(
      vi.mocked(s.dependencies.executeWriter!).mock.calls[0][0].preflight
        .expiresAt
    ).toBe(iso(30000));
  });
  it("fresh final source drift blocks after all object reads", async () => {
    const s = setup();
    vi.mocked(s.readers.readSource)
      .mockResolvedValueOnce(structuredClone(s.intent.before))
      .mockResolvedValueOnce(null);
    expect((await s.run()).status).toBe("BLOCKED");
    expect(s.dependencies.executeWriter).not.toHaveBeenCalled();
  });
  it("already repaired URL is not fed through execute as a new attempt", async () => {
    const s = setup();
    const after = structuredClone(s.intent.before);
    after.source.slipImageUrl = `r2p:${s.intent.candidate.key}`;
    after.record.slipImageUrl = after.source.slipImageUrl;
    vi.mocked(s.readers.readSource).mockResolvedValue(after);
    expect((await s.run()).status).toBe("BLOCKED");
    expect(s.dependencies.executeWriter).not.toHaveBeenCalled();
  });
  it("owns private buffers before later awaits", async () => {
    const s = setup();
    const originalPlan = s.files[s.args.plan];
    const originalRead = s.dependencies.readPrivate!;
    s.dependencies.readPrivate = vi.fn(async (path, cap) => {
      if (path === s.args.attestation) originalPlan.fill(0);
      return originalRead(path, cap);
    });
    expect((await s.run()).status).toBe("APPLIED");
    expect(
      sha(vi.mocked(s.dependencies.executeWriter!).mock.calls[0][0].planBytes)
    ).toBe(pin.sha);
  });
  it("external authorizer mutation during network awaits does not change bound input", async () => {
    const s = setup();
    const original = s.readers.readCandidate;
    s.readers.readCandidate = vi.fn(async c => {
      s.authorization.applyAuthorized = false as any;
      s.files[s.args.authorization].fill(0);
      return original(c);
    });
    expect((await s.run()).status).toBe("APPLIED");
    expect(
      vi.mocked(s.dependencies.executeWriter!).mock.calls[0][0].authorization
        .applyAuthorized
    ).toBe(true);
  });
  it("unexpected post-dispatch failure stays UNKNOWN with no retry", async () => {
    const s = setup();
    s.dependencies.executeWriter = vi.fn(async () => {
      throw new Error("SECRET_AFTER_COMMIT");
    });
    expect(await s.run()).toMatchObject({
      status: "UNKNOWN",
      committedDatabaseWrites: null,
      automaticRetry: false,
      nextAction: "STOP_AND_RECONCILE_READ_ONLY_NO_RETRY",
    });
    expect(s.dependencies.executeWriter).toHaveBeenCalledTimes(1);
  });
  it.each([
    "MATCHING_AUDIT_AND_STATE",
    "NO_COMMIT_EVIDENCE",
    "CONFLICT",
    "FAILED",
  ] as const)(
    "UNKNOWN remains UNKNOWN even after %s reconciliation",
    async reconciliation => {
      const s = setup();
      s.dependencies.executeWriter = vi.fn(async () => ({
        status: "UNKNOWN" as const,
        code: "COMMIT_OUTCOME_UNKNOWN",
        reconciliation,
      }));
      expect(await s.run()).toMatchObject({
        status: "UNKNOWN",
        committedDatabaseWrites: null,
        reconciliation,
        automaticRetry: false,
      });
      expect(s.dependencies.executeWriter).toHaveBeenCalledTimes(1);
    }
  );
  it.each(["BLOCKED", "ROLLED_BACK"] as const)(
    "sanitizes %s code and fields",
    async status => {
      const s = setup();
      s.dependencies.executeWriter = vi.fn(async () => ({
        status,
        code: "PRIVATE_SECRET",
        extra: "PRIVATE_KEY",
      }));
      const result = await s.run();
      expect(result.status).toBe(status);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    }
  );
  it("unknown unexpected writer result fails to UNKNOWN not success", async () => {
    const s = setup();
    s.dependencies.executeWriter = vi.fn(
      async () =>
        ({
          status: "APPLIED",
          code: "private-fake-success",
        }) as RepairWriterResult
    );
    expect((await s.run()).status).toBe("UNKNOWN");
  });
});
