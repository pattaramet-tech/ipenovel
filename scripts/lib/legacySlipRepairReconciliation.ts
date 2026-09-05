import mysql, { type Connection } from "mysql2/promise";
import type { LegacySlipAuditEnvironment } from "./legacySlipAuditOptions";
import { canonicalRepairJson } from "./legacySlipRepairContract";
import { createRelinkDatabaseReaders } from "./legacySlipRelinkRead";
import {
  validateRepairAuthorityRecords,
  type RepairAuthorityInput,
} from "./legacySlipRepairWriter";

export type RepairReconciliationResult = {
  status:
    | "MATCHING_AUDIT_AND_STATE"
    | "NO_COMMIT_EVIDENCE"
    | "CONFLICT"
    | "UNKNOWN"
    | "BLOCKED";
  code: string;
};
export interface RepairReconciliationDependencies {
  connect?: (options: mysql.ConnectionOptions) => Promise<Connection>;
  monotonicNow?: () => number;
}

const TARGET = { sourceType: "order_payment", sourceId: 11280001 } as const;
const TABLE = "legacySlipReferenceRepairAudit";
const TABLES = [
  "payments",
  "orders",
  "paymentSlipClaims",
  "slipEvidenceBindings",
  "paymentSlipLegacyUnknown",
  "paymentSlipLegacyCollisions",
  TABLE,
];
const AUDIT_FIELDS = [
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
];

/** Inspect retained, possibly expired authority records, NEVER renew them.
 * SELECTs share one InnoDB read-only snapshot. An absent audit is only absence
 * of evidence in that snapshot, not proof of rollback or permission to retry.
 * No R2, UPDATE, DDL, application pool, or calls to the writer are permitted. */
export async function reconcileLegacySlipRepair(
  input: RepairAuthorityInput,
  config: LegacySlipAuditEnvironment,
  dependencies: RepairReconciliationDependencies = {}
): Promise<RepairReconciliationResult> {
  let records: ReturnType<typeof validateRepairAuthorityRecords>;
  let options: mysql.ConnectionOptions;
  try {
    const frozenConfig = structuredClone(config);
    records = validateRepairAuthorityRecords(input, frozenConfig);
    options = {
      ...frozenConfig.db,
      connectTimeout: 5000,
      dateStrings: true,
      decimalNumbers: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
      multipleStatements: false,
    };
  } catch {
    return { status: "BLOCKED", code: "INVALID_RECONCILIATION_CONTEXT" };
  }
  const clock = dependencies.monotonicNow ?? (() => performance.now());
  const start = clock();
  let connection: Connection | undefined;
  let transaction = false;
  const query = async (sql: string, values: unknown[] = []): Promise<any> => {
    const checkTime = () => {
      const elapsed = clock() - start;
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 30000)
        throw new Error("DEADLINE");
    };
    checkTime();
    const [rows] = await connection!.query({ sql, values, timeout: 5000 });
    checkTime();
    return rows;
  };
  try {
    connection = await (dependencies.connect ?? mysql.createConnection)(
      options
    );
    await query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await query("START TRANSACTION READ ONLY, WITH CONSISTENT SNAPSHOT");
    transaction = true;
    const rows = await query(
      `SELECT ${AUDIT_FIELDS.map(k => `\`${k}\``).join(", ")} FROM ${TABLE} WHERE sourceType = ? AND sourceId = ? LIMIT 2`,
      [TARGET.sourceType, TARGET.sourceId]
    );
    // Acquire source-table metadata locks before checking their engines, without
    // row locks or a mixed view of an earlier audit and a later payment image.
    const adapter = {
      query: async ({ sql, values }: { sql: string; values?: unknown[] }) => [
        await query(sql, values),
        [],
      ],
      destroy() {},
    } as unknown as Connection;
    const readers = createRelinkDatabaseReaders(config.db, async () => adapter);
    const current = await readers.readSource(TARGET);
    const tables = await query(
      `SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_COMMENT AS comment FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${TABLES.map(() => "?").join(",")})`,
      TABLES
    );
    if (
      !Array.isArray(tables) ||
      tables.length !== TABLES.length ||
      TABLES.some(
        name =>
          !tables.some(
            row =>
              row.name === name &&
              row.engine === "InnoDB" &&
              (name !== TABLE ||
                row.comment === "legacy-slip-reference-repair-audit/v1")
          )
      )
    ) {
      return { status: "UNKNOWN", code: "RECONCILIATION_SCHEMA_NOT_READY" };
    }
    if (!Array.isArray(rows) || rows.length > 1)
      return { status: "CONFLICT", code: "AUDIT_CONFLICT" };
    if (!rows.length)
      return {
        status: "NO_COMMIT_EVIDENCE",
        code: "AUDIT_ABSENT_NOT_RETRY_AUTHORIZATION",
      };
    const row = rows[0];
    const { intent, primarySha, secondSha, authSha } = records;
    const expected = {
      sourceType: TARGET.sourceType,
      sourceId: TARGET.sourceId,
      intentSha256: intent.intentSha256,
      operationId: records.input.authorization.operationId,
      planSha256: intent.planSha256,
      planRunId: intent.planRunId,
      targetFingerprint: intent.targetFingerprint,
      operatorAttestationSha256: primarySha,
      secondReviewSha256: secondSha,
      authorizationSha256: authSha,
      beforeSnapshot: canonicalRepairJson(intent.before),
    };
    if (
      !row ||
      typeof row !== "object" ||
      Object.entries(expected).some(([key, value]) =>
        key === "sourceId"
          ? String(row[key]) !== String(value)
          : row[key] !== value
      ) ||
      typeof row.afterSnapshot !== "string" ||
      !current ||
      current.truncated
    ) {
      return { status: "CONFLICT", code: "AUDIT_OR_STATE_MISMATCH" };
    }
    const allowedAfter = structuredClone(intent.before);
    allowedAfter.source.slipImageUrl = `r2p:${intent.candidate.key}`;
    allowedAfter.record.slipImageUrl = `r2p:${intent.candidate.key}`;
    allowedAfter.record.updatedAt = current.record.updatedAt;
    if (
      canonicalRepairJson(current) !== row.afterSnapshot ||
      canonicalRepairJson(current) !== canonicalRepairJson(allowedAfter)
    ) {
      return { status: "CONFLICT", code: "AUDIT_OR_STATE_MISMATCH" };
    }
    return {
      status: "MATCHING_AUDIT_AND_STATE",
      code: "EXACT_COMMIT_EVIDENCE_AT_READ_SNAPSHOT",
    };
  } catch {
    return { status: "UNKNOWN", code: "RECONCILIATION_READ_FAILED" };
  } finally {
    if (transaction) {
      try {
        await connection!.query({ sql: "ROLLBACK", timeout: 5000 });
      } catch {
        /* Read-only; close the connection below. */
      }
    }
    try {
      connection?.destroy();
    } catch {
      /* Never initiate a mutation/retry. */
    }
  }
}
