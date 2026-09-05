import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import type { AuditSource } from "../../server/helpers/legacySlipReconciliationPlan";
import type { AuditTarget } from "./legacySlipAuditRuntime";
import {
  PREVIEW_AUDIT_TARGETS,
  type LegacySlipAuditEnvironment,
} from "./legacySlipAuditOptions";

/** PRIVATE review data. Never log this type, query parameters or raw errors. */
export type JsonRecord = Record<string, string | number | boolean | null>;
export interface RelinkSourceSnapshot {
  source: AuditSource;
  record: JsonRecord;
  order: JsonRecord | null;
  related: {
    claims: JsonRecord[];
    bindings: JsonRecord[];
    unknowns: JsonRecord[];
    collisions: JsonRecord[];
  };
  truncated: boolean;
}
export interface RelinkCrossReferences {
  claims: JsonRecord[];
  collisions: JsonRecord[];
  bindings: JsonRecord[];
  uploads: JsonRecord[];
  references: JsonRecord[];
  truncated: boolean;
}
type ReadCode =
  "SOURCE_READ_FAILED" | "CROSS_REFERENCE_READ_FAILED" | "INVALID_TARGET";
export class RelinkReadError extends Error {
  constructor(readonly code: ReadCode) {
    super(code);
    this.name = "RelinkReadError";
  }
}

type FieldKind =
  "id" | "uint" | "text" | "decimal" | "timestamp" | "sourceType";
type FieldType = FieldKind | `${FieldKind}?`;
type Fields = Readonly<Record<string, FieldType>>;
const LIMIT = 20;
const SENTINEL_LIMIT = LIMIT + 1;
const QUERY_TIMEOUT_MS = 5_000;

// Explicit schema columns, not SELECT *. Keep all financial, approval, OCR,
// evidence and chronology fields in the private snapshot. There is no currency
// column in these three tables. DECIMAL and timestamp values stay strings.
const PAYMENT_FIELDS = {
  id: "id",
  orderId: "id",
  slipImageUrl: "text?",
  slipSubmittedAt: "timestamp?",
  evidenceVersion: "uint",
  slipEvidenceClass: "text",
  slipEvidenceId: "id?",
  extractedEvidenceVersion: "uint?",
  status: "text",
  rejectionReason: "text?",
  reviewedByUserId: "id?",
  reviewedAt: "timestamp?",
  extractedData: "text?",
  reviewReason: "text?",
  fingerprint: "text?",
  autoApprovedAt: "timestamp?",
  linkedOrderId: "id?",
  linkedPaymentId: "id?",
  ocrConfidence: "uint",
  ocrDecision: "text",
  approvalSource: "text?",
  approvedByAdminId: "id?",
  approvedByLabel: "text?",
  approvedAt: "timestamp?",
  createdAt: "timestamp",
  updatedAt: "timestamp",
} as const satisfies Fields;
const WALLET_FIELDS = {
  id: "id",
  userId: "id",
  requestedAmount: "decimal",
  bonusAmount: "decimal",
  creditedAmount: "decimal?",
  slipImageUrl: "text?",
  slipSubmittedAt: "timestamp?",
  evidenceVersion: "uint",
  slipEvidenceClass: "text",
  slipEvidenceId: "id?",
  extractedEvidenceVersion: "uint?",
  status: "text",
  rejectionReason: "text?",
  reviewedByUserId: "id?",
  reviewedAt: "timestamp?",
  approvedAt: "timestamp?",
  approvedByAdminId: "id?",
  rejectedAt: "timestamp?",
  extractedData: "text?",
  ocrConfidence: "decimal?",
  visionConfidence: "decimal?",
  structuredConfidence: "decimal?",
  finalConfidence: "decimal?",
  duplicateStatus: "text?",
  ocrDecision: "text?",
  reviewReason: "text?",
  approvalSource: "text?",
  createdAt: "timestamp",
  updatedAt: "timestamp",
} as const satisfies Fields;
const ORDER_FIELDS = {
  id: "id",
  orderNumber: "text",
  userId: "id?",
  subtotal: "decimal",
  discountAmount: "decimal",
  pointsDiscountAmount: "decimal",
  totalAmount: "decimal",
  status: "text",
  paymentStatus: "text",
  couponCodeSnapshot: "text?",
  notes: "text?",
  createdAt: "timestamp",
  updatedAt: "timestamp",
} as const satisfies Fields;
const CLAIM_FIELDS = {
  id: "id",
  sourceType: "sourceType",
  sourceId: "id",
  userId: "id",
  referenceHash: "text?",
  legacyReferenceUpperHash: "text?",
  fileHash: "text?",
  qrPayloadHash: "text?",
  semanticFingerprint: "text?",
  claimedAt: "timestamp",
} as const satisfies Fields;
const BINDING_FIELDS = {
  id: "id",
  uploadId: "id?",
  sourceType: "sourceType",
  sourceId: "id",
  ownerUserId: "id",
  evidenceVersion: "uint",
  evidenceClass: "text",
  objectIdentity: "text",
  fileHash: "text",
  objectSize: "uint?",
  mimeType: "text?",
  createdAt: "timestamp",
} as const satisfies Fields;
const UPLOAD_FIELDS = {
  id: "id",
  objectIdentity: "text",
  ownerUserId: "id",
  fileHash: "text",
  objectSize: "uint",
  mimeType: "text",
  createdAt: "timestamp",
} as const satisfies Fields;
const COLLISION_FIELDS = {
  id: "id",
  kind: "text",
  identifierHash: "text",
  sourceType: "sourceType",
  sourceId: "id",
  recordedAt: "timestamp",
} as const satisfies Fields;
const UNKNOWN_FIELDS = {
  id: "id",
  sourceType: "sourceType",
  sourceId: "id",
  reason: "text",
  recordedAt: "timestamp",
} as const satisfies Fields;
const REFERENCE_FIELDS = {
  id: "id",
  sourceType: "sourceType",
  slipImageUrl: "text",
  status: "text",
  evidenceVersion: "uint",
  slipEvidenceClass: "text",
  slipEvidenceId: "id?",
} as const satisfies Fields;

function requireTarget(target: AuditTarget): void {
  if (
    !target ||
    !PREVIEW_AUDIT_TARGETS.some(
      t => t.sourceType === target.sourceType && t.sourceId === target.sourceId
    )
  )
    throw new RelinkReadError("INVALID_TARGET");
}

function fieldsSql(fields: Fields, alias?: string): string {
  return Object.keys(fields)
    .map(field => `${alias ? `${alias}.` : ""}\`${field}\``)
    .join(", ");
}

function normalize(value: unknown, type: FieldType): string | number | null {
  if (type.endsWith("?") && value === null) return null;
  const kind = type.replace(/\?$/, "") as FieldKind;
  if (kind === "id" || kind === "uint") {
    if (typeof value !== "number" && typeof value !== "string")
      throw new Error();
    if (typeof value === "string" && !/^(0|[1-9][0-9]*)$/.test(value))
      throw new Error();
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < (kind === "id" ? 1 : 0))
      throw new Error();
    return result;
  }
  if (typeof value !== "string") throw new Error();
  if (kind === "decimal" && !/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value))
    throw new Error();
  if (
    kind === "timestamp" &&
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/.test(value)
  )
    throw new Error();
  if (
    kind === "sourceType" &&
    value !== "order_payment" &&
    value !== "wallet_topup"
  )
    throw new Error();
  return value;
}

function normalizeRecord(row: unknown, fields: Fields): JsonRecord {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error();
  const input = row as Record<string, unknown>;
  const expected = Object.keys(fields);
  if (
    Object.keys(input).length !== expected.length ||
    Object.keys(input).some(k => !Object.hasOwn(fields, k))
  )
    throw new Error();
  const result: JsonRecord = {};
  for (const name of expected)
    result[name] = normalize(input[name], fields[name]);
  return result;
}

type Query = (
  sql: string,
  values: unknown[],
  limit: number
) => Promise<RowDataPacket[]>;
type ConnectConfig = LegacySlipAuditEnvironment["db"] & {
  dateStrings: true;
  decimalNumbers: false;
};
type Connect = (config: ConnectConfig) => Promise<Connection>;

/**
 * Fresh, autocommit SELECT-only connection for each call, destroyed before
 * returning. No row locks, long transaction, write, or R2 access. These are
 * point-in-time review snapshots, NOT atomic apply authority. The orchestrator
 * must compare fresh before/after snapshots around object I/O.
 */
export function createRelinkDatabaseReaders(
  config: LegacySlipAuditEnvironment["db"],
  connect: Connect = mysql.createConnection
) {
  async function withReadConnection<T>(
    code: Exclude<ReadCode, "INVALID_TARGET">,
    work: (query: Query) => Promise<T>
  ): Promise<T> {
    let connection: Connection | undefined;
    try {
      connection = await connect({
        ...config,
        connectTimeout: 5_000,
        supportBigNumbers: true,
        bigNumberStrings: true,
        multipleStatements: false,
        dateStrings: true,
        decimalNumbers: false,
      });
      const query: Query = async (sql, values, limit) => {
        const [rows] = await connection!.query<RowDataPacket[]>({
          sql,
          values,
          timeout: QUERY_TIMEOUT_MS,
        });
        if (!Array.isArray(rows) || rows.length > limit) throw new Error();
        return rows;
      };
      return await work(query);
    } catch {
      throw new RelinkReadError(code);
    } finally {
      try {
        connection?.destroy();
      } catch {
        throw new RelinkReadError(code);
      }
    }
  }

  async function readSource(
    target: AuditTarget
  ): Promise<RelinkSourceSnapshot | null> {
    requireTarget(target);
    return withReadConnection("SOURCE_READ_FAILED", async query => {
      const isPayment = target.sourceType === "order_payment";
      const fields = isPayment ? PAYMENT_FIELDS : WALLET_FIELDS;
      const sourceRows = await query(
        isPayment
          ? `SELECT ${fieldsSql(PAYMENT_FIELDS, "p")}, o.userId AS ownerUserId FROM payments p LEFT JOIN orders o ON o.id = p.orderId WHERE p.id = ? LIMIT 1`
          : `SELECT ${fieldsSql(WALLET_FIELDS)} FROM walletTopups WHERE id = ? LIMIT 1`,
        [target.sourceId],
        1
      );
      if (!sourceRows[0]) return null;
      const sourceRow = { ...sourceRows[0] };
      const joinedOwner = isPayment
        ? normalize(sourceRow.ownerUserId, "id?")
        : null;
      if (isPayment) delete sourceRow.ownerUserId;
      const record = normalizeRecord(sourceRow, fields);
      if (record.id !== target.sourceId) throw new Error();
      let order: JsonRecord | null = null;
      if (isPayment) {
        const [orderRow] = await query(
          `SELECT ${fieldsSql(ORDER_FIELDS)} FROM orders WHERE id = ? LIMIT 1`,
          [record.orderId],
          1
        );
        order = orderRow ? normalizeRecord(orderRow, ORDER_FIELDS) : null;
        if (order && order.id !== record.orderId) throw new Error();
        if ((order?.userId ?? null) !== joinedOwner) throw new Error();
      }
      const bySource = async (table: string, selected: Fields) => {
        const rows = await query(
          `SELECT ${fieldsSql(selected)} FROM ${table} WHERE sourceType = ? AND sourceId = ? ORDER BY id LIMIT 21`,
          [target.sourceType, target.sourceId],
          SENTINEL_LIMIT
        );
        return rows.map(row => {
          const normalized = normalizeRecord(row, selected);
          if (
            normalized.sourceType !== target.sourceType ||
            normalized.sourceId !== target.sourceId
          )
            throw new Error();
          return normalized;
        });
      };
      const claims = await bySource("paymentSlipClaims", CLAIM_FIELDS);
      const bindings = await bySource("slipEvidenceBindings", BINDING_FIELDS);
      const unknowns = await bySource(
        "paymentSlipLegacyUnknown",
        UNKNOWN_FIELDS
      );
      const collisions = await bySource(
        "paymentSlipLegacyCollisions",
        COLLISION_FIELDS
      );
      const related = { claims, bindings, unknowns, collisions };
      const truncated = Object.values(related).some(
        rows => rows.length > LIMIT
      );
      const source: AuditSource = {
        ...target,
        ownerUserId: (isPayment ? joinedOwner : record.userId) as number | null,
        status: record.status as string,
        slipImageUrl: record.slipImageUrl as string | null,
        slipEvidenceClass: record.slipEvidenceClass as string,
        evidenceVersion: record.evidenceVersion as number,
        slipEvidenceId: record.slipEvidenceId as number | null,
        extractedEvidenceVersion: record.extractedEvidenceVersion as
          number | null,
        extractedData: record.extractedData as string | null,
        claims: claims.map(row => ({
          id: row.id as number,
          userId: row.userId as number,
          fileHash: row.fileHash as string | null,
        })),
        bindings: bindings.map(row => ({ id: row.id as number })),
        relatedReadTruncated: truncated,
      };
      return { source, record, order, related, truncated };
    });
  }

  async function readCrossReferences(input: {
    target: AuditTarget;
    canonicalHash: string;
    rawHash: string;
    key: string;
  }): Promise<RelinkCrossReferences> {
    requireTarget(input?.target);
    const { target, canonicalHash, rawHash, key } = input;
    const folder =
      target.sourceType === "order_payment" ? "payments" : "wallet-topups";
    const prefix = `payment-slips/legacy/${folder}/${target.sourceId}/`;
    if (
      typeof canonicalHash !== "string" ||
      typeof rawHash !== "string" ||
      !/^[a-f0-9]{64}$/i.test(canonicalHash) ||
      !/^[a-f0-9]{64}$/i.test(rawHash) ||
      typeof key !== "string" ||
      !key.startsWith(prefix) ||
      !/^\d+-[a-z0-9]+\.(jpg|png|pdf)$/.test(key.slice(prefix.length))
    )
      throw new RelinkReadError("CROSS_REFERENCE_READ_FAILED");
    const ref = `r2p:${key}`;
    return withReadConnection("CROSS_REFERENCE_READ_FAILED", async query => {
      const read = async (
        table: string,
        selected: Fields,
        where: string,
        values: unknown[]
      ) =>
        (
          await query(
            `SELECT ${fieldsSql(selected)} FROM ${table} WHERE ${where} ORDER BY id LIMIT 21`,
            values,
            SENTINEL_LIMIT
          )
        ).map(row => normalizeRecord(row, selected));
      const hashes = [canonicalHash, rawHash];
      const claims = await read(
        "paymentSlipClaims",
        CLAIM_FIELDS,
        "fileHash IN (?, ?)",
        hashes
      );
      const collisions = await read(
        "paymentSlipLegacyCollisions",
        COLLISION_FIELDS,
        "kind = 'file' AND identifierHash IN (?, ?)",
        hashes
      );
      const objectWhere = "fileHash IN (?, ?) OR objectIdentity IN (?, ?)";
      const objectValues = [canonicalHash, rawHash, key, ref];
      const bindings = await read(
        "slipEvidenceBindings",
        BINDING_FIELDS,
        objectWhere,
        objectValues
      );
      const uploads = await read(
        "slipEvidenceUploads",
        UPLOAD_FIELDS,
        objectWhere,
        objectValues
      );
      const references: JsonRecord[] = [];
      let referenceTruncated = false;
      for (const [table, sourceType] of [
        ["payments", "order_payment"],
        ["walletTopups", "wallet_topup"],
      ] as const) {
        // This TEXT field has no hash/index in the current schema. LIMIT bounds
        // rows returned, the query timeout bounds work; never fetch slip bytes.
        const rows = await query(
          `SELECT id, '${sourceType}' AS sourceType, slipImageUrl, status, evidenceVersion, slipEvidenceClass, slipEvidenceId FROM ${table} WHERE BINARY slipImageUrl = BINARY ? ORDER BY id LIMIT 21`,
          [ref],
          SENTINEL_LIMIT
        );
        referenceTruncated ||= rows.length > LIMIT;
        references.push(
          ...rows.map(row => {
            const normalized = normalizeRecord(row, REFERENCE_FIELDS);
            if (
              normalized.sourceType !== sourceType ||
              normalized.slipImageUrl !== ref
            )
              throw new Error();
            return normalized;
          })
        );
      }
      return {
        claims,
        collisions,
        bindings,
        uploads,
        references,
        truncated:
          referenceTruncated ||
          [claims, collisions, bindings, uploads].some(
            rows => rows.length > LIMIT
          ),
      };
    });
  }

  return { readSource, readCrossReferences };
}
