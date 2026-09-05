import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Connection } from "mysql2/promise";
import { createRepairFixture } from "./fixtures/legacySlipRepairFixtures";
import {
  canonicalRepairJson,
  createOperatorAttestation,
  digestRepairIntent,
  parseRepairPlan,
  type RepairIntent,
} from "../scripts/lib/legacySlipRepairContract";
import {
  digestRepairSecondReview,
  executeLegacySlipRepair,
  type RepairWriterInput,
} from "../scripts/lib/legacySlipRepairWriter";
import { relinkTargetFingerprint } from "../scripts/lib/legacySlipRelinkPlan";
import type { LegacySlipAuditEnvironment } from "../scripts/lib/legacySlipAuditOptions";

// Test-only pin replacement: production core has no pin/config bypass. This
// fixture is synthetic and never loads the operator's private plan or secrets.
const testPin = vi.hoisted(() => ({ sha: "" }));
vi.mock("../scripts/lib/legacySlipRepairContract", async importOriginal => ({
  ...(await importOriginal<
    typeof import("../scripts/lib/legacySlipRepairContract")
  >()),
  get PINNED_REPAIR_PLAN_SHA256() {
    return testPin.sha;
  },
}));

const NOW = Date.parse("2026-09-05T13:03:00.000Z");
const ISO = (offset: number) => new Date(NOW + offset).toISOString();
const CONFIG: LegacySlipAuditEnvironment = {
  db: {
    host: "z71vl8sxkolha3jf644qgsgr",
    port: 3306,
    user: "fixture",
    password: "FIXTURE_NOT_A_REAL_PASSWORD",
    database: "ipenovel",
    connectTimeout: 5000,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
  },
  r2: {
    endpoint: "https://fixture.r2.cloudflarestorage.com",
    region: "auto",
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
    bucket: "ipenovel-staging-private",
  },
};
const TABLES = [
  "payments",
  "orders",
  "accountMutationGuards",
  "users",
  "accountMergeCases",
  "paymentSlipClaims",
  "slipEvidenceBindings",
  "slipEvidenceUploads",
  "paymentSlipLegacyUnknown",
  "paymentSlipLegacyCollisions",
  "walletTopups",
  "legacySlipReferenceRepairAudit",
];
const AUDIT_COLS = [
  "id",
  "sourceType",
  "sourceId",
  "intentSha256",
  "operationId",
  "planSha256",
  "planRunId",
  "targetFingerprint",
  "operatorAttestationSha256",
  "secondReviewSha256",
  "authorizationSha256",
  "beforeSnapshot",
  "afterSnapshot",
  "createdAt",
];

function inputFixture(
  changePlan?: (plan: ReturnType<typeof createRepairFixture>["plan"]) => void
): RepairWriterInput & { intent: RepairIntent } {
  const { plan } = createRepairFixture();
  plan.targetFingerprint = relinkTargetFingerprint(CONFIG);
  changePlan?.(plan);
  const planBytes = Buffer.from(JSON.stringify(plan));
  testPin.sha = createHash("sha256").update(planBytes).digest("hex");
  const intent = parseRepairPlan(planBytes, testPin.sha);
  const attestation = createOperatorAttestation(intent, {
    reviewer: "fixture-primary",
    reason:
      "Operator confirmed this mapping using private supporting evidence.",
    evidenceReference: "private-fixture-evidence",
    recordedAt: ISO(-120000),
  });
  const bytes = Buffer.from(JSON.stringify(attestation));
  const primarySha = createHash("sha256").update(bytes).digest("hex");
  const secondReview = {
    schema: "legacy-slip-independent-review/v1",
    reviewer: "fixture-independent",
    reviewedAt: ISO(-60000),
    intentSha256: intent.intentSha256,
    operatorAttestationSha256: primarySha,
    mappingConfirmed: true,
  } as const;
  return {
    intent,
    planBytes,
    operatorAttestationBytes: bytes,
    secondReview,
    authorization: {
      schema: "legacy-slip-live-authorization/v1",
      operationId: "e29c22d0-5973-4195-8859-f658cb70dd26",
      authorizedBy: "fixture-authorizer",
      authorizedAt: ISO(-30000),
      expiresAt: ISO(120000),
      intentSha256: intent.intentSha256,
      operatorAttestationSha256: primarySha,
      secondReviewSha256: digestRepairSecondReview(secondReview),
      applyAuthorized: true,
      maintenance: {
        assertionId: "fixture-freeze-confirmation",
        assertedBy: "fixture-maintainer",
        assertedAt: ISO(-20000),
        expiresAt: ISO(120000),
        scope:
          "ALL_PAYMENT_ORDER_ACCOUNT_MERGE_EVIDENCE_AND_R2_WRITERS_STOPPED",
      },
    },
    preflight: {
      intentSha256: intent.intentSha256,
      targetFingerprint: intent.targetFingerprint,
      checkedAt: ISO(-1000),
      expiresAt: ISO(50000),
      candidate: structuredClone(intent.candidate),
      allCrossReferencesClear: true,
    },
  };
}
type Controls = {
  missingGuard?: boolean;
  guarded?: boolean;
  missingUser?: boolean;
  merge?: string;
  casRows?: number;
  auditFailure?: boolean;
  auditWarning?: boolean;
  auditCorrupt?: boolean;
  afterDrift?: boolean;
  commitFailure?: boolean;
  commitAbsent?: boolean;
  rollbackFailure?: boolean;
  tablesMissing?: boolean;
  badIndex?: boolean;
  snapshotTooShort?: boolean;
  trigger?: boolean;
  crossConflict?: boolean;
  connectFailure?: boolean;
  failQuery?: string;
};
function harness(input = inputFixture(), controls: Controls = {}) {
  let state = structuredClone(input.intent.before);
  let saved = structuredClone(state);
  let audit: Record<string, unknown> | undefined;
  let savedAudit: Record<string, unknown> | undefined;
  const calls: Array<{ sql: string; values: any[]; timeout: number }> = [];
  const connections: Array<{ query: any; destroy: any }> = [];
  const connect = vi.fn(async (config: any) => {
    if (controls.connectFailure) throw new Error("PRIVATE_DATABASE_PASSWORD");
    expect(config).toMatchObject({
      connectTimeout: 5000,
      dateStrings: true,
      decimalNumbers: false,
      multipleStatements: false,
    });
    const connection = {
      destroy: vi.fn(),
      query: vi.fn(
        async (options: { sql: string; values?: any[]; timeout: number }) => {
          const { sql, timeout } = options;
          const values = options.values ?? [];
          calls.push({ sql, values, timeout });
          if (controls.failQuery && sql.includes(controls.failQuery))
            throw new Error("PRIVATE_DATABASE_PASSWORD");
          let result: any = [];
          if (sql.includes("information_schema.tables"))
            result = controls.tablesMissing
              ? []
              : TABLES.map(name => ({
                  name,
                  engine: "InnoDB",
                  comment:
                    name === "legacySlipReferenceRepairAudit"
                      ? "legacy-slip-reference-repair-audit/v1"
                      : "",
                }));
          else if (sql.includes("information_schema.statistics"))
            result = controls.badIndex
              ? []
              : [
                  ["uq_legacy_repair_source", ["sourceType", "sourceId"]],
                  ["uq_legacy_repair_intent", ["intentSha256"]],
                  ["uq_legacy_repair_operation", ["operationId"]],
                ].flatMap(([name, columns]) =>
                  (columns as string[]).map((columnName, i) => ({
                    name,
                    nonUnique: 0,
                    position: i + 1,
                    columnName,
                    subPart: null,
                  }))
                );
          else if (sql.includes("information_schema.columns"))
            result = AUDIT_COLS.map(name => ({
              name,
              dataType: controls.snapshotTooShort ? "varchar" : "longtext",
              nullable: "NO",
            }));
          else if (sql.includes("information_schema.triggers"))
            result = controls.trigger ? [{ name: "unreviewed" }] : [];
          else if (sql === "START TRANSACTION") {
            saved = structuredClone(state);
            savedAudit = audit && structuredClone(audit);
            result = {};
          } else if (sql === "ROLLBACK") {
            if (controls.rollbackFailure)
              throw new Error("rollback-private-error");
            state = saved;
            audit = savedAudit;
            result = {};
          } else if (sql === "COMMIT") {
            if (controls.commitFailure) {
              if (controls.commitAbsent) {
                state = saved;
                audit = savedAudit;
              }
              throw new Error("commit-private-error");
            }
            result = {};
          } else if (sql.startsWith("SET SESSION")) result = {};
          else if (sql.includes("FROM accountMutationGuards"))
            result = controls.missingGuard
              ? []
              : [
                  {
                    userId: 3001,
                    generation: 0,
                    mergeState: controls.guarded ? "merge_guarded" : "open",
                    activeMergeCaseId: null,
                  },
                ];
          else if (sql.includes("FROM users"))
            result = controls.missingUser ? [] : [{ id: 3001 }];
          else if (sql.includes("FROM accountMergeCases"))
            result = controls.merge
              ? [{ id: 1, sourceUserId: 3001, status: controls.merge }]
              : [];
          else if (sql.startsWith("SELECT id FROM payments"))
            result = [{ id: 11280001 }];
          else if (sql.includes("FROM legacySlipReferenceRepairAudit"))
            result = audit
              ? [
                  {
                    ...audit,
                    ...(controls.auditCorrupt
                      ? { intentSha256: "truncated" }
                      : {}),
                  },
                ]
              : [];
          else if (sql.includes("FROM payments p"))
            result = [{ ...state.record, ownerUserId: state.order!.userId }];
          else if (sql.includes("FROM orders WHERE"))
            result = [{ ...state.order }];
          else if (
            sql.includes("FROM paymentSlipLegacyUnknown") &&
            sql.includes("sourceType = ?")
          )
            result = structuredClone(state.related.unknowns);
          else if (
            sql.includes("FROM paymentSlipClaims") &&
            sql.includes("sourceType = ?")
          )
            result = structuredClone(state.related.claims);
          else if (
            sql.includes("FROM slipEvidenceBindings") &&
            sql.includes("sourceType = ?")
          )
            result = structuredClone(state.related.bindings);
          else if (
            sql.includes("FROM paymentSlipLegacyCollisions") &&
            sql.includes("sourceType = ?")
          )
            result = structuredClone(state.related.collisions);
          else if (
            sql.includes("FROM payments WHERE BINARY") &&
            controls.crossConflict
          )
            result = [
              {
                id: 9,
                sourceType: "order_payment",
                slipImageUrl: `r2p:${input.intent.candidate.key}`,
                status: "approved",
                evidenceVersion: 0,
                slipEvidenceClass: "legacy_compatibility_required",
                slipEvidenceId: null,
              },
            ];
          else if (sql.startsWith("UPDATE payments")) {
            if ((controls.casRows ?? 1) === 1) {
              state.record.slipImageUrl = values[0];
              state.source.slipImageUrl = values[0];
              state.record.updatedAt = "2026-09-05 13:03:00.000000";
              if (controls.afterDrift) state.record.status = "rejected";
            }
            result = { affectedRows: controls.casRows ?? 1 };
          } else if (
            sql.startsWith("INSERT INTO legacySlipReferenceRepairAudit")
          ) {
            if (controls.auditFailure)
              throw new Error("ER_DUP_ENTRY private-detail");
            audit = Object.fromEntries(
              AUDIT_COLS.slice(1, -1).map((key, i) => [key, values[i]])
            );
            audit.id = 1;
            audit.createdAt = "2026-09-05 13:03:00.000000";
            result = {
              affectedRows: 1,
              warningStatus: controls.auditWarning ? 1 : 0,
            };
          }
          return [result, []];
        }
      ),
    };
    connections.push(connection);
    return connection as unknown as Connection;
  });
  return {
    input,
    controls,
    calls,
    connect,
    connections,
    get state() {
      return state;
    },
    get audit() {
      return audit;
    },
    setAudit(row: Record<string, unknown>) {
      audit = row;
    },
    run: (now = () => NOW, monotonicNow = () => 0) =>
      executeLegacySlipRepair(input, CONFIG, { connect, now, monotonicNow }),
  };
}

describe("future single-payment guarded writer (fake connections only)", () => {
  it("commits exactly one binary URL CAS and one durable private audit, preserving all other state", async () => {
    const h = harness();
    expect(await h.run()).toEqual({
      status: "APPLIED",
      code: "REFERENCE_AND_PRIVATE_AUDIT_COMMITTED",
    });
    const updates = h.calls.filter(c => c.sql.startsWith("UPDATE"));
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toMatch(
      /^UPDATE payments SET slipImageUrl = \? WHERE/
    );
    expect(updates[0].sql).toContain("BINARY slipImageUrl = BINARY ?");
    expect(updates[0].values).toEqual([
      `r2p:${h.input.intent.candidate.key}`,
      11280001,
      h.input.intent.before.record.orderId,
      h.input.intent.before.record.slipImageUrl,
    ]);
    expect(h.calls.filter(c => c.sql.startsWith("INSERT"))).toHaveLength(1);
    expect(h.audit!.beforeSnapshot).toBe(
      canonicalRepairJson(h.input.intent.before)
    );
    expect(h.audit!.afterSnapshot).toBe(canonicalRepairJson(h.state));
    expect(h.calls.every(c => c.timeout === 5000)).toBe(true);
    expect(h.connections[0].destroy).toHaveBeenCalledOnce();
  });
  it("acquires account guard SHARE, user SHARE, merge SHARE, payment UPDATE in hierarchy before all current reads", async () => {
    const h = harness();
    await h.run();
    const locks = h.calls
      .filter(c => /FOR UPDATE|LOCK IN SHARE MODE/.test(c.sql))
      .map(c => c.sql);
    expect(locks.slice(0, 4)).toEqual([
      expect.stringMatching(/FROM accountMutationGuards.+LOCK IN SHARE MODE$/),
      expect.stringMatching(/FROM users.+LOCK IN SHARE MODE$/),
      expect.stringMatching(/FROM accountMergeCases.+LOCK IN SHARE MODE$/),
      "SELECT id FROM payments WHERE id = ? FOR UPDATE",
    ]);
    const first = h.calls.findIndex(c => c.sql === "START TRANSACTION");
    expect(
      h.calls
        .slice(first + 1)
        .filter(c => c.sql.startsWith("SELECT"))
        .every(c => /FOR UPDATE$|LOCK IN SHARE MODE$/.test(c.sql))
    ).toBe(true);
  });
  it("exact same intent retry verifies stored audit and after-image without another update or insert", async () => {
    const h = harness();
    await h.run();
    expect((await h.run()).status).toBe("ALREADY_APPLIED");
    expect(h.calls.filter(c => /^UPDATE|^INSERT/.test(c.sql))).toHaveLength(2);
  });
  it("URL already changed without durable audit is drift, not successful idempotency", async () => {
    const h = harness();
    h.state.record.slipImageUrl = `r2p:${h.input.intent.candidate.key}`;
    expect((await h.run()).code).toBe("SOURCE_DRIFT");
    expect(h.calls.some(c => c.sql.startsWith("UPDATE"))).toBe(false);
  });
  it("conflicting durable audit blocks", async () => {
    const h = harness();
    h.setAudit({ intentSha256: "foreign-intent" });
    expect(await h.run()).toEqual({
      status: "ROLLED_BACK",
      code: "AUDIT_CONFLICT",
    });
  });
  it("same-intent retry with changed after-state blocks instead of returning already applied", async () => {
    const h = harness();
    await h.run();
    h.state.order!.totalAmount = "101.00";
    expect((await h.run()).code).toBe("AUDIT_CONFLICT");
    expect(h.calls.filter(c => c.sql.startsWith("UPDATE"))).toHaveLength(1);
  });
  for (const control of ["missingGuard", "guarded", "missingUser"] as const)
    it(`fails ${control} without lazy provisioning or mutation`, async () => {
      const h = harness(inputFixture(), { [control]: true });
      expect(await h.run()).toEqual({
        status: "ROLLED_BACK",
        code: "ACCOUNT_GUARD_BLOCKED",
      });
      expect(h.calls.some(c => /^UPDATE|^INSERT/.test(c.sql))).toBe(false);
    });
  for (const merge of ["prepared", "completed", "unknown", "running"])
    it(`blocks merge status ${merge}`, async () => {
      const h = harness(inputFixture(), { merge });
      expect((await h.run()).code).toBe("ACCOUNT_GUARD_BLOCKED");
    });
  it("permits released cancelled merge", async () => {
    expect(
      (await harness(inputFixture(), { merge: "cancelled" }).run()).status
    ).toBe("APPLIED");
  });
  for (const control of [
    "tablesMissing",
    "badIndex",
    "snapshotTooShort",
    "trigger",
  ] as const)
    it(`rejects ${control} before transaction`, async () => {
      const h = harness(inputFixture(), { [control]: true });
      expect((await h.run()).status).toBe("BLOCKED");
      expect(h.calls.some(c => c.sql === "START TRANSACTION")).toBe(false);
    });
  for (const section of ["record", "order"] as const) {
    for (const field of Object.keys(inputFixture().intent.before[section]!))
      it(`blocks current ${section}.${field} drift`, async () => {
        const h = harness();
        const row = h.state[section]!;
        const current = row[field];
        row[field] =
          typeof current === "number"
            ? current + 1
            : current === null
              ? "changed"
              : typeof current === "string" && /^\d{4}-/.test(current)
                ? current.replace("09:18", "09:19")
                : `${current}x`;
        expect((await h.run()).status).toBe("ROLLED_BACK");
        expect(h.calls.some(c => c.sql.startsWith("UPDATE"))).toBe(false);
      });
  }
  it("preserves preexisting unknown entries and rejects changed unknowns", async () => {
    const h = harness();
    h.state.related.unknowns.push({
      id: 1,
      sourceType: "order_payment",
      sourceId: 11280001,
      reason: "changed",
      recordedAt: "2026-09-05 09:18:15",
    });
    expect((await h.run()).code).toBe("SOURCE_DRIFT");
  });
  it("preserves an existing unknown row exactly through successful reference repair", async () => {
    const input = inputFixture(plan => {
      const unknown = {
        id: 3,
        sourceType: "order_payment",
        sourceId: 11280001,
        reason: "permanent:no_slip_image_url",
        recordedAt: "2026-09-05 09:18:15",
      };
      plan.rows[0].snapshot.before.related.unknowns.push(unknown);
      plan.rows[0].snapshot.after.related.unknowns.push({ ...unknown });
    });
    const h = harness(input);
    expect((await h.run()).status).toBe("APPLIED");
    expect(h.state.related.unknowns).toEqual(
      input.intent.before.related.unknowns
    );
    expect(h.calls.filter(c => /^UPDATE|^INSERT/.test(c.sql))).toHaveLength(2);
  });
  it("blocks current global reference conflicts", async () => {
    expect(
      (await harness(inputFixture(), { crossConflict: true }).run()).code
    ).toBe("CROSS_REFERENCE_CONFLICT");
  });
  for (const casRows of [0, 2])
    it(`rolls back unexpected CAS row count ${casRows}`, async () => {
      expect((await harness(inputFixture(), { casRows }).run()).code).toBe(
        "COMPARE_AND_SWAP_FAILED"
      );
    });
  for (const control of [
    "auditFailure",
    "auditWarning",
    "auditCorrupt",
    "afterDrift",
  ] as const)
    it(`rolls back URL on ${control}`, async () => {
      const h = harness(inputFixture(), { [control]: true });
      expect((await h.run()).status).toBe("ROLLED_BACK");
      expect(h.state).toEqual(h.input.intent.before);
      expect(h.audit).toBeUndefined();
      expect(h.calls.some(c => c.sql === "COMMIT")).toBe(false);
    });
  it("commit network failure remains UNKNOWN but fresh connection can reconcile exact audit+state", async () => {
    const h = harness(inputFixture(), { commitFailure: true });
    expect(await h.run()).toEqual({
      status: "UNKNOWN",
      code: "COMMIT_OUTCOME_UNKNOWN",
      reconciliation: "MATCHING_AUDIT_AND_STATE",
    });
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.calls.some(c => c.sql === "ROLLBACK")).toBe(false);
    expect(h.calls.filter(c => c.sql.startsWith("UPDATE"))).toHaveLength(1);
  });
  it("no audit after uncertain commit does not claim rollback or retry", async () => {
    const h = harness(inputFixture(), {
      commitFailure: true,
      commitAbsent: true,
    });
    expect(await h.run()).toEqual({
      status: "UNKNOWN",
      code: "COMMIT_OUTCOME_UNKNOWN",
      reconciliation: "NO_COMMIT_EVIDENCE",
    });
    expect(h.calls.filter(c => c.sql.startsWith("UPDATE"))).toHaveLength(1);
  });
  it("rollback failure remains UNKNOWN", async () => {
    expect(
      await harness(inputFixture(), {
        auditFailure: true,
        rollbackFailure: true,
      }).run()
    ).toEqual({ status: "UNKNOWN", code: "ROLLBACK_NOT_CONFIRMED" });
  });
  it("expired transaction budget rolls back without racing abandoned DB work", async () => {
    const h = harness();
    let ticks = 0;
    expect(
      (
        await h.run(
          () => NOW,
          () => ticks++ * 15000
        )
      ).code
    ).toBe("TRANSACTION_BUDGET_EXCEEDED");
  });
  for (const mutate of [
    (i: RepairWriterInput) => {
      i.authorization.applyAuthorized = false as true;
    },
    (i: RepairWriterInput) => {
      i.secondReview.reviewer = "fixture-primary";
    },
    (i: RepairWriterInput) => {
      i.authorization.secondReviewSha256 = "a".repeat(64);
    },
    (i: RepairWriterInput) => {
      i.authorization.operatorAttestationSha256 = "a".repeat(64);
    },
    (i: RepairWriterInput) => {
      i.authorization.expiresAt = ISO(-1);
    },
    (i: RepairWriterInput) => {
      i.authorization.maintenance.expiresAt = ISO(-1);
    },
    (i: RepairWriterInput) => {
      i.preflight.expiresAt = ISO(-1);
    },
    (i: RepairWriterInput) => {
      i.preflight.candidate.etag = '"changed"';
    },
    (i: RepairWriterInput) => {
      i.preflight.allCrossReferencesClear = false as true;
    },
    (i: RepairWriterInput) => {
      i.authorization.maintenance.scope = "PARTIAL_FREEZE" as any;
    },
  ])
    it("rejects invalid or stale authorization before any connection", async () => {
      const h = harness();
      mutate(h.input);
      expect((await h.run()).status).toBe("BLOCKED");
      expect(h.connect).not.toHaveBeenCalled();
    });
  it("pins actual plan digest even if alternate synthetic intent is internally coherent", async () => {
    const h = harness();
    h.input.intent.planSha256 = "a".repeat(64);
    const { intentSha256: _, ...base } = h.input.intent;
    h.input.intent.intentSha256 = digestRepairIntent(base);
    expect((await h.run()).code).toBe("PINNED_PLAN_INTENT_MISMATCH");
    expect(h.connect).not.toHaveBeenCalled();
  });
  it("rejects a rehashed forged candidate while retaining the correct pinned plan label", async () => {
    const h = harness();
    h.input.intent.candidate.key =
      "payment-slips/legacy/payments/11280001/1780000000000-forged.jpg";
    const { intentSha256: _, ...base } = h.input.intent;
    h.input.intent.intentSha256 = digestRepairIntent(base);
    expect((await h.run()).code).toBe("PINNED_PLAN_INTENT_MISMATCH");
    expect(h.connect).not.toHaveBeenCalled();
  });
  it("rejects modified plan bytes even with coherent supplied intent", async () => {
    const h = harness();
    const altered = JSON.parse(Buffer.from(h.input.planBytes).toString());
    altered.declaredCodeSha = "d".repeat(40);
    h.input.planBytes = Buffer.from(JSON.stringify(altered));
    expect((await h.run()).status).toBe("BLOCKED");
    expect(h.connect).not.toHaveBeenCalled();
  });
  it("does not execute accessors in private input", async () => {
    const h = harness();
    const getter = vi.fn();
    Object.defineProperty(h.input.authorization, "authorizedBy", {
      get: getter,
    });
    expect((await h.run()).status).toBe("BLOCKED");
    expect(getter).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
  });
  it("rejects duplicate private attestation JSON members", async () => {
    const h = harness();
    const original = Buffer.from(h.input.operatorAttestationBytes).toString();
    h.input.operatorAttestationBytes = Buffer.from(
      original.replace("{", '{"sameTransactionConfirmed":false,')
    );
    expect((await h.run()).status).toBe("BLOCKED");
    expect(h.connect).not.toHaveBeenCalled();
  });
  it("never reveals private raw database errors", async () => {
    const h = harness(inputFixture(), { connectFailure: true });
    expect(JSON.stringify(await h.run())).not.toMatch(
      /PASSWORD|fixture|cloudfront|payment-slips/
    );
  });
  it("keeps DDL manual and never issues DDL during execution", async () => {
    const ddl = readFileSync(
      new URL(
        "../scripts/manual/legacy-slip-reference-repair-audit.sql",
        import.meta.url
      ),
      "utf8"
    );
    expect(ddl).toContain("MANUAL FUTURE LIVE PREREQUISITE ONLY");
    expect(ddl).toContain("ENGINE=InnoDB");
    expect(ddl).toContain(
      "UNIQUE KEY uq_legacy_repair_source (sourceType, sourceId)"
    );
    const h = harness();
    await h.run();
    expect(h.calls.some(c => /^(CREATE|ALTER|DROP|DELETE)/.test(c.sql))).toBe(
      false
    );
  });
});
