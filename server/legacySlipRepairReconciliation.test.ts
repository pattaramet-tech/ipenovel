import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Connection } from "mysql2/promise";
import { createRepairFixture } from "./fixtures/legacySlipRepairFixtures";
import {
  canonicalRepairJson,
  createOperatorAttestation,
  parseRepairPlan,
  type RepairIntent,
} from "../scripts/lib/legacySlipRepairContract";
import { validateLegacySlipAuditEnvironment } from "../scripts/lib/legacySlipAuditOptions";
import { relinkTargetFingerprint } from "../scripts/lib/legacySlipRelinkPlan";
import {
  digestRepairSecondReview,
  validateRepairAuthority,
  validateRepairAuthorityRecords,
  type RepairAuthorityInput,
} from "../scripts/lib/legacySlipRepairWriter";
import { reconcileLegacySlipRepair } from "../scripts/lib/legacySlipRepairReconciliation";

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
const digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const encoded = (v: unknown) => Buffer.from(JSON.stringify(v));
const CONFIG = validateLegacySlipAuditEnvironment({
  DATABASE_URL:
    "mysql://fixture:PRIVATE_FIXTURE_PASSWORD@z71vl8sxkolha3jf644qgsgr:3306/ipenovel",
  R2_PRIVATE_ACCOUNT_ID: "fixture",
  R2_PRIVATE_ENDPOINT: "https://fixture.r2.cloudflarestorage.com",
  R2_PRIVATE_BUCKET_NAME: "ipenovel-staging-private",
  R2_PRIVATE_ACCESS_KEY_ID: "fixture",
  R2_PRIVATE_SECRET_ACCESS_KEY: "PRIVATE_FIXTURE_R2_SECRET",
});
const TABLES = [
  "payments",
  "orders",
  "paymentSlipClaims",
  "slipEvidenceBindings",
  "paymentSlipLegacyUnknown",
  "paymentSlipLegacyCollisions",
  "legacySlipReferenceRepairAudit",
];
const AUDIT_TABLE = "legacySlipReferenceRepairAudit";

function fixture() {
  const { plan } = createRepairFixture();
  plan.targetFingerprint = relinkTargetFingerprint(CONFIG);
  const planBytes = encoded(plan);
  pin.sha = digest(planBytes);
  const intent = parseRepairPlan(planBytes, pin.sha);
  const operatorAttestationBytes = encoded(
    createOperatorAttestation(intent, {
      reviewer: "PRIVATE_FIXTURE_PRIMARY",
      reason: "Private synthetic transaction mapping.",
      evidenceReference: "PRIVATE_FIXTURE_REVIEW_RECORD",
      recordedAt: iso(-120000),
    })
  );
  const secondReview: RepairAuthorityInput["secondReview"] = {
    schema: "legacy-slip-independent-review/v1",
    reviewer: "PRIVATE_FIXTURE_SECOND",
    reviewedAt: iso(-60000),
    intentSha256: intent.intentSha256,
    operatorAttestationSha256: digest(operatorAttestationBytes),
    mappingConfirmed: true,
  };
  const input: RepairAuthorityInput & { intent: RepairIntent } = {
    intent,
    planBytes,
    operatorAttestationBytes,
    secondReview,
    authorization: {
      schema: "legacy-slip-live-authorization/v1",
      operationId: "be24b88a-18db-499c-8da6-39d2767fc6bb",
      authorizedBy: "PRIVATE_FIXTURE_AUTHORIZER",
      authorizedAt: iso(-30000),
      expiresAt: iso(60000),
      intentSha256: intent.intentSha256,
      operatorAttestationSha256: digest(operatorAttestationBytes),
      secondReviewSha256: digestRepairSecondReview(secondReview),
      applyAuthorized: true,
      maintenance: {
        assertionId: "PRIVATE_FIXTURE_FREEZE",
        assertedBy: "PRIVATE_FIXTURE_MAINTAINER",
        assertedAt: iso(-10000),
        expiresAt: iso(60000),
        scope:
          "ALL_PAYMENT_ORDER_ACCOUNT_MERGE_EVIDENCE_AND_R2_WRITERS_STOPPED",
      },
    },
  };
  return input;
}

function setup() {
  const input = fixture();
  const records = validateRepairAuthorityRecords(input, CONFIG);
  let state: typeof input.intent.before | null = structuredClone(
    input.intent.before
  );
  state.source.slipImageUrl = `r2p:${input.intent.candidate.key}`;
  state.record.slipImageUrl = state.source.slipImageUrl;
  state.record.updatedAt = "2026-09-06 10:00:10.000000";
  const audit: Record<string, unknown> = {
    sourceType: "order_payment",
    sourceId: 11280001,
    intentSha256: input.intent.intentSha256,
    operationId: input.authorization.operationId,
    planSha256: input.intent.planSha256,
    planRunId: input.intent.planRunId,
    targetFingerprint: input.intent.targetFingerprint,
    operatorAttestationSha256: records.primarySha,
    secondReviewSha256: records.secondSha,
    authorizationSha256: records.authSha,
    beforeSnapshot: canonicalRepairJson(input.intent.before),
    afterSnapshot: canonicalRepairJson(state),
  };
  const controls = {
    auditRows: [audit] as unknown[],
    tables: TABLES.map(name => ({
      name,
      engine: "InnoDB",
      comment:
        name === AUDIT_TABLE ? "legacy-slip-reference-repair-audit/v1" : "",
    })),
    connectFailure: false,
    failQuery: "",
    rollbackFailure: false,
    destroyFailure: false,
    onQuery: undefined as undefined | ((sql: string) => void),
  };
  const calls: Array<{ sql: string; values: unknown[]; timeout: number }> = [];
  let elapsed = 0;
  const connection = {
    destroy: vi.fn(() => {
      if (controls.destroyFailure) throw new Error("PRIVATE_FIXTURE_DESTROY");
    }),
    query: vi.fn(
      async (options: { sql: string; values?: unknown[]; timeout: number }) => {
        const { sql, timeout } = options;
        const values = options.values ?? [];
        calls.push({ sql, values, timeout });
        controls.onQuery?.(sql);
        if (controls.failQuery && sql.includes(controls.failQuery))
          throw new Error("PRIVATE_FIXTURE_QUERY");
        let result: unknown;
        if (sql === "ROLLBACK") {
          if (controls.rollbackFailure)
            throw new Error("PRIVATE_FIXTURE_ROLLBACK");
          result = {};
        } else if (
          sql.startsWith("SET SESSION") ||
          sql.startsWith("START TRANSACTION")
        )
          result = {};
        else if (sql.includes("FROM legacySlipReferenceRepairAudit"))
          result = structuredClone(controls.auditRows);
        else if (sql.includes("FROM payments p"))
          result = state
            ? [{ ...state.record, ownerUserId: state.order?.userId ?? null }]
            : [];
        else if (sql.includes("FROM orders WHERE"))
          result = state?.order ? [{ ...state.order }] : [];
        else if (sql.includes("FROM paymentSlipClaims"))
          result = structuredClone(state?.related.claims ?? []);
        else if (sql.includes("FROM slipEvidenceBindings"))
          result = structuredClone(state?.related.bindings ?? []);
        else if (sql.includes("FROM paymentSlipLegacyUnknown"))
          result = structuredClone(state?.related.unknowns ?? []);
        else if (sql.includes("FROM paymentSlipLegacyCollisions"))
          result = structuredClone(state?.related.collisions ?? []);
        else if (sql.includes("information_schema.tables"))
          result = structuredClone(controls.tables);
        else throw new Error("Unexpected query in synthetic readonly fixture");
        return [result, []];
      }
    ),
  };
  const connect = vi.fn(async () => {
    if (controls.connectFailure) throw new Error("PRIVATE_FIXTURE_CONNECT");
    return connection as unknown as Connection;
  });
  const dependencies = { connect, monotonicNow: () => elapsed };
  return {
    input,
    audit,
    controls,
    connection,
    calls,
    connect,
    dependencies,
    get state() {
      return state!;
    },
    set state(value) {
      state = value;
    },
    missingState: () => {
      state = null;
    },
    advance: (ms: number) => {
      elapsed += ms;
    },
    run: () => reconcileLegacySlipRepair(input, CONFIG, dependencies),
  };
}

describe("standalone readonly repair reconciliation", () => {
  it("accepts exact retained expired context without renewing write authority", async () => {
    const s = setup();
    expect(() =>
      validateRepairAuthority(s.input, CONFIG, () => NOW + 86400000)
    ).toThrow("AUTHORIZATION_OR_PREFLIGHT_EXPIRED");
    expect(await s.run()).toEqual({
      status: "MATCHING_AUDIT_AND_STATE",
      code: "EXACT_COMMIT_EVIDENCE_AT_READ_SNAPSHOT",
    });
    expect(s.input.authorization.expiresAt).toBe(iso(60000));
    expect(s.connect).toHaveBeenCalledTimes(1);
  });
  it("uses a single repeatable readonly consistent snapshot and releases it", async () => {
    const s = setup();
    await s.run();
    expect(s.calls[0].sql).toBe(
      "SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ"
    );
    expect(s.calls[1].sql).toBe(
      "START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT"
    );
    expect(s.calls.at(-1)!.sql).toBe("ROLLBACK");
    for (const q of s.calls) {
      expect(q.sql).toMatch(
        /^(SELECT |SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ$|START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT$|ROLLBACK$)/
      );
      expect(q.sql).not.toMatch(
        /FOR UPDATE|LOCK IN SHARE MODE|^(UPDATE|INSERT|DELETE|DROP|ALTER|CREATE|TRUNCATE|COMMIT)\b/
      );
      expect(q.timeout).toBe(5000);
    }
    expect(s.connection.destroy).toHaveBeenCalledTimes(1);
    const queried = s.calls.filter(q => q.sql.startsWith("SELECT"));
    expect(
      queried.find(q => q.sql.includes("FROM legacySlipReferenceRepairAudit"))!
        .values
    ).toEqual(["order_payment", 11280001]);
    expect(
      queried.find(q => q.sql.includes("FROM payments p"))!.values
    ).toEqual([11280001]);
  });
  it("audit absence reports evidence absence only, not retry/rollback authority", async () => {
    const s = setup();
    s.controls.auditRows = [];
    expect(await s.run()).toEqual({
      status: "NO_COMMIT_EVIDENCE",
      code: "AUDIT_ABSENT_NOT_RETRY_AUTHORIZATION",
    });
    expect(s.connect).toHaveBeenCalledTimes(1);
    expect(s.connection.destroy).toHaveBeenCalledTimes(1);
  });
  it("accepts stringified DB source id without changing exact identity", async () => {
    const s = setup();
    s.audit.sourceId = "11280001";
    expect((await s.run()).status).toBe("MATCHING_AUDIT_AND_STATE");
  });
  it.each([
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
  ])("rejects changed audit binding %s", async key => {
    const s = setup();
    s.audit[key] = "PRIVATE_FIXTURE_TAMPER";
    expect((await s.run()).status).toBe("CONFLICT");
  });
  it("requires exact original authorization digest, not a newly issued grant for same intent", async () => {
    const s = setup();
    s.input.authorization.authorizedAt = iso(-25000);
    expect(validateRepairAuthorityRecords(s.input, CONFIG).authSha).not.toBe(
      s.audit.authorizationSha256
    );
    expect((await s.run()).status).toBe("CONFLICT");
  });
  it.each([null, {}, [null], [{ bad: true }, { bad: true }]])(
    "malformed/duplicate audit collection fails without a write %j",
    async rows => {
      const s = setup();
      s.controls.auditRows = rows as any;
      expect(["CONFLICT", "UNKNOWN"]).toContain((await s.run()).status);
      expect(s.connection.destroy).toHaveBeenCalledTimes(1);
    }
  );
  it.each([
    "status",
    "slipImageUrl",
    "reviewReason",
    "approvedByLabel",
    "updatedAt",
  ])("rejects changed source field %s", async field => {
    const s = setup();
    s.state.record[field] =
      field === "updatedAt"
        ? "2026-09-06 11:00:00.000000"
        : "PRIVATE_FIXTURE_CHANGE";
    expect((await s.run()).status).toBe("CONFLICT");
  });
  it.each([
    "totalAmount",
    "discountAmount",
    "status",
    "paymentStatus",
    "notes",
    "userId",
  ])(
    "rejects changed order %s even with a matching altered audit after image",
    async field => {
      const s = setup();
      s.state.order![field] = field.endsWith("Amount")
        ? "999.00"
        : field === "userId"
          ? 4001
          : "PRIVATE_FIXTURE_CHANGE";
      if (field === "userId") s.state.source.ownerUserId = 4001;
      s.audit.afterSnapshot = canonicalRepairJson(s.state);
      expect((await s.run()).status).toBe("CONFLICT");
    }
  );
  it("missing current source conflicts with an existing audit", async () => {
    const s = setup();
    s.missingState();
    expect((await s.run()).status).toBe("CONFLICT");
  });
  it("related unknown drift remains conflict, never clears registry", async () => {
    const s = setup();
    s.state.related.unknowns.push({
      id: 42,
      sourceType: "order_payment",
      sourceId: 11280001,
      reason: "PRIVATE_FIXTURE_UNKNOWN",
      recordedAt: "2026-09-06 10:00:00",
    });
    s.audit.afterSnapshot = canonicalRepairJson(s.state);
    expect((await s.run()).status).toBe("CONFLICT");
  });
  it("truncated current related coverage cannot be reported as verified", async () => {
    const s = setup();
    s.state.related.unknowns = Array.from({ length: 21 }, (_, i) => ({
      id: i + 1,
      sourceType: "order_payment",
      sourceId: 11280001,
      reason: "fixture",
      recordedAt: "2026-09-06 10:00:00",
    }));
    expect((await s.run()).status).toBe("CONFLICT");
  });
  it.each(["absent", "wrong-engine", "wrong-marker", "duplicate"])(
    "unverified metadata %s yields UNKNOWN not match",
    async kind => {
      const s = setup();
      if (kind === "absent") s.controls.tables = [];
      else if (kind === "wrong-engine") s.controls.tables[0].engine = "MyISAM";
      else if (kind === "wrong-marker")
        s.controls.tables.at(-1)!.comment = "other";
      else s.controls.tables[0] = s.controls.tables[1];
      expect(await s.run()).toEqual({
        status: "UNKNOWN",
        code: "RECONCILIATION_SCHEMA_NOT_READY",
      });
    }
  );
  it("missing schema prevents an absent audit from becoming no-commit evidence", async () => {
    const s = setup();
    s.controls.tables = [];
    s.controls.auditRows = [];
    expect((await s.run()).status).toBe("UNKNOWN");
  });
  it.each([
    "SET SESSION",
    "START TRANSACTION",
    "FROM legacySlipReferenceRepairAudit",
    "FROM payments p",
    "FROM orders WHERE",
    "FROM paymentSlipClaims",
    "information_schema.tables",
  ])("query failure %s is sanitized and closes connection", async token => {
    const s = setup();
    s.controls.failQuery = token;
    const result = await s.run();
    expect(result.status).toBe("UNKNOWN");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_FIXTURE");
    expect(s.connection.destroy).toHaveBeenCalledTimes(1);
    if (!/^(SET|START)/.test(token))
      expect(s.calls.at(-1)!.sql).toBe("ROLLBACK");
  });
  it("connect failure never sends SQL or leaks credentials", async () => {
    const s = setup();
    s.controls.connectFailure = true;
    expect(await s.run()).toEqual({
      status: "UNKNOWN",
      code: "RECONCILIATION_READ_FAILED",
    });
    expect(s.calls).toHaveLength(0);
    expect(s.connection.destroy).not.toHaveBeenCalled();
  });
  it("failed readonly rollback still destroys without a retry or mutation", async () => {
    const s = setup();
    s.controls.rollbackFailure = true;
    const result = await s.run();
    expect(result.status).toBe("MATCHING_AUDIT_AND_STATE");
    expect(s.calls.filter(q => q.sql === "ROLLBACK")).toHaveLength(1);
    expect(s.connection.destroy).toHaveBeenCalledTimes(1);
  });
  it("destroy errors are suppressed, do not initiate a second connection", async () => {
    const s = setup();
    s.controls.destroyFailure = true;
    expect((await s.run()).status).toBe("MATCHING_AUDIT_AND_STATE");
    expect(s.connect).toHaveBeenCalledTimes(1);
  });
  it("owns original private context before the first await", async () => {
    const s = setup();
    const original = s.dependencies.connect;
    s.dependencies.connect = vi.fn(async () => {
      s.input.authorization.authorizedBy = "TAMPERED_AFTER_DISPATCH";
      s.input.planBytes.fill(0);
      s.input.operatorAttestationBytes.fill(0);
      s.input.intent.candidate.key = "changed";
      return original();
    });
    expect((await s.run()).status).toBe("MATCHING_AUDIT_AND_STATE");
  });
  it("deadline is checked before another read begins", async () => {
    const s = setup();
    s.controls.onQuery = sql => {
      if (sql.includes("FROM legacySlipReferenceRepairAudit")) s.advance(30000);
    };
    expect((await s.run()).status).toBe("UNKNOWN");
    expect(s.connection.destroy).toHaveBeenCalledTimes(1);
    expect(s.calls.some(q => q.sql.includes("FROM payments p"))).toBe(false);
  });
  it("final metadata read completing after deadline cannot report match", async () => {
    const s = setup();
    s.controls.onQuery = sql => {
      if (sql.includes("information_schema.tables")) s.advance(30000);
    };
    expect((await s.run()).status).toBe("UNKNOWN");
    expect(s.connection.destroy).toHaveBeenCalledTimes(1);
  });
  it.each([NaN, -1, Infinity])(
    "invalid monotonic elapsed %s fails closed",
    async delta => {
      const s = setup();
      s.controls.onQuery = () => {
        s.advance(delta);
      };
      expect((await s.run()).status).toBe("UNKNOWN");
      expect(s.connection.destroy).toHaveBeenCalledTimes(1);
    }
  );
  it.each([
    "plan",
    "same-reviewer",
    "unapproved",
    "wrong-target",
    "bad-chronology",
  ])(
    "invalid original authority %s is BLOCKED before connecting",
    async kind => {
      const s = setup();
      if (kind === "plan")
        s.input.planBytes = Buffer.concat([
          s.input.planBytes,
          Buffer.from(" "),
        ]);
      if (kind === "same-reviewer")
        s.input.secondReview.reviewer = "PRIVATE_FIXTURE_PRIMARY";
      if (kind === "unapproved")
        (s.input.authorization as any).applyAuthorized = false;
      if (kind === "wrong-target") (s.input.intent as any).sourceId = 11310001;
      if (kind === "bad-chronology")
        s.input.authorization.authorizedAt = iso(-180000);
      expect(await s.run()).toEqual({
        status: "BLOCKED",
        code: "INVALID_RECONCILIATION_CONTEXT",
      });
      expect(s.connect).not.toHaveBeenCalled();
    }
  );
  it("sanitized evidence summary includes no private snapshots, hashes or operator identity", async () => {
    const s = setup();
    const text = JSON.stringify(await s.run());
    for (const secret of [
      "PRIVATE_FIXTURE",
      s.input.intent.candidate.key,
      s.input.intent.candidate.rawHash,
      s.input.authorization.operationId,
      s.input.intent.intentSha256,
    ])
      expect(text).not.toContain(secret);
  });
});
