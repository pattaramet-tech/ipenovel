import { createHash } from "node:crypto";
import { types } from "node:util";
import mysql, { type Connection } from "mysql2/promise";
import type { LegacySlipAuditEnvironment } from "./legacySlipAuditOptions";
import { relinkTargetFingerprint } from "./legacySlipRelinkPlan";
import {
  createLockedRelinkDatabaseReaders,
  createRelinkDatabaseReaders,
  type RelinkSourceSnapshot,
} from "./legacySlipRelinkRead";
import {
  validateRepairIntent,
  PINNED_REPAIR_PLAN_SHA256,
  parseRepairPlan,
  parseOperatorAttestationBytes,
  type RepairIntent,
} from "./legacySlipRepairContract";

/** Future live core ONLY. Deliberately not imported by any CLI or app route. */
export interface RepairSecondReview {
  schema: "legacy-slip-independent-review/v1";
  reviewer: string;
  reviewedAt: string;
  intentSha256: string;
  operatorAttestationSha256: string;
  mappingConfirmed: true;
}
export interface RepairLiveAuthorization {
  schema: "legacy-slip-live-authorization/v1";
  operationId: string;
  authorizedBy: string;
  authorizedAt: string;
  expiresAt: string;
  intentSha256: string;
  operatorAttestationSha256: string;
  secondReviewSha256: string;
  applyAuthorized: true;
  maintenance: {
    assertionId: string;
    assertedBy: string;
    assertedAt: string;
    expiresAt: string;
    scope: "ALL_PAYMENT_ORDER_ACCOUNT_MERGE_EVIDENCE_AND_R2_WRITERS_STOPPED";
  };
}
export interface RepairFreshPreflight {
  intentSha256: string;
  targetFingerprint: string;
  checkedAt: string;
  expiresAt: string;
  candidate: RepairIntent["candidate"];
  allCrossReferencesClear: true;
}
export interface RepairWriterInput {
  intent: unknown;
  /** Exact original private plan bytes; a matching caller-supplied label is insufficient. */
  planBytes: Uint8Array;
  /** Exact bytes of the private primary attestation artifact. Never logged. */
  operatorAttestationBytes: Uint8Array;
  secondReview: RepairSecondReview;
  authorization: RepairLiveAuthorization;
  preflight: RepairFreshPreflight;
}
export type RepairWriterResult = {
  status: "APPLIED" | "ALREADY_APPLIED" | "BLOCKED" | "ROLLED_BACK" | "UNKNOWN";
  code: string;
  reconciliation?:
    "MATCHING_AUDIT_AND_STATE" | "NO_COMMIT_EVIDENCE" | "CONFLICT" | "FAILED";
};
export interface RepairWriterDependencies {
  connect?: (config: mysql.ConnectionOptions) => Promise<Connection>;
  now?: () => number;
  monotonicNow?: () => number;
}

const TABLE = "legacySlipReferenceRepairAudit";
const SCHEMA_MARKER = "legacy-slip-reference-repair-audit/v1";
const TARGET = { sourceType: "order_payment", sourceId: 11280001 } as const;
const QUERY_MS = 5_000;
const TX_MS = 15_000;
class WriterFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function fail(code: string): never {
  throw new WriterFailure(code);
}
function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (
    value &&
    typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return `{${Object.keys(value)
      .sort()
      .map(
        k =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`
      )
      .join(",")}}`;
  return fail("INVALID_PRIVATE_INPUT");
}
export function digestRepairSecondReview(review: RepairSecondReview): string {
  return digest(canonical(review));
}
function identity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length >= 3 &&
    value.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
function unsignedInteger(value: unknown): boolean {
  return (
    (typeof value === "number" ||
      (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value))) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) >= 0
  );
}
function timestamp(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  )
    return fail("INVALID_AUTHORIZATION");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
    return fail("INVALID_AUTHORIZATION");
  return parsed;
}
function exactKeys(
  value: unknown,
  keys: string[]
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join("|") !== [...keys].sort().join("|") ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      d => !("value" in d)
    )
  )
    fail("INVALID_AUTHORIZATION");
}
function requirePlainInput(
  value: unknown,
  seen = new Set<object>(),
  depth = 0
): void {
  if (depth > 64) fail("INVALID_PRIVATE_INPUT");
  if (value === null || ["string", "number", "boolean"].includes(typeof value))
    return;
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    seen.has(value)
  )
    fail("INVALID_PRIVATE_INPUT");
  if (
    value instanceof Uint8Array &&
    [Uint8Array.prototype, Buffer.prototype].includes(
      Object.getPrototypeOf(value)
    )
  )
    return;
  if (
    ![Object.prototype, Array.prototype, null].includes(
      Object.getPrototypeOf(value)
    )
  )
    fail("INVALID_PRIVATE_INPUT");
  seen.add(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 100000) fail("INVALID_PRIVATE_INPUT");
  for (const key of keys) {
    if (
      typeof key !== "string" ||
      ["__proto__", "prototype", "constructor"].includes(key)
    )
      fail("INVALID_PRIVATE_INPUT");
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor)) fail("INVALID_PRIVATE_INPUT");
    requirePlainInput(descriptor.value, seen, depth + 1);
  }
  seen.delete(value);
}
function unchangedExceptReference(
  before: RelinkSourceSnapshot,
  after: RelinkSourceSnapshot,
  ref: string
): boolean {
  const expected = structuredClone(before);
  expected.source.slipImageUrl = ref;
  expected.record.slipImageUrl = ref;
  // MySQL's existing ON UPDATE timestamp is the only permitted companion change.
  expected.record.updatedAt = after.record.updatedAt;
  return canonical(expected) === canonical(after);
}

type Validated = {
  intent: RepairIntent;
  input: RepairWriterInput;
  primarySha: string;
  secondSha: string;
  authSha: string;
  checkFresh(): void;
};
function validateInput(
  input: RepairWriterInput,
  config: LegacySlipAuditEnvironment,
  now: () => number
): Validated {
  // Clone before any await; callers cannot mutate authorization while locks wait.
  requirePlainInput(input);
  const cloned = structuredClone(input);
  const intent = validateRepairIntent(cloned.intent);
  if (
    !(cloned.planBytes instanceof Uint8Array) ||
    cloned.planBytes.byteLength > 8 * 1024 * 1024
  )
    fail("INVALID_PRIVATE_PLAN");
  const pinnedIntent = parseRepairPlan(
    cloned.planBytes,
    PINNED_REPAIR_PLAN_SHA256
  );
  if (canonical(pinnedIntent) !== canonical(intent))
    fail("PINNED_PLAN_INTENT_MISMATCH");
  if (
    intent.sourceType !== TARGET.sourceType ||
    intent.sourceId !== TARGET.sourceId ||
    intent.planSha256 !== PINNED_REPAIR_PLAN_SHA256 ||
    config.db.host !== "z71vl8sxkolha3jf644qgsgr" ||
    config.db.database !== "ipenovel" ||
    config.db.port !== 3306 ||
    config.r2.bucket !== "ipenovel-staging-private" ||
    relinkTargetFingerprint(config) !== intent.targetFingerprint
  )
    fail("TARGET_MISMATCH");
  if (
    !(cloned.operatorAttestationBytes instanceof Uint8Array) ||
    cloned.operatorAttestationBytes.byteLength > 65_536
  )
    fail("INVALID_ATTESTATION");
  const primary = parseOperatorAttestationBytes(
    cloned.operatorAttestationBytes,
    intent
  );
  const primarySha = digest(cloned.operatorAttestationBytes);
  const r = cloned.secondReview;
  const a = cloned.authorization;
  const p = cloned.preflight;
  exactKeys(r, [
    "schema",
    "reviewer",
    "reviewedAt",
    "intentSha256",
    "operatorAttestationSha256",
    "mappingConfirmed",
  ]);
  exactKeys(a, [
    "schema",
    "operationId",
    "authorizedBy",
    "authorizedAt",
    "expiresAt",
    "intentSha256",
    "operatorAttestationSha256",
    "secondReviewSha256",
    "applyAuthorized",
    "maintenance",
  ]);
  exactKeys(a.maintenance, [
    "assertionId",
    "assertedBy",
    "assertedAt",
    "expiresAt",
    "scope",
  ]);
  exactKeys(p, [
    "intentSha256",
    "targetFingerprint",
    "checkedAt",
    "expiresAt",
    "candidate",
    "allCrossReferencesClear",
  ]);
  const secondSha = digestRepairSecondReview(r);
  if (
    r.schema !== "legacy-slip-independent-review/v1" ||
    r.mappingConfirmed !== true ||
    !identity(r.reviewer) ||
    r.reviewer.toLocaleLowerCase("en-US") ===
      primary.reviewer.toLocaleLowerCase("en-US") ||
    r.intentSha256 !== intent.intentSha256 ||
    r.operatorAttestationSha256 !== primarySha ||
    a.schema !== "legacy-slip-live-authorization/v1" ||
    a.applyAuthorized !== true ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      a.operationId
    ) ||
    !identity(a.authorizedBy) ||
    a.intentSha256 !== intent.intentSha256 ||
    a.operatorAttestationSha256 !== primarySha ||
    a.secondReviewSha256 !== secondSha ||
    !identity(a.maintenance.assertionId) ||
    !identity(a.maintenance.assertedBy) ||
    a.maintenance.scope !==
      "ALL_PAYMENT_ORDER_ACCOUNT_MERGE_EVIDENCE_AND_R2_WRITERS_STOPPED" ||
    p.intentSha256 !== intent.intentSha256 ||
    p.targetFingerprint !== intent.targetFingerprint ||
    p.allCrossReferencesClear !== true ||
    canonical(p.candidate) !== canonical(intent.candidate)
  )
    fail("INVALID_AUTHORIZATION");
  const reviewAt = timestamp(r.reviewedAt);
  const authAt = timestamp(a.authorizedAt),
    authExpiry = timestamp(a.expiresAt);
  const freezeAt = timestamp(a.maintenance.assertedAt),
    freezeExpiry = timestamp(a.maintenance.expiresAt);
  const checkedAt = timestamp(p.checkedAt),
    preflightExpiry = timestamp(p.expiresAt);
  const checkFresh = () => {
    const current = now();
    if (
      !Number.isFinite(current) ||
      reviewAt > authAt ||
      authAt > current ||
      freezeAt > checkedAt ||
      checkedAt > current ||
      authExpiry <= current ||
      freezeExpiry <= current ||
      preflightExpiry <= current ||
      authExpiry - authAt > 900_000 ||
      freezeExpiry - freezeAt > 900_000 ||
      preflightExpiry - checkedAt > 60_000 ||
      current - checkedAt > 60_000 ||
      current - reviewAt > 86_400_000 ||
      reviewAt < timestamp(primary.recordedAt)
    )
      fail("AUTHORIZATION_OR_PREFLIGHT_EXPIRED");
  };
  checkFresh();
  return {
    intent,
    input: cloned,
    primarySha,
    secondSha,
    authSha: digest(canonical(a)),
    checkFresh,
  };
}

const AUDIT_COLUMNS = [
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
type AuditRecord = Record<string, unknown>;
function matchesAudit(row: AuditRecord, v: Validated): boolean {
  return (
    row.sourceType === TARGET.sourceType &&
    Number(row.sourceId) === TARGET.sourceId &&
    row.intentSha256 === v.intent.intentSha256 &&
    row.operationId === v.input.authorization.operationId &&
    row.planSha256 === v.intent.planSha256 &&
    row.planRunId === v.intent.planRunId &&
    row.targetFingerprint === v.intent.targetFingerprint &&
    row.operatorAttestationSha256 === v.primarySha &&
    row.secondReviewSha256 === v.secondSha &&
    row.authorizationSha256 === v.authSha &&
    typeof row.beforeSnapshot === "string" &&
    row.beforeSnapshot === canonical(v.intent.before) &&
    typeof row.afterSnapshot === "string"
  );
}

/**
 * No R2 callbacks, dotenv, app db pool, guard provisioning, or schema creation.
 * Human identities, authorization and a comprehensive writer freeze MUST be
 * established by a future authenticated operator workflow; JSON is not authn.
 */
export async function executeLegacySlipRepair(
  input: RepairWriterInput,
  config: LegacySlipAuditEnvironment,
  dependencies: RepairWriterDependencies = {}
): Promise<RepairWriterResult> {
  const now = dependencies.now ?? Date.now;
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const connect = dependencies.connect ?? mysql.createConnection;
  let v: Validated;
  try {
    v = validateInput(input, config, now);
  } catch (error) {
    return {
      status: "BLOCKED",
      code:
        error instanceof WriterFailure ? error.code : "INVALID_PRIVATE_INPUT",
    };
  }
  const options: mysql.ConnectionOptions = {
    ...config.db,
    connectTimeout: QUERY_MS,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
    dateStrings: true,
    decimalNumbers: false,
  };
  let c: Connection | undefined;
  let transaction = false,
    commitAttempted = false;
  let txStarted = 0;
  const query = async (sql: string, values: unknown[] = []): Promise<any> => {
    v.checkFresh();
    if (transaction && monotonicNow() - txStarted >= TX_MS)
      fail("TRANSACTION_BUDGET_EXCEEDED");
    const [result] = await c!.query({ sql, values, timeout: QUERY_MS });
    return result;
  };
  const boundedConnection = () =>
    ({
      query: async (options: { sql: string; values?: unknown[] }) => [
        await query(options.sql, options.values ?? []),
        [],
      ],
      destroy() {},
    }) as unknown as Connection;
  const readAudit = (locked: boolean) =>
    query(
      `SELECT ${AUDIT_COLUMNS.map(k => `\`${k}\``).join(", ")} FROM ${TABLE} WHERE sourceType = ? AND sourceId = ? LIMIT 2${locked ? " FOR UPDATE" : ""}`,
      [TARGET.sourceType, TARGET.sourceId]
    );
  try {
    c = await connect(options);
    const tables = await query(
      "SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_COMMENT AS comment FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('payments','orders','accountMutationGuards','users','accountMergeCases','paymentSlipClaims','slipEvidenceBindings','slipEvidenceUploads','paymentSlipLegacyUnknown','paymentSlipLegacyCollisions','walletTopups','legacySlipReferenceRepairAudit')"
    );
    const expectedTables = [
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
      TABLE,
    ];
    if (
      !Array.isArray(tables) ||
      tables.length !== expectedTables.length ||
      expectedTables.some(
        name =>
          !tables.some(
            (r: any) =>
              r.name === name &&
              r.engine === "InnoDB" &&
              (name !== TABLE || r.comment === SCHEMA_MARKER)
          )
      )
    )
      fail("AUDIT_SCHEMA_NOT_READY");
    const indexes = await query(
      "SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS position, COLUMN_NAME AS columnName, SUB_PART AS subPart FROM information_schema.statistics WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'legacySlipReferenceRepairAudit' ORDER BY INDEX_NAME, SEQ_IN_INDEX"
    );
    for (const [name, columns] of [
      ["uq_legacy_repair_source", ["sourceType", "sourceId"]],
      ["uq_legacy_repair_intent", ["intentSha256"]],
      ["uq_legacy_repair_operation", ["operationId"]],
    ] as const) {
      const rows = indexes.filter((r: any) => r.name === name);
      if (
        rows.length !== columns.length ||
        rows.some(
          (r: any, i: number) =>
            Number(r.nonUnique) !== 0 ||
            Number(r.position) !== i + 1 ||
            r.columnName !== columns[i] ||
            r.subPart !== null
        )
      )
        fail("AUDIT_SCHEMA_NOT_READY");
    }
    const columns = await query(
      "SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType, IS_NULLABLE AS nullable FROM information_schema.columns WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'legacySlipReferenceRepairAudit'"
    );
    if (
      !Array.isArray(columns) ||
      columns.length !== AUDIT_COLUMNS.length ||
      AUDIT_COLUMNS.some(
        name =>
          !columns.some(
            (r: any) =>
              r.name === name &&
              r.nullable === "NO" &&
              (!["beforeSnapshot", "afterSnapshot"].includes(name) ||
                r.dataType === "longtext")
          )
      )
    )
      fail("AUDIT_SCHEMA_NOT_READY");
    const triggers = await query(
      "SELECT TRIGGER_NAME AS name FROM information_schema.triggers WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE IN ('payments','legacySlipReferenceRepairAudit') LIMIT 1"
    );
    if (!Array.isArray(triggers) || triggers.length) fail("UNREVIEWED_TRIGGER");
    await query("SET SESSION innodb_lock_wait_timeout = 5");
    await query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await query("START TRANSACTION");
    transaction = true;
    txStarted = monotonicNow();
    const owner = v.intent.before.source.ownerUserId;
    const guards = await query(
      "SELECT userId, generation, mergeState, activeMergeCaseId FROM accountMutationGuards WHERE userId = ? LOCK IN SHARE MODE",
      [owner]
    );
    if (
      !Array.isArray(guards) ||
      guards.length !== 1 ||
      Number(guards[0].userId) !== owner ||
      !unsignedInteger(guards[0].generation) ||
      guards[0].mergeState !== "open" ||
      guards[0].activeMergeCaseId !== null
    )
      fail("ACCOUNT_GUARD_BLOCKED");
    const users = await query(
      "SELECT id FROM users WHERE id = ? LOCK IN SHARE MODE",
      [owner]
    );
    if (
      !Array.isArray(users) ||
      users.length !== 1 ||
      Number(users[0].id) !== owner
    )
      fail("ACCOUNT_GUARD_BLOCKED");
    const merges = await query(
      "SELECT id, sourceUserId, status FROM accountMergeCases WHERE sourceUserId = ? ORDER BY id LIMIT 21 LOCK IN SHARE MODE",
      [owner]
    );
    if (
      !Array.isArray(merges) ||
      merges.length > 20 ||
      merges.some(
        (r: any) => Number(r.sourceUserId) !== owner || r.status !== "cancelled"
      )
    )
      fail("ACCOUNT_GUARD_BLOCKED");
    const payment = await query(
      "SELECT id FROM payments WHERE id = ? FOR UPDATE",
      [TARGET.sourceId]
    );
    if (
      !Array.isArray(payment) ||
      payment.length !== 1 ||
      Number(payment[0].id) !== TARGET.sourceId
    )
      fail("SOURCE_MISSING");
    const readers = createLockedRelinkDatabaseReaders(boundedConnection());
    const current = await readers.readSource(TARGET);
    if (!current || current.truncated || current.source.ownerUserId !== owner)
      fail("SOURCE_DRIFT");
    const existing = await readAudit(true);
    if (!Array.isArray(existing) || existing.length > 1) fail("AUDIT_CONFLICT");
    if (existing.length === 1) {
      if (
        !matchesAudit(existing[0], v) ||
        existing[0].afterSnapshot !== canonical(current) ||
        !unchangedExceptReference(
          v.intent.before,
          current,
          `r2p:${v.intent.candidate.key}`
        )
      )
        fail("AUDIT_CONFLICT");
      await query("ROLLBACK");
      transaction = false;
      return {
        status: "ALREADY_APPLIED",
        code: "EXACT_AUDIT_AND_AFTER_IMAGE_MATCH",
      };
    }
    if (canonical(current) !== canonical(v.intent.before)) fail("SOURCE_DRIFT");
    const cross = await readers.readCrossReferences({
      target: TARGET,
      ...v.intent.candidate,
    });
    if (
      cross.truncated ||
      [
        cross.claims,
        cross.collisions,
        cross.bindings,
        cross.uploads,
        cross.references,
      ].some(rows => rows.length)
    )
      fail("CROSS_REFERENCE_CONFLICT");
    const newRef = `r2p:${v.intent.candidate.key}`;
    const result = await query(
      "UPDATE payments SET slipImageUrl = ? WHERE id = ? AND orderId = ? AND BINARY slipImageUrl = BINARY ? AND status = 'approved' AND evidenceVersion = 0 AND slipEvidenceClass = 'legacy_compatibility_required' AND slipEvidenceId IS NULL AND extractedEvidenceVersion IS NULL AND extractedData IS NULL",
      [
        newRef,
        TARGET.sourceId,
        current.record.orderId,
        current.record.slipImageUrl,
      ]
    );
    if (result?.affectedRows !== 1) fail("COMPARE_AND_SWAP_FAILED");
    const after = await readers.readSource(TARGET);
    if (!after || !unchangedExceptReference(current, after, newRef))
      fail("AFTER_IMAGE_MISMATCH");
    const auditValues = [
      TARGET.sourceType,
      TARGET.sourceId,
      v.intent.intentSha256,
      v.input.authorization.operationId,
      v.intent.planSha256,
      v.intent.planRunId,
      v.intent.targetFingerprint,
      v.primarySha,
      v.secondSha,
      v.authSha,
      canonical(current),
      canonical(after),
    ];
    const auditInsert = await query(
      `INSERT INTO ${TABLE} (sourceType, sourceId, intentSha256, operationId, planSha256, planRunId, targetFingerprint, operatorAttestationSha256, secondReviewSha256, authorizationSha256, beforeSnapshot, afterSnapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      auditValues
    );
    if (
      auditInsert?.affectedRows !== 1 ||
      Number(auditInsert.warningStatus ?? 0) !== 0
    )
      fail("AUDIT_INSERT_FAILED");
    const durable = await readAudit(true);
    if (
      !Array.isArray(durable) ||
      durable.length !== 1 ||
      !matchesAudit(durable[0], v) ||
      durable[0].afterSnapshot !== canonical(after)
    )
      fail("AUDIT_READBACK_MISMATCH");
    v.checkFresh();
    if (monotonicNow() - txStarted >= TX_MS)
      fail("TRANSACTION_BUDGET_EXCEEDED");
    commitAttempted = true;
    // Do not route COMMIT through a helper that might throw before sending it:
    // once attempted, any failure is ambiguous until separately reconciled.
    await c.query({ sql: "COMMIT", timeout: QUERY_MS });
    transaction = false;
    return { status: "APPLIED", code: "REFERENCE_AND_PRIVATE_AUDIT_COMMITTED" };
  } catch (error) {
    const code =
      error instanceof WriterFailure ? error.code : "DATABASE_OPERATION_FAILED";
    if (commitAttempted) {
      try {
        c?.destroy();
      } catch {
        /* Preserve ambiguous commit outcome. */
      }
      c = undefined;
      return {
        status: "UNKNOWN",
        code: "COMMIT_OUTCOME_UNKNOWN",
        reconciliation: await reconcile(),
      };
    }
    if (transaction) {
      try {
        await c!.query({ sql: "ROLLBACK", timeout: QUERY_MS });
        transaction = false;
        return { status: "ROLLED_BACK", code };
      } catch {
        return { status: "UNKNOWN", code: "ROLLBACK_NOT_CONFIRMED" };
      }
    }
    return { status: "BLOCKED", code };
  } finally {
    try {
      c?.destroy();
    } catch {
      /* Never convert an acknowledged commit into failure. */
    }
  }

  async function reconcile(): Promise<
    NonNullable<RepairWriterResult["reconciliation"]>
  > {
    let fresh: Connection | undefined;
    try {
      fresh = await connect(options);
      const [raw] = await fresh.query({
        sql: `SELECT ${AUDIT_COLUMNS.map(k => `\`${k}\``).join(", ")} FROM ${TABLE} WHERE sourceType = ? AND sourceId = ? LIMIT 2`,
        values: [TARGET.sourceType, TARGET.sourceId],
        timeout: QUERY_MS,
      });
      if (!Array.isArray(raw) || raw.length > 1) return "CONFLICT";
      if (!raw.length) return "NO_COMMIT_EVIDENCE";
      const row = raw[0] as AuditRecord;
      if (!matchesAudit(row, v)) return "CONFLICT";
      const adapter = {
        query: fresh.query.bind(fresh),
        destroy() {},
      } as unknown as Connection;
      const readers = createRelinkDatabaseReaders(
        config.db,
        async () => adapter
      );
      const current = await readers.readSource(TARGET);
      if (
        !current ||
        canonical(current) !== row.afterSnapshot ||
        !unchangedExceptReference(
          v.intent.before,
          current,
          `r2p:${v.intent.candidate.key}`
        )
      )
        return "CONFLICT";
      return "MATCHING_AUDIT_AND_STATE";
    } catch {
      return "FAILED";
    } finally {
      try {
        fresh?.destroy();
      } catch {
        /* Still UNKNOWN. */
      }
    }
  }
}
