/** REAL MariaDB 11.4 release gate. All records and attestations are synthetic.
 * Never run this file with the ordinary integration config or application DB. */
import { createHash, randomBytes } from "node:crypto";
import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import type { Connection, ConnectionOptions } from "mysql2/promise";
import { createRepairFixture } from "./fixtures/legacySlipRepairFixtures";
import {
  assertEmptyIsolatedDatabase,
  createIsolatedRepairSchema,
  dropOwnedIsolatedTables,
  insertSyntheticRow,
  isolatedRepairDatabaseOptions,
  openIsolatedRepairDatabase,
} from "./fixtures/legacySlipRepairIsolatedDatabase";
import { createRelinkDatabaseReaders } from "../scripts/lib/legacySlipRelinkRead";
import {
  createOperatorAttestation,
  parseRepairPlan,
  canonicalRepairJson,
  type RepairIntent,
} from "../scripts/lib/legacySlipRepairContract";
import {
  executeLegacySlipRepair,
  digestRepairSecondReview,
  type RepairWriterInput,
} from "../scripts/lib/legacySlipRepairWriter";
import { relinkTargetFingerprint } from "../scripts/lib/legacySlipRelinkPlan";
import type { LegacySlipAuditEnvironment } from "../scripts/lib/legacySlipAuditOptions";
import { reconcileLegacySlipRepair } from "../scripts/lib/legacySlipRepairReconciliation";

// Test-only partial mock replaces only the private digest with a synthetic
// digest. The real parser, validation, SQL writer and readers remain intact.
// Production code has no override and actual operator private data is not read.
const syntheticPin = vi.hoisted(() => ({ sha: "" }));
vi.mock("../scripts/lib/legacySlipRepairContract", async original => ({
  ...(await original<
    typeof import("../scripts/lib/legacySlipRepairContract")
  >()),
  get PINNED_REPAIR_PLAN_SHA256() {
    return syntheticPin.sha;
  },
}));

const NOW = Date.parse("2026-09-06T03:00:00.000Z");
const iso = (offset: number) => new Date(NOW + offset).toISOString();
const hash = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const CONFIG: LegacySlipAuditEnvironment = {
  db: {
    host: "z71vl8sxkolha3jf644qgsgr",
    port: 3306,
    database: "ipenovel",
    user: "fixture-never-connected",
    password: "SYNTHETIC_NOT_A_REAL_CREDENTIAL",
    connectTimeout: 5000,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
  },
  r2: {
    endpoint: "https://synthetic.invalid",
    region: "auto",
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: { accessKeyId: "SYNTHETIC", secretAccessKey: "SYNTHETIC" },
    bucket: "ipenovel-staging-private",
  },
};

type Input = RepairWriterInput & { intent: RepairIntent };
type QueryOptions = { sql: string; values?: unknown[]; timeout?: number };
type QueryHook = (
  query: QueryOptions,
  connection: Connection,
  next: () => Promise<any>
) => Promise<any>;
let db: Connection;
let dbOptions: ConnectionOptions;
let input: Input;
const ownedTables: string[] = [];
const connections = new Set<Connection>();
const ownedUsers: string[] = [];
let statements: string[] = [];
let unexpectedFetch: MockInstance<typeof fetch>;

async function isolatedConnection() {
  const c = await openIsolatedRepairDatabase(dbOptions);
  connections.add(c);
  return c;
}
function connectWriter(
  hook?: QueryHook,
  isolatedAccount?: { user: string; password: string }
) {
  return async (requested: ConnectionOptions): Promise<Connection> => {
    expect(requested.host).toBe(CONFIG.db.host);
    expect(requested.database).toBe(CONFIG.db.database);
    // NEVER forward requested host, password, database or port to mysql2.
    const c = isolatedAccount
      ? await openIsolatedRepairDatabase({ ...dbOptions, ...isolatedAccount })
      : await isolatedConnection();
    connections.add(c);
    const rawQuery = c.query.bind(c);
    return {
      query: async (q: QueryOptions) => {
        statements.push(q.sql);
        const next = () => rawQuery(q as any);
        return hook ? hook(q, c, next) : next();
      },
      destroy: () => c.destroy(),
    } as unknown as Connection;
  };
}
function run(hook?: QueryHook) {
  return executeLegacySlipRepair(input, CONFIG, {
    connect: connectWriter(hook),
    now: () => NOW,
  });
}
function reconcile(hook?: QueryHook) {
  const { preflight: _unused, ...authority } = input;
  return reconcileLegacySlipRepair(authority, CONFIG, {
    connect: connectWriter(hook),
  });
}
async function currentSnapshot() {
  return createRelinkDatabaseReaders(CONFIG.db, async () =>
    isolatedConnection()
  ).readSource({ sourceType: "order_payment", sourceId: 11280001 });
}
async function auditRows() {
  return (
    await db.query<any[]>("SELECT * FROM legacySlipReferenceRepairAudit")
  )[0];
}
async function assertUnchanged() {
  expect(await currentSnapshot()).toEqual(input.intent.before);
  expect(await auditRows()).toEqual([]);
}

async function seedAndBind(): Promise<Input> {
  const { plan } = createRepairFixture();
  plan.targetFingerprint = relinkTargetFingerprint(CONFIG);
  await insertSyntheticRow(db, "users", {
    id: 3001,
    openId: "synthetic-owner",
    name: "Synthetic Owner",
  });
  await insertSyntheticRow(db, "accountMutationGuards", {
    userId: 3001,
    generation: 17,
    mergeState: "open",
    activeMergeCaseId: null,
  });
  for (const row of plan.rows) {
    if (row.snapshot.before.order) {
      const order = {
        ...row.snapshot.before.order,
        orderNumber: `SYNTHETIC-${row.sourceId}`,
      };
      await insertSyntheticRow(db, "orders", order);
    }
    const record = { ...row.snapshot.before.record };
    if (row.sourceType === "wallet_topup") record.approvalSource = "manual";
    await insertSyntheticRow(
      db,
      row.sourceType === "order_payment" ? "payments" : "walletTopups",
      record
    );
  }
  // Preserved unknown is an advisory historical fact, never cleared by repair.
  await insertSyntheticRow(db, "paymentSlipLegacyUnknown", {
    id: 3,
    sourceType: "order_payment",
    sourceId: 11280001,
    reason: "synthetic_historical_unknown",
    recordedAt: "2026-09-05 09:18:15",
  });
  const readers = createRelinkDatabaseReaders(CONFIG.db, async () =>
    isolatedConnection()
  );
  for (const row of plan.rows) {
    const snapshot = await readers.readSource({
      sourceType: row.sourceType,
      sourceId: row.sourceId,
    });
    if (!snapshot) throw new Error("SYNTHETIC_SOURCE_MISSING");
    row.snapshot.before = snapshot;
    row.snapshot.after = structuredClone(snapshot);
  }
  const planBytes = Buffer.from(JSON.stringify(plan));
  syntheticPin.sha = hash(planBytes);
  const intent = parseRepairPlan(planBytes, syntheticPin.sha);
  const attestation = createOperatorAttestation(intent, {
    reviewer: "synthetic-first-human",
    reason: "Synthetic isolated test transaction mapping only.",
    evidenceReference: "synthetic-fixture-not-user-evidence",
    recordedAt: iso(-120000),
  });
  const operatorAttestationBytes = Buffer.from(JSON.stringify(attestation));
  const primarySha = hash(operatorAttestationBytes);
  const secondReview = {
    schema: "legacy-slip-independent-review/v1",
    reviewer: "synthetic-second-human",
    reviewedAt: iso(-90000),
    intentSha256: intent.intentSha256,
    operatorAttestationSha256: primarySha,
    mappingConfirmed: true,
  } as const;
  return {
    intent,
    planBytes,
    operatorAttestationBytes,
    secondReview,
    authorization: {
      schema: "legacy-slip-live-authorization/v1",
      operationId: "efbb03d0-5e6b-48e5-9a12-e1a73cfc66fa",
      authorizedBy: "synthetic-authorizer",
      authorizedAt: iso(-60000),
      expiresAt: iso(120000),
      intentSha256: intent.intentSha256,
      operatorAttestationSha256: primarySha,
      secondReviewSha256: digestRepairSecondReview(secondReview),
      applyAuthorized: true,
      maintenance: {
        assertionId: "synthetic-complete-freeze",
        assertedBy: "synthetic-maintainer",
        assertedAt: iso(-30000),
        expiresAt: iso(120000),
        scope:
          "ALL_PAYMENT_ORDER_ACCOUNT_MERGE_EVIDENCE_AND_R2_WRITERS_STOPPED",
      },
    },
    preflight: {
      intentSha256: intent.intentSha256,
      targetFingerprint: intent.targetFingerprint,
      checkedAt: iso(-1000),
      expiresAt: iso(50000),
      candidate: structuredClone(intent.candidate),
      allCrossReferencesClear: true,
    },
  };
}

beforeAll(async () => {
  dbOptions = isolatedRepairDatabaseOptions(process.env);
  db = await openIsolatedRepairDatabase(dbOptions);
  await assertEmptyIsolatedDatabase(db);
  unexpectedFetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(
      new Error("EXTERNAL_NETWORK_FORBIDDEN_IN_ISOLATED_REPAIR")
    );
});
beforeEach(async () => {
  statements = [];
  await createIsolatedRepairSchema(db, ownedTables);
  input = await seedAndBind();
});
afterEach(async () => {
  for (const c of connections) c.destroy();
  connections.clear();
  while (db && ownedUsers.length) {
    const name = ownedUsers[ownedUsers.length - 1];
    if (!/^ipe_repair_u_[a-f0-9]{12}$/.test(name))
      throw new Error("UNSAFE_SYNTHETIC_USER_CLEANUP");
    await db.query("DROP USER ?@'%'", [name]);
    ownedUsers.pop();
  }
  if (db) await dropOwnedIsolatedTables(db, ownedTables);
  expect(unexpectedFetch?.mock.calls ?? []).toEqual([]);
});
afterAll(async () => {
  db?.destroy();
  unexpectedFetch?.mockRestore();
});

describe("real isolated MariaDB 11.4 guarded reference writer", () => {
  it("executes actual manual DDL and preserves TIMESTAMP/DECIMAL/full snapshots with URL-only commit + audit", async () => {
    const [beforePayments] = await db.query<any[]>(
      "SELECT * FROM payments ORDER BY id"
    );
    const [beforeOrders] = await db.query<any[]>(
      "SELECT * FROM orders ORDER BY id"
    );
    const [beforeWallets] = await db.query<any[]>(
      "SELECT * FROM walletTopups ORDER BY id"
    );
    expect(input.intent.before.order?.totalAmount).toBe("100.00");
    expect(input.intent.before.record.createdAt).toBe("2026-09-05 09:18:15");
    expect(await run()).toEqual({
      status: "APPLIED",
      code: "REFERENCE_AND_PRIVATE_AUDIT_COMMITTED",
    });
    const after = await currentSnapshot();
    const expected = structuredClone(input.intent.before);
    expected.source.slipImageUrl =
      expected.record.slipImageUrl = `r2p:${input.intent.candidate.key}`;
    expected.record.updatedAt = after!.record.updatedAt;
    expect(after).toEqual(expected);
    expect((await db.query("SELECT * FROM orders ORDER BY id"))[0]).toEqual(
      beforeOrders
    );
    expect(
      (await db.query("SELECT * FROM walletTopups ORDER BY id"))[0]
    ).toEqual(beforeWallets);
    const [afterPayments] = await db.query<any[]>(
      "SELECT * FROM payments ORDER BY id"
    );
    expect(afterPayments.filter(p => p.id !== 11280001)).toEqual(
      beforePayments.filter(p => p.id !== 11280001)
    );
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].beforeSnapshot).toBe(
      canonicalRepairJson(input.intent.before)
    );
    expect(rows[0].afterSnapshot).toBe(canonicalRepairJson(after));
    expect(statements.filter(sql => /^UPDATE|^INSERT/.test(sql))).toHaveLength(
      2
    );
    expect(
      statements
        .filter(sql => /FOR UPDATE|LOCK IN SHARE MODE/.test(sql))
        .slice(0, 4)
    ).toEqual([
      expect.stringMatching(/accountMutationGuards.+LOCK IN SHARE MODE$/),
      expect.stringMatching(/FROM users.+LOCK IN SHARE MODE$/),
      expect.stringMatching(/accountMergeCases.+LOCK IN SHARE MODE$/),
      "SELECT id FROM payments WHERE id = ? FOR UPDATE",
    ]);
  });

  it("recognizes exact audit + after-image idempotently, issuing no second mutation", async () => {
    expect((await run()).status).toBe("APPLIED");
    statements = [];
    expect((await run()).status).toBe("ALREADY_APPLIED");
    expect(statements.some(sql => /^UPDATE|^INSERT/.test(sql))).toBe(false);
    expect(await auditRows()).toHaveLength(1);
  });

  it("blocks changed financial snapshot and keeps original URL", async () => {
    await db.query("UPDATE orders SET totalAmount = '101.00' WHERE id = ?", [
      input.intent.before.record.orderId,
    ]);
    expect((await run()).code).toBe("SOURCE_DRIFT");
    expect((await currentSnapshot())!.record.slipImageUrl).toBe(
      input.intent.before.record.slipImageUrl
    );
    expect(await auditRows()).toEqual([]);
  });

  it("blocks changed extraction without promoting evidence or approving", async () => {
    await db.query(
      "UPDATE payments SET extractedData = '{\"synthetic\":true}' WHERE id = 11280001"
    );
    expect((await run()).code).toBe("SOURCE_DRIFT");
    expect(statements.some(sql => /^UPDATE|^INSERT/.test(sql))).toBe(false);
  });

  it("rejects another wallet reference to the same candidate", async () => {
    await db.query(
      "UPDATE walletTopups SET slipImageUrl = ? WHERE id = 180001",
      [`r2p:${input.intent.candidate.key}`]
    );
    expect((await run()).code).toBe("CROSS_REFERENCE_CONFLICT");
    await assertUnchanged();
  });

  it("rolls back actual URL update on late audit insert database constraint failure", async () => {
    await db.query(
      "ALTER TABLE legacySlipReferenceRepairAudit ADD CONSTRAINT synthetic_reject_audit CHECK (sourceId <> 11280001)"
    );
    expect(await run()).toEqual({
      status: "ROLLED_BACK",
      code: "DATABASE_OPERATION_FAILED",
    });
    expect(statements.some(sql => sql.startsWith("UPDATE payments"))).toBe(
      true
    );
    await assertUnchanged();
  });

  it("rolls back actual URL + audit on corrupted durable readback", async () => {
    let inserted = false;
    const result = await run(async (q, c, next) => {
      const response = await next();
      if (q.sql.startsWith("INSERT INTO legacySlipReferenceRepairAudit")) {
        inserted = true;
        await c.query(
          "UPDATE legacySlipReferenceRepairAudit SET authorizationSha256 = ?",
          ["0".repeat(64)]
        );
      }
      return response;
    });
    expect(inserted).toBe(true);
    expect(result).toEqual({
      status: "ROLLED_BACK",
      code: "AUDIT_READBACK_MISMATCH",
    });
    await assertUnchanged();
  });

  it("rolls back if a late same-connection mutation changes the after-image", async () => {
    expect(
      await run(async (q, c, next) => {
        const result = await next();
        if (q.sql.startsWith("UPDATE payments"))
          await c.query(
            "UPDATE payments SET approvedByLabel = 'SYNTHETIC_DRIFT' WHERE id = 11280001"
          );
        return result;
      })
    ).toEqual({ status: "ROLLED_BACK", code: "AFTER_IMAGE_MISMATCH" });
    await assertUnchanged();
  });

  it("uses binary URL CAS even on a case-insensitive database collation", async () => {
    let reached = false;
    const result = await run(async (q, c, next) => {
      if (q.sql.startsWith("UPDATE payments")) {
        reached = true;
        const original = String(input.intent.before.record.slipImageUrl);
        const changed = original.replace("https://", "HTTPS://");
        await c.query(
          "UPDATE payments SET slipImageUrl = ? WHERE id = 11280001",
          [changed]
        );
        const [rows] = await c.query<any[]>(
          "SELECT slipImageUrl = ? AS collationMatches, BINARY slipImageUrl = BINARY ? AS binaryMatches FROM payments WHERE id = 11280001",
          [original, original]
        );
        expect(rows[0]).toMatchObject({
          collationMatches: 1,
          binaryMatches: 0,
        });
      }
      return next();
    });
    expect(reached).toBe(true);
    expect(result).toEqual({
      status: "ROLLED_BACK",
      code: "COMPARE_AND_SWAP_FAILED",
    });
    await assertUnchanged();
  });

  it("real commit then lost acknowledgement returns UNKNOWN with read-only reconciliation, never blind retry", async () => {
    let committed = false;
    const result = await run(async (q, _c, next) => {
      const response = await next();
      if (q.sql === "COMMIT") {
        committed = true;
        throw new Error("SYNTHETIC_COMMIT_ACK_LOSS");
      }
      return response;
    });
    expect(committed).toBe(true);
    expect(result).toEqual({
      status: "UNKNOWN",
      code: "COMMIT_OUTCOME_UNKNOWN",
      reconciliation: "MATCHING_AUDIT_AND_STATE",
    });
    expect(await auditRows()).toHaveLength(1);
    expect((await currentSnapshot())!.record.slipImageUrl).toBe(
      `r2p:${input.intent.candidate.key}`
    );
    expect(
      statements.filter(sql => sql.startsWith("UPDATE payments"))
    ).toHaveLength(1);
  });

  for (const guard of ["missing", "merge_guarded"] as const) {
    it(`fails closed on ${guard} account guard without lazy provisioning`, async () => {
      if (guard === "missing")
        await db.query("DELETE FROM accountMutationGuards WHERE userId = 3001");
      else
        await db.query(
          "UPDATE accountMutationGuards SET mergeState = 'merge_guarded' WHERE userId = 3001"
        );
      expect((await run()).code).toBe("ACCOUNT_GUARD_BLOCKED");
      await assertUnchanged();
    });
  }

  it("times out behind a real payment lock and leaves no lingering writer locks", async () => {
    const locker = await isolatedConnection();
    await locker.query("START TRANSACTION");
    await locker.query(
      "SELECT id FROM payments WHERE id = 11280001 FOR UPDATE"
    );
    const started = performance.now();
    const result = await run();
    expect(performance.now() - started).toBeGreaterThan(4000);
    // Driver query deadline and server lock timeout both bound five seconds.
    // If the driver drops the connection first, rollback acknowledgement is
    // unknown; the fresh exclusive probes below must still prove no lock leak.
    expect(["ROLLED_BACK", "UNKNOWN"]).toContain(result.status);
    await locker.query("ROLLBACK");
    const probe = await isolatedConnection();
    await probe.query("SET SESSION innodb_lock_wait_timeout = 1");
    await probe.query("START TRANSACTION");
    await probe.query(
      "SELECT userId FROM accountMutationGuards WHERE userId = 3001 FOR UPDATE"
    );
    await probe.query("SELECT id FROM payments WHERE id = 11280001 FOR UPDATE");
    await probe.query("ROLLBACK");
    await assertUnchanged();
  });

  it("reads the new committed state after waiting, not a stale pre-wait snapshot", async () => {
    const locker = await isolatedConnection();
    await locker.query("START TRANSACTION");
    await locker.query(
      "SELECT id FROM payments WHERE id = 11280001 FOR UPDATE"
    );
    let sawWait!: () => void;
    const waiting = new Promise<void>(resolve => {
      sawWait = resolve;
    });
    const running = run(async (q, _c, next) => {
      if (q.sql === "SELECT id FROM payments WHERE id = ? FOR UPDATE")
        sawWait();
      return next();
    });
    await waiting;
    await locker.query(
      "UPDATE payments SET approvedByLabel = 'SYNTHETIC_CHANGED_WHILE_WAITING' WHERE id = 11280001"
    );
    await locker.query("COMMIT");
    expect((await running).code).toBe("SOURCE_DRIFT");
    expect(await auditRows()).toEqual([]);
  });

  it("shared account guard blocks a concurrent exclusive merge guard until transaction completion", async () => {
    const contender = await isolatedConnection();
    await contender.query("SET SESSION innodb_lock_wait_timeout = 1");
    let proved = false;
    const result = await run(async (q, _c, next) => {
      const response = await next();
      if (q.sql.includes("FROM accountMutationGuards") && !proved) {
        await expect(
          contender.query(
            "UPDATE accountMutationGuards SET generation = generation + 1 WHERE userId = 3001"
          )
        ).rejects.toMatchObject({ code: "ER_LOCK_WAIT_TIMEOUT" });
        proved = true;
      }
      return response;
    });
    expect(proved).toBe(true);
    expect(result.status).toBe("APPLIED");
    await contender.query(
      "UPDATE accountMutationGuards SET generation = generation + 1 WHERE userId = 3001"
    );
  });

  for (const change of [
    "ALTER TABLE legacySlipReferenceRepairAudit COMMENT = 'SYNTHETIC_WRONG_MARKER'",
    "ALTER TABLE legacySlipReferenceRepairAudit DROP INDEX uq_legacy_repair_intent",
    "ALTER TABLE legacySlipReferenceRepairAudit MODIFY beforeSnapshot TEXT NOT NULL",
    "ALTER TABLE legacySlipReferenceRepairAudit MODIFY afterSnapshot LONGTEXT NULL",
    "ALTER TABLE legacySlipReferenceRepairAudit ENGINE=MyISAM",
  ]) {
    it(`rejects actual incompatible audit schema: ${change}`, async () => {
      await db.query(change);
      expect(await run()).toEqual({
        status: "BLOCKED",
        code: "AUDIT_SCHEMA_NOT_READY",
      });
      expect(statements).not.toContain("START TRANSACTION");
      await assertUnchanged();
    });
  }

  it("rejects a real unreviewed payment trigger before opening its transaction", async () => {
    await db.query(
      "CREATE TRIGGER synthetic_unreviewed BEFORE UPDATE ON payments FOR EACH ROW SET NEW.approvedByLabel = 'SYNTHETIC_TRIGGER'"
    );
    expect(await run()).toEqual({
      status: "BLOCKED",
      code: "UNREVIEWED_TRIGGER",
    });
    expect(statements).not.toContain("START TRANSACTION");
    await assertUnchanged();
  });

  it("rechecks metadata after locks and rejects a trigger installed after initial preflight", async () => {
    let introduced = false;
    const result = await run(async (q, _c, next) => {
      if (q.sql === "START TRANSACTION" && !introduced) {
        await db.query(
          "CREATE TRIGGER synthetic_late BEFORE UPDATE ON payments FOR EACH ROW SET NEW.approvedByLabel = 'SYNTHETIC_LATE_TRIGGER'"
        );
        introduced = true;
      }
      return next();
    });
    expect(introduced).toBe(true);
    expect(result).toEqual({
      status: "ROLLED_BACK",
      code: "UNREVIEWED_TRIGGER",
    });
    expect(statements.some(sql => /^UPDATE|^INSERT/.test(sql))).toBe(false);
    await assertUnchanged();
  });

  it("rejects an unreviewed auto-updated payment column absent from the pinned full snapshot", async () => {
    await db.query(
      "ALTER TABLE payments ADD syntheticAutoUpdated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
    );
    expect(await run()).toEqual({
      status: "BLOCKED",
      code: "UNREVIEWED_PAYMENT_SCHEMA",
    });
    expect(statements).not.toContain("START TRANSACTION");
    await assertUnchanged();
  });

  it("rejects an unreviewed generated payment column absent from the pinned snapshot", async () => {
    await db.query(
      "ALTER TABLE payments ADD syntheticGenerated INT GENERATED ALWAYS AS (LENGTH(slipImageUrl)) STORED"
    );
    expect(await run()).toEqual({
      status: "BLOCKED",
      code: "UNREVIEWED_PAYMENT_SCHEMA",
    });
    expect(statements).not.toContain("START TRANSACTION");
    await assertUnchanged();
  });

  it("fails closed when a limited account cannot prove visibility of a payment trigger", async () => {
    const suffix = String(dbOptions.database).slice("ipe_repair_test_".length);
    const name = `ipe_repair_u_${suffix}`;
    const password = randomBytes(24).toString("hex");
    // CREATE without IF NOT EXISTS deliberately refuses an existing account.
    await db.query("CREATE USER ?@'%' IDENTIFIED BY ?", [name, password]);
    ownedUsers.push(name);
    await db.query(
      `GRANT SELECT, UPDATE, INSERT ON \`${dbOptions.database}\`.* TO ?@'%'`,
      [name]
    );
    await db.query(
      "CREATE TABLE syntheticFinancialSentinel (id INT PRIMARY KEY, balance DECIMAL(12,2) NOT NULL) ENGINE=InnoDB"
    );
    ownedTables.push("syntheticFinancialSentinel");
    await db.query("INSERT INTO syntheticFinancialSentinel VALUES (1, 100.00)");
    await db.query(
      "CREATE TRIGGER synthetic_hidden AFTER UPDATE ON payments FOR EACH ROW UPDATE syntheticFinancialSentinel SET balance = balance + 1 WHERE id = 1"
    );
    const result = await executeLegacySlipRepair(input, CONFIG, {
      connect: connectWriter(undefined, { user: name, password }),
      now: () => NOW,
    });
    expect(result.status).toBe("BLOCKED");
    expect(statements.some(sql => /^UPDATE|^INSERT/.test(sql))).toBe(false);
    const [sentinel] = await db.query<any[]>(
      "SELECT balance FROM syntheticFinancialSentinel WHERE id = 1"
    );
    expect(sentinel[0].balance).toBe("100.00");
    await assertUnchanged();
  });

  it("reconciles retained authority against a real read-only snapshot without retry or renewal", async () => {
    expect((await run()).status).toBe("APPLIED");
    statements = [];
    expect(await reconcile()).toEqual({
      status: "MATCHING_AUDIT_AND_STATE",
      code: "EXACT_COMMIT_EVIDENCE_AT_READ_SNAPSHOT",
    });
    expect(statements).toContain(
      "START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT"
    );
    expect(
      statements.some(sql =>
        /^(UPDATE|INSERT|DELETE|CREATE|ALTER|DROP)/.test(sql)
      )
    ).toBe(false);
    expect(await auditRows()).toHaveLength(1);
  });

  it("reconciliation reports absent audit only as no evidence, never success or retry permission", async () => {
    expect(await reconcile()).toEqual({
      status: "NO_COMMIT_EVIDENCE",
      code: "AUDIT_ABSENT_NOT_RETRY_AUTHORIZATION",
    });
    await assertUnchanged();
    expect(
      statements.some(sql =>
        /^(UPDATE|INSERT|DELETE|CREATE|ALTER|DROP)/.test(sql)
      )
    ).toBe(false);
  });

  it("reconciliation reads audit and state from the same snapshot during concurrent financial mutation", async () => {
    expect((await run()).status).toBe("APPLIED");
    let changed = false;
    const result = await reconcile(async (q, _c, next) => {
      const response = await next();
      if (q.sql.includes("FROM legacySlipReferenceRepairAudit") && !changed) {
        await db.query(
          "UPDATE payments SET approvedByLabel = 'SYNTHETIC_POST_SNAPSHOT_DRIFT' WHERE id = 11280001"
        );
        changed = true;
      }
      return response;
    });
    expect(changed).toBe(true);
    expect(result.status).toBe("MATCHING_AUDIT_AND_STATE");
    // A later snapshot observes the drift and must not call it unchanged.
    expect(await reconcile()).toEqual({
      status: "CONFLICT",
      code: "AUDIT_OR_STATE_MISMATCH",
    });
  });

  it("reconciliation refuses incompatible audit metadata without mutating it", async () => {
    expect((await run()).status).toBe("APPLIED");
    await db.query(
      "ALTER TABLE legacySlipReferenceRepairAudit COMMENT = 'SYNTHETIC_INCOMPATIBLE'"
    );
    statements = [];
    expect(await reconcile()).toEqual({
      status: "UNKNOWN",
      code: "RECONCILIATION_SCHEMA_NOT_READY",
    });
    expect(
      statements.some(sql =>
        /^(UPDATE|INSERT|DELETE|CREATE|ALTER|DROP)/.test(sql)
      )
    ).toBe(false);
  });
});
