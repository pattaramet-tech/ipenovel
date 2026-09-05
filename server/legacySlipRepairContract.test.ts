import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { payments, walletTopups, orders } from "../drizzle/schema";
import {
  canonicalRepairJson,
  createOperatorAttestation,
  digestOperatorAttestation,
  digestRepairIntent,
  parsePrivateRepairJson,
  parseOperatorAttestationBytes,
  parseRepairPlan,
  PINNED_REPAIR_PLAN_SHA256,
  PINNED_REPAIR_RUN_ID,
  REPAIR_TARGET,
  RepairError,
  validateOperatorAttestation,
  validateRepairIntent,
} from "../scripts/lib/legacySlipRepairContract";
import { prepareLegacySlipRelinkPlan } from "../scripts/lib/legacySlipRelinkPlan";
import { createRepairFixture } from "./fixtures/legacySlipRepairFixtures";

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const repack = (plan: unknown) => {
  const bytes = Buffer.from(JSON.stringify(plan));
  return () => parseRepairPlan(bytes, digest(bytes));
};
const statement = () => ({
  reviewer: "first-reviewer",
  reason: "Confirmed the same transaction with private supporting evidence.",
  evidenceReference: "private-record-1",
  recordedAt: "2026-09-05T13:00:00.000Z",
});

describe("single-payment repair private contract", () => {
  it("pins source and operator run while extracting only one private intent", () => {
    const f = createRepairFixture();
    expect(REPAIR_TARGET).toEqual({
      sourceType: "order_payment",
      sourceId: 11280001,
    });
    expect(Object.isFrozen(REPAIR_TARGET)).toBe(true);
    expect(PINNED_REPAIR_RUN_ID).toBe("05e9e0ee-edbc-46ab-bb6e-6527824bd308");
    expect(PINNED_REPAIR_PLAN_SHA256).toBe(
      "d89ee2bc6aa911e65a1262a190d60343401faeede6b044276ab44f8be0dffe77"
    );
    expect(f.intent.sourceId).toBe(11280001);
    expect(Object.hasOwn(f.intent, "rows")).toBe(false);
    expect(Object.hasOwn(f.intent, "writeAuthorized")).toBe(false);
    expect(
      isDeepStrictEqual(f.intent.before, f.plan.rows[0].snapshot.before)
    ).toBe(true);
    expect(f.intent.planSha256).toBe(f.planSha256);
  });

  it("accepts actual prepare generator serialization using only fake readers", async () => {
    const f = createRepairFixture();
    const plan = await prepareLegacySlipRelinkPlan(
      {
        readSource: async t =>
          structuredClone(
            f.plan.rows.find(
              r => r.sourceType === t.sourceType && r.sourceId === t.sourceId
            )!.snapshot.before
          ),
        listCandidate: async t =>
          structuredClone(
            f.plan.rows.find(
              r => r.sourceType === t.sourceType && r.sourceId === t.sourceId
            )!.candidate
          ),
        readCandidate: async c =>
          structuredClone(
            f.plan.rows.find(r => r.candidate.candidate.key === c.key)!
              .candidate.bytes
          ) as any,
        readCrossReferences: async () => ({
          claims: [],
          collisions: [],
          bindings: [],
          uploads: [],
          references: [],
          truncated: false,
        }),
      },
      {
        runId: PINNED_REPAIR_RUN_ID,
        preparedAt: f.plan.preparedAt,
        declaredCodeSha: f.plan.declaredCodeSha,
        toolSourceDigest: f.plan.toolSourceDigest,
        targetFingerprint: f.plan.targetFingerprint,
      }
    );
    expect(repack(plan)().sourceId).toBe(11280001);
  });

  it("fixture snapshots enumerate actual schema financial/evidence/chronology fields", () => {
    const f = createRepairFixture();
    expect(Object.keys(f.intent.before.record).sort()).toEqual(
      Object.keys(getTableColumns(payments)).sort()
    );
    expect(Object.keys(f.intent.before.order!).sort()).toEqual(
      Object.keys(getTableColumns(orders)).sort()
    );
    expect(Object.keys(f.plan.rows[5].snapshot.before.record).sort()).toEqual(
      Object.keys(getTableColumns(walletTopups)).sort()
    );
  });

  it("rejects changed bytes against original expected digest before examining content", () => {
    const f = createRepairFixture();
    expect(() =>
      parseRepairPlan(
        Buffer.concat([f.planBytes, Buffer.from(" ")]),
        f.planSha256
      )
    ).toThrow("PLAN_DIGEST_MISMATCH");
    expect(() =>
      parseRepairPlan(f.planBytes, PINNED_REPAIR_PLAN_SHA256)
    ).toThrow("PLAN_DIGEST_MISMATCH");
  });

  it.each([
    undefined,
    null,
    "a",
    "A".repeat(64),
    "z".repeat(64),
    "a".repeat(63),
  ])("rejects invalid expected digest %s", expected => {
    expect(() =>
      parseRepairPlan(Buffer.from("{}"), expected as string)
    ).toThrow("INVALID_REPAIR_INPUT");
  });
  it("rejects oversized input before digest computation", () => {
    expect(() =>
      parseRepairPlan(Buffer.alloc(8 * 1024 * 1024 + 1), "a".repeat(64))
    ).toThrow("PLAN_TOO_LARGE");
  });

  const planMutations: Array<[string, (p: any) => void]> = [
    ["wrong schema", p => (p.schema = "apply/v1")],
    ["write claim", p => (p.writeAuthorized = true)],
    ["apply claim", p => (p.isApplyManifest = true)],
    ["coverage claim", p => (p.historicalCoverageComplete = true)],
    ["different run", p => (p.runId = "15e9e0ee-edbc-46ab-bb6e-6527824bd308")],
    ["extra metadata", p => (p.allowUnsafe = true)],
    [
      "invalid target fingerprint",
      p => (p.targetFingerprint = "private-host-name"),
    ],
    [
      "operator code SHA claimed verified",
      p => (p.codeShaVerification = "VERIFIED"),
    ],
    ["invalid instant", p => (p.preparedAt = "2026-02-30T13:00:00.000Z")],
    ["missing target", p => p.rows.shift()],
    ["duplicate target", p => (p.rows[1] = structuredClone(p.rows[0]))],
    ["extra target", p => p.rows.push(structuredClone(p.rows[0]))],
    ["out of scope pending target", p => (p.rows[0].sourceId = 82350007)],
    ["changed source type", p => (p.rows[0].sourceType = "wallet_topup")],
    ["row blocked", p => (p.rows[0].status = "BLOCKED")],
    ["context row blocked", p => (p.rows[9].status = "BLOCKED")],
    ["row blockers", p => (p.rows[0].blockers = ["KNOWN_COLLISION"])],
    [
      "mapping approval claimed",
      p => (p.rows[0].approval = { approved: true }),
    ],
    [
      "historical identity fabricated",
      p => (p.rows[0].historicalByteIdentity = "PROVEN"),
    ],
    [
      "source snapshot changed",
      p => (p.rows[0].snapshot.after.record.updatedAt = "2026-09-05 09:18:16"),
    ],
    [
      "missing financial snapshot",
      p => delete p.rows[0].snapshot.before.order.totalAmount,
    ],
    [
      "new snapshot field",
      p => (p.rows[0].snapshot.before.record.unrecognized = "private"),
    ],
    ["owner mismatch", p => (p.rows[0].snapshot.before.order.userId = 4001)],
    ["wrong order", p => (p.rows[0].snapshot.before.order.id = 42)],
    [
      "payment projection mismatch",
      p => (p.rows[0].snapshot.before.record.status = "pending_review"),
    ],
    [
      "nullable required numeric",
      p => (p.rows[0].snapshot.before.record.ocrConfidence = null),
    ],
    [
      "wrong numeric type",
      p => (p.rows[0].snapshot.before.record.orderId = "11280101"),
    ],
    [
      "wrong decimal type",
      p => (p.rows[0].snapshot.before.order.totalAmount = 100),
    ],
    [
      "known global claim",
      p => (p.rows[0].crossReferences.claims = [{ id: 1 }]),
    ],
    [
      "known collision",
      p => (p.rows[0].crossReferences.collisions = [{ id: 1 }]),
    ],
    [
      "existing binding",
      p => (p.rows[0].crossReferences.bindings = [{ id: 1 }]),
    ],
    ["existing upload", p => (p.rows[0].crossReferences.uploads = [{ id: 1 }])],
    [
      "existing object reference",
      p => (p.rows[0].crossReferences.references = [{ id: 1 }]),
    ],
    [
      "truncated global scan",
      p => (p.rows[0].crossReferences.truncated = true),
    ],
    [
      "truncated candidate list",
      p => (p.rows[0].candidate.listing.truncated = true),
    ],
    [
      "ambiguous candidate",
      p => (p.rows[0].candidate.listing.candidateCount = 2),
    ],
    [
      "unexpected object",
      p => (p.rows[0].candidate.listing.unexpectedObjectCount = 1),
    ],
    ["missing etag", p => (p.rows[0].candidate.candidate.etag = null)],
    [
      "wrong key prefix",
      p =>
        (p.rows[0].candidate.candidate.key =
          "payment-slips/legacy/payments/82350007/1780000000000-fixture.jpg"),
    ],
    [
      "object path traversal",
      p =>
        (p.rows[0].candidate.candidate.key =
          "payment-slips/legacy/payments/11280001/../1780000000000-fixture.jpg"),
    ],
    ["unquoted etag", p => (p.rows[0].candidate.candidate.etag = "etag")],
    [
      "oversized etag",
      p => (p.rows[0].candidate.candidate.etag = '"' + "a".repeat(256) + '"'),
    ],
    ["empty object", p => (p.rows[0].candidate.candidate.size = 0)],
    [
      "oversized object",
      p => (p.rows[0].candidate.candidate.size = 6 * 1024 * 1024),
    ],
    ["wrong read byte count", p => p.rows[0].candidate.bytes.byteLength++],
    ["invalid hash", p => (p.rows[0].candidate.bytes.rawHash = "a".repeat(63))],
    ["invalid MIME", p => (p.rows[0].candidate.bytes.mimeType = "text/html")],
    [
      "MIME extension mismatch",
      p => (p.rows[0].candidate.bytes.mimeType = "image/png"),
    ],
    [
      "duplicate raw hash in context",
      p =>
        (p.rows[8].candidate.bytes.rawHash = p.rows[0].candidate.bytes.rawHash),
    ],
    [
      "duplicate canonical hash in context",
      p =>
        (p.rows[8].candidate.bytes.canonicalHash =
          p.rows[0].candidate.bytes.canonicalHash),
    ],
    [
      "cross raw-canonical collision",
      p =>
        (p.rows[8].candidate.bytes.rawHash =
          p.rows[0].candidate.bytes.canonicalHash),
    ],
    ["wrong proposed field", p => (p.rows[0].proposal.field = "status")],
    [
      "wrong proposal old reference",
      p => (p.rows[0].proposal.before = "https://example.invalid/private"),
    ],
    [
      "wrong proposal new reference",
      p => (p.rows[0].proposal.after = "r2p:other-private-key"),
    ],
    [
      "unrestricted mutation proposal",
      p => (p.rows[0].proposal.referenceOnly = false),
    ],
  ];
  it.each(planMutations)("fails closed on %s", (_, mutate) => {
    const { plan } = createRepairFixture();
    mutate(plan);
    expect(repack(plan)).toThrow("INVALID_REPAIR_PLAN");
  });

  it.each([
    [
      "not approved",
      (s: any) => {
        s.source.status = s.record.status = "pending";
      },
    ],
    [
      "new version",
      (s: any) => {
        s.source.evidenceVersion = s.record.evidenceVersion = 1;
      },
    ],
    [
      "modern class",
      (s: any) => {
        s.source.slipEvidenceClass = s.record.slipEvidenceClass =
          "modern_immutable";
      },
    ],
    [
      "existing evidence ID",
      (s: any) => {
        s.source.slipEvidenceId = s.record.slipEvidenceId = 2;
      },
    ],
    [
      "new extraction",
      (s: any) => {
        s.source.extractedData = s.record.extractedData = "{}";
      },
    ],
    [
      "bound extraction",
      (s: any) => {
        s.source.extractedEvidenceVersion =
          s.record.extractedEvidenceVersion = 0;
      },
    ],
    [
      "private R2 ref",
      (s: any) => {
        s.source.slipImageUrl = s.record.slipImageUrl = "r2p:private";
      },
    ],
    [
      "untrusted source URL",
      (s: any) => {
        s.source.slipImageUrl = s.record.slipImageUrl =
          "https://cloudfront.net.attacker.invalid/private";
      },
    ],
    [
      "source claim",
      (s: any) => {
        s.source.claims = [{ id: 1, userId: 3001, fileHash: null }];
      },
    ],
    [
      "source binding",
      (s: any) => {
        s.source.bindings = [{ id: 1 }];
      },
    ],
    [
      "related claim",
      (s: any) => {
        s.related.claims = [{ id: 1 }];
      },
    ],
    [
      "related binding",
      (s: any) => {
        s.related.bindings = [{ id: 1 }];
      },
    ],
    [
      "related collision",
      (s: any) => {
        s.related.collisions = [{ id: 1 }];
      },
    ],
    [
      "truncated source",
      (s: any) => {
        s.truncated = true;
      },
    ],
    [
      "truncated source related",
      (s: any) => {
        s.source.relatedReadTruncated = true;
      },
    ],
    [
      "unknown belongs to other source",
      (s: any) => {
        s.related.unknowns = [
          {
            id: 1,
            sourceType: "wallet_topup",
            sourceId: 11280001,
            reason: "private",
            recordedAt: "2026-09-05 09:18:15",
          },
        ];
      },
    ],
  ] as Array<[string, (s: any) => void]>)(
    "rejects both coherent snapshots with %s",
    (_, mutate) => {
      const { plan } = createRepairFixture();
      mutate(plan.rows[0].snapshot.before);
      plan.rows[0].snapshot.after = structuredClone(
        plan.rows[0].snapshot.before
      );
      expect(repack(plan)).toThrow("INVALID_REPAIR_PLAN");
    }
  );

  it("preserves existing source unknowns rather than claiming coverage complete", () => {
    const { plan } = createRepairFixture();
    const unknown = {
      id: 3,
      sourceType: "order_payment",
      sourceId: 11280001,
      reason: "private-legacy-unresolved",
      recordedAt: "2026-09-05 09:18:15",
    };
    plan.rows[0].snapshot.before.related.unknowns.push(unknown);
    plan.rows[0].snapshot.after = structuredClone(plan.rows[0].snapshot.before);
    const intent = repack(plan)();
    expect(intent.before.related.unknowns).toEqual([unknown]);
    expect(Object.hasOwn(intent, "historicalCoverageComplete")).toBe(false);
  });

  it("rejects missing unknown fields and more than20 unknowns", () => {
    const f = createRepairFixture();
    for (let id = 1; id <= 21; id++)
      f.plan.rows[0].snapshot.before.related.unknowns.push({
        id,
        sourceType: "order_payment",
        sourceId: 11280001,
        reason: "legacy",
        recordedAt: "2026-09-05 09:18:15",
      });
    f.plan.rows[0].snapshot.after = structuredClone(
      f.plan.rows[0].snapshot.before
    );
    expect(repack(f.plan)).toThrow("INVALID_REPAIR_PLAN");
  });

  it("digest is stable under object key ordering but detects snapshot and candidate tampering", () => {
    const { intent } = createRepairFixture();
    const reversed = Object.fromEntries(Object.entries(intent).reverse());
    expect(validateRepairIntent(reversed).intentSha256).toBe(
      intent.intentSha256
    );
    const changed = structuredClone(intent);
    changed.before.order!.notes = "private-change";
    expect(() => validateRepairIntent(changed)).toThrow(
      "INVALID_REPAIR_INTENT"
    );
    changed.intentSha256 = digestRepairIntent(
      (({ intentSha256, ...base }) => base)(changed)
    );
    expect(validateRepairIntent(changed).before.order!.notes).toBe(
      "private-change"
    );
    // A digest is a context binding, not provenance or independent authority.
  });

  it("returned intent and attestation do not alias input objects", () => {
    const { intent } = createRepairFixture();
    const clone = validateRepairIntent(intent);
    clone.before.record.approvedByLabel = "mutated";
    expect(intent.before.record.approvedByLabel).toBe("PRIVATE_FIXTURE_LABEL");
    const a = createOperatorAttestation(intent, statement());
    a.candidate.etag = '"mutated"';
    expect(intent.candidate.etag).toBe('"privatefixtureetag"');
  });

  it("only permits source11280001 even with recomputed intent digest", () => {
    const { intent } = createRepairFixture();
    const { intentSha256, ...base } = intent;
    expect(() =>
      digestRepairIntent({ ...base, sourceId: 82350007 } as any)
    ).toThrow("INVALID_REPAIR_INTENT");
  });
});

describe("strict private JSON and safe failure boundaries", () => {
  it.each([
    '{"value":1,"value":2}',
    '{"nested":{"a":1,"a":2}}',
    '{"__proto__":{}}',
    '{"constructor":{}}',
    '{"value":1,}',
    "[1,]",
    '{"value":NaN}',
    '{"value":1e999}',
    "{} {}",
    '{"value":"\\q"}',
    '{"value":"unterminated}',
    '{"prototype":0}',
  ])("rejects malformed or ambiguous JSON %s", input => {
    expect(() => parsePrivateRepairJson(Buffer.from(input))).toThrow(
      "INVALID_REPAIR_INPUT"
    );
  });
  it("rejects invalid UTF8 and resource bounds", () => {
    expect(() => parsePrivateRepairJson(Buffer.from([0xff]))).toThrow(
      "INVALID_REPAIR_INPUT"
    );
    expect(() => parsePrivateRepairJson(Buffer.from("{}"), 1)).toThrow(
      "INVALID_REPAIR_INPUT"
    );
    expect(() =>
      parsePrivateRepairJson(Buffer.from("{}"), 9 * 1024 * 1024)
    ).toThrow("INVALID_REPAIR_INPUT");
    expect(() =>
      parsePrivateRepairJson(Buffer.from("[".repeat(70) + "0" + "]".repeat(70)))
    ).toThrow("INVALID_REPAIR_INPUT");
    expect(() =>
      parsePrivateRepairJson(Buffer.from("[" + "0,".repeat(100001) + "0]"))
    ).toThrow("INVALID_REPAIR_INPUT");
  });
  it("accepts JSON whitespace, quotes, escapes and plain primitives", () => {
    expect(
      parsePrivateRepairJson(
        Buffer.from(' \n{"quoted":"a\\\"b","v":[true,false,null,-1.2e2]}\t')
      )
    ).toEqual({ quoted: 'a"b', v: [true, false, null, -120] });
  });
  it("rejects duplicate plan members even with the digest of the duplicate-bearing file", () => {
    const f = createRepairFixture();
    const input = f.planBytes
      .toString("utf8")
      .replace(
        '"mode":"PREPARE_ONLY"',
        '"mode":"PREPARE_ONLY","mode":"PREPARE_ONLY"'
      );
    const bytes = Buffer.from(input);
    expect(() => parseRepairPlan(bytes, digest(bytes))).toThrow(
      "INVALID_REPAIR_PLAN"
    );
  });
  it("normalizes wrong or hostile byte inputs without invoking their getters", () => {
    const trap = vi.fn(() => {
      throw new Error("PRIVATE_BYTE_SECRET");
    });
    const bogus = Object.defineProperty({}, "byteLength", { get: trap });
    const proxy = new Proxy(new Uint8Array(), { get: trap });
    for (const value of [bogus, proxy, "{}", null, undefined]) {
      expect(() => parseRepairPlan(value as any, "a".repeat(64))).toThrow(
        "INVALID_REPAIR_INPUT"
      );
      expect(() => parsePrivateRepairJson(value as any)).toThrow(
        "INVALID_REPAIR_INPUT"
      );
    }
    const actual = Buffer.from("{}");
    Object.defineProperty(actual, "byteLength", { get: trap });
    expect(parsePrivateRepairJson(actual)).toEqual({});
    expect(trap).not.toHaveBeenCalled();
  });
  it("does not execute getters, toJSON or proxy traps", () => {
    const trap = vi.fn(() => {
      throw new Error("PRIVATE_SECRET");
    });
    const getter = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: trap,
    });
    for (const value of [
      getter,
      { toJSON: trap },
      new Proxy({}, { get: trap, ownKeys: trap }),
      new Date(),
      { v: undefined },
      { v: 1n },
      Object.create({ hidden: true }),
    ]) {
      expect(() => canonicalRepairJson(value)).toThrow("INVALID_REPAIR_INPUT");
    }
    expect(trap).not.toHaveBeenCalled();
  });
  it("rejects cycles, symbol keys, non-enumerable fields, sparse arrays and extra array properties", () => {
    const cycle: any = {};
    cycle.self = cycle;
    const symbol = { [Symbol("private")]: true };
    const hidden = Object.defineProperty({}, "secret", { value: "private" });
    const extra = [1] as any;
    extra.other = true;
    for (const value of [cycle, symbol, hidden, [, 1], extra])
      expect(() => canonicalRepairJson(value)).toThrow("INVALID_REPAIR_INPUT");
  });
  it("safe errors never echo private data or arbitrary error codes", () => {
    const f = createRepairFixture();
    f.plan.rows[0].candidate.candidate.etag = "PRIVATE_SECRET";
    try {
      repack(f.plan)();
      throw new Error("not rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(RepairError);
      expect(String(error)).not.toContain("PRIVATE_SECRET");
      expect(JSON.stringify(error)).not.toContain("PRIVATE_SECRET");
      expect((error as Error).cause).toBeUndefined();
    }
    expect(new RepairError("PRIVATE_SECRET" as any).code).toBe(
      "INVALID_REPAIR_INPUT"
    );
  });
});

describe("first-operator attestation only", () => {
  it("binds one declared assertion without fabricating historical identity, independent review or write authorization", () => {
    const { intent } = createRepairFixture();
    const a = createOperatorAttestation(intent, statement());
    expect(a).toMatchObject({
      sourceType: "order_payment",
      sourceId: 11280001,
      planSha256: intent.planSha256,
      planRunId: intent.planRunId,
      intentSha256: intent.intentSha256,
      targetFingerprint: intent.targetFingerprint,
      candidate: intent.candidate,
      sameTransactionConfirmed: true,
      assertionVerification: "OPERATOR_DECLARED_NOT_INDEPENDENTLY_VERIFIED",
      historicalByteIdentity: "UNPROVEN",
      independentReview: null,
      writeAuthorized: false,
    });
    expect(
      validateOperatorAttestation(JSON.parse(JSON.stringify(a)), intent)
    ).toEqual(a);
    expect(digestOperatorAttestation(a, intent)).toMatch(/^[a-f0-9]{64}$/);
    expect(
      digestOperatorAttestation(
        Object.fromEntries(Object.entries(a).reverse()) as any,
        intent
      )
    ).toBe(digestOperatorAttestation(a, intent));
  });
  it.each([
    ["wrong target", (a: any) => (a.sourceId = 11310001)],
    ["wrong source", (a: any) => (a.sourceType = "wallet_topup")],
    ["wrong plan", (a: any) => (a.planSha256 = "a".repeat(64))],
    ["wrong run", (a: any) => (a.planRunId = "other-private-run")],
    ["wrong intent", (a: any) => (a.intentSha256 = "a".repeat(64))],
    [
      "wrong target environment",
      (a: any) => (a.targetFingerprint = "a".repeat(64)),
    ],
    [
      "wrong object",
      (a: any) =>
        (a.candidate.key =
          "payment-slips/legacy/payments/11280001/1780000000000-other.jpg"),
    ],
    ["wrong ETag", (a: any) => (a.candidate.etag = '"otheretag"')],
    ["wrong hash", (a: any) => (a.candidate.rawHash = "a".repeat(64))],
    [
      "wrong canonical hash",
      (a: any) => (a.candidate.canonicalHash = "a".repeat(64)),
    ],
    ["wrong size", (a: any) => a.candidate.size++],
    [
      "fabricated second reviewer",
      (a: any) => (a.independentReview = { reviewer: "someone" }),
    ],
    ["false assertion", (a: any) => (a.sameTransactionConfirmed = false)],
    ["fabricated proof", (a: any) => (a.historicalByteIdentity = "PROVEN")],
    ["fabricated verifier", (a: any) => (a.assertionVerification = "VERIFIED")],
    ["write authorization", (a: any) => (a.writeAuthorized = true)],
    ["extra authority", (a: any) => (a.applyAuthorized = true)],
    ["no reviewer", (a: any) => (a.reviewer = "")],
    ["reviewer control char", (a: any) => (a.reviewer = "name\nprivate")],
    ["reviewer too long", (a: any) => (a.reviewer = "x".repeat(201))],
    ["empty reason", (a: any) => (a.reason = "")],
    ["untrimmed reason", (a: any) => (a.reason = " reason ")],
    ["long reason", (a: any) => (a.reason = "x".repeat(2001))],
    ["empty evidence reference", (a: any) => (a.evidenceReference = "")],
    [
      "long evidence reference",
      (a: any) => (a.evidenceReference = "x".repeat(2049)),
    ],
    ["noncanonical time", (a: any) => (a.recordedAt = "2026-09-05T13:00:00Z")],
    [
      "invalid calendar time",
      (a: any) => (a.recordedAt = "2026-02-30T13:00:00.000Z"),
    ],
  ] as Array<[string, (a: any) => void]>)("rejects %s", (_, change) => {
    const { intent, attestation } = createRepairFixture();
    change(attestation);
    expect(() => validateOperatorAttestation(attestation, intent)).toThrow(
      "INVALID_OPERATOR_ATTESTATION"
    );
  });
  it("does not accept extra private statement fields or caller-supplied authority", () => {
    const { intent } = createRepairFixture();
    expect(() =>
      createOperatorAttestation(intent, {
        ...statement(),
        writeAuthorized: true,
      } as any)
    ).toThrow("INVALID_OPERATOR_ATTESTATION");
    expect(() =>
      createOperatorAttestation(intent, {
        ...statement(),
        independentReview: "reviewer-two",
      } as any)
    ).toThrow("INVALID_OPERATOR_ATTESTATION");
  });
  it("parses bytes with duplicate-member and UTF8 checks before validating attestation", () => {
    const { intent, attestation } = createRepairFixture();
    const input = JSON.stringify(attestation);
    expect(parseOperatorAttestationBytes(Buffer.from(input), intent)).toEqual(
      attestation
    );
    const duplicate = input.replace(
      '"writeAuthorized":false',
      '"writeAuthorized":false,"writeAuthorized":false'
    );
    for (const bytes of [
      Buffer.from(duplicate),
      Buffer.from([0xff]),
      Buffer.alloc(64 * 1024 + 1),
    ])
      expect(() => parseOperatorAttestationBytes(bytes, intent)).toThrow(
        "INVALID_OPERATOR_ATTESTATION"
      );
  });
  it("changes the record digest when human review metadata changes", () => {
    const { intent, attestation } = createRepairFixture();
    const other = {
      ...attestation,
      reason: "Different private review explanation",
    };
    expect(digestOperatorAttestation(other, intent)).not.toBe(
      digestOperatorAttestation(attestation, intent)
    );
  });
});
