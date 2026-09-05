import { createHash } from "node:crypto";
import { types } from "node:util";
import { isAuditTrustedLegacyReference } from "../../server/helpers/legacySlipReconciliationPlan";
import { PREVIEW_AUDIT_TARGETS } from "./legacySlipAuditOptions";
import type { RelinkSourceSnapshot } from "./legacySlipRelinkRead";

export const REPAIR_TARGET = Object.freeze({
  sourceType: "order_payment",
  sourceId: 11280001,
} as const);
export const PINNED_REPAIR_PLAN_SHA256 =
  "d89ee2bc6aa911e65a1262a190d60343401faeede6b044276ab44f8be0dffe77";
export const PINNED_REPAIR_RUN_ID = "05e9e0ee-edbc-46ab-bb6e-6527824bd308";

const MAX_PLAN_BYTES = 8 * 1024 * 1024;
const MAX_OBJECT_BYTES = 5 * 1024 * 1024;
const HEX64 = /^[a-f0-9]{64}$/;
const CODES = [
  "INVALID_REPAIR_INPUT",
  "PLAN_TOO_LARGE",
  "PLAN_DIGEST_MISMATCH",
  "INVALID_REPAIR_PLAN",
  "INVALID_REPAIR_INTENT",
  "INVALID_OPERATOR_ATTESTATION",
] as const;
export type RepairErrorCode = (typeof CODES)[number];
/** Fixed public codes only. Never attach a private input or underlying error. */
export class RepairError extends Error {
  readonly code: RepairErrorCode;
  constructor(code: RepairErrorCode) {
    const safe = CODES.includes(code) ? code : "INVALID_REPAIR_INPUT";
    super(safe);
    this.code = safe;
    this.name = "RepairError";
  }
}

export interface RepairCandidate {
  key: string;
  etag: string;
  size: number;
  rawHash: string;
  canonicalHash: string;
  mimeType: "image/jpeg" | "image/png" | "application/pdf";
}
/** Private, immutable-by-copy intent. This value is not authorization to write. */
export interface RepairIntent {
  sourceType: "order_payment";
  sourceId: 11280001;
  planSha256: string;
  planRunId: string;
  targetFingerprint: string;
  before: RelinkSourceSnapshot;
  candidate: RepairCandidate;
  intentSha256: string;
}
export interface OperatorAttestation {
  schema: "legacy-slip-operator-attestation/v1";
  sourceType: "order_payment";
  sourceId: 11280001;
  planSha256: string;
  planRunId: string;
  intentSha256: string;
  targetFingerprint: string;
  candidate: RepairCandidate;
  reviewer: string;
  reason: string;
  evidenceReference: string;
  recordedAt: string;
  sameTransactionConfirmed: true;
  assertionVerification: "OPERATOR_DECLARED_NOT_INDEPENDENTLY_VERIFIED";
  historicalByteIdentity: "UNPROVEN";
  independentReview: null;
  writeAuthorized: false;
}
export type OperatorAttestationInput = Pick<
  OperatorAttestation,
  "reviewer" | "reason" | "evidenceReference" | "recordedAt"
>;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };
function need(ok: unknown): asserts ok {
  if (!ok) throw new Error();
}
function obj(value: Json): Obj {
  need(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Obj;
}
function exact(value: Json, names: readonly string[]): Obj {
  const o = obj(value);
  need(
    Object.keys(o).length === names.length &&
      names.every(n => Object.hasOwn(o, n))
  );
  return o;
}
function empty(value: Json): void {
  need(Array.isArray(value) && value.length === 0);
}
function text(value: Json, max = 65536): asserts value is string {
  need(typeof value === "string" && value.length <= max);
}
function hex(value: Json): asserts value is string {
  need(typeof value === "string" && HEX64.test(value));
}
function positive(value: Json): asserts value is number {
  need(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}
function timestamp(value: Json): void {
  text(value);
  need(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/.test(value));
}
function instant(value: Json): asserts value is string {
  text(value, 24);
  need(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value));
  need(
    Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value
  );
}

/** Reject accessors, proxies, prototypes, cycles, undefined and resource bombs.
 * JSON-compatible data is cloned without executing toJSON or getters. */
function plain(value: unknown): Json {
  const seen = new Set<object>();
  let nodes = 0;
  let budget = MAX_PLAN_BYTES;
  function copy(v: unknown, depth: number): Json {
    need(++nodes <= 100000 && depth <= 64);
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") {
      need(Number.isFinite(v));
      return v;
    }
    if (typeof v === "string") {
      budget -= Buffer.byteLength(v);
      need(budget >= 0);
      return v;
    }
    need(typeof v === "object" && !types.isProxy(v));
    need(!seen.has(v));
    const proto = Object.getPrototypeOf(v);
    need(
      Array.isArray(v)
        ? proto === Array.prototype
        : proto === Object.prototype || proto === null
    );
    seen.add(v);
    const names = Reflect.ownKeys(v);
    need(
      names.every(
        n =>
          typeof n === "string" &&
          !["__proto__", "prototype", "constructor"].includes(n)
      )
    );
    const descriptors = Object.getOwnPropertyDescriptors(v);
    // Return ordinary JSON objects so strict comparisons to fresh DB reader
    // snapshots do not fail solely on prototype identity. Dangerous keys were
    // rejected above; no accessors or custom prototypes survive this copy.
    const out: Json[] | Obj = Array.isArray(v) ? [] : {};
    if (Array.isArray(v)) {
      need(names.length === v.length + 1 && v.length <= 100000);
      for (let i = 0; i < v.length; i++) {
        const d = descriptors[String(i)];
        need(d && Object.hasOwn(d, "value") && d.enumerable);
        (out as Json[]).push(copy(d.value, depth + 1));
      }
    } else {
      for (const name of names as string[]) {
        const d = descriptors[name];
        need(Object.hasOwn(d, "value") && d.enumerable);
        budget -= Buffer.byteLength(name);
        need(budget >= 0);
        (out as Obj)[name] = copy(d.value, depth + 1);
      }
    }
    seen.delete(v);
    return out;
  }
  return copy(value, 0);
}
function canonical(v: Json): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v)
    .sort()
    .map(k => `${JSON.stringify(k)}:${canonical(v[k])}`)
    .join(",")}}`;
}
function same(a: Json, b: Json): boolean {
  return canonical(a) === canonical(b);
}

/** PRIVATE stable serialization for snapshot equality/digests. Never log it. */
export function canonicalRepairJson(value: unknown): string {
  try {
    return canonical(plain(value));
  } catch {
    throw new RepairError("INVALID_REPAIR_INPUT");
  }
}

type Field = "id" | "uint" | "text" | "decimal" | "timestamp";
type Fields = Record<string, Field | `${Field}?`>;
// Mirrors the explicit reader projection. Missing/new fields fail closed rather
// than silently omitting financial, evidence, approval or chronology state.
const PAYMENT_FIELDS: Fields = {
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
};
const WALLET_FIELDS: Fields = {
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
};
const ORDER_FIELDS: Fields = {
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
};
function fields(value: Json, shape: Fields): Obj {
  const o = exact(value, Object.keys(shape));
  for (const [name, type] of Object.entries(shape)) {
    const v = o[name];
    if (v === null && type.endsWith("?")) continue;
    switch (type.replace(/\?$/, "")) {
      case "id":
        positive(v);
        break;
      case "uint":
        need(typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
        break;
      case "decimal":
        text(v);
        need(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(v));
        break;
      case "timestamp":
        timestamp(v);
        break;
      default:
        text(v);
    }
  }
  return o;
}
function snapshot(
  value: Json,
  sourceType: string,
  sourceId: number
): RelinkSourceSnapshot {
  const o = exact(value, ["source", "record", "order", "related", "truncated"]);
  const s = exact(o.source, [
    "sourceType",
    "sourceId",
    "ownerUserId",
    "status",
    "slipImageUrl",
    "slipEvidenceClass",
    "evidenceVersion",
    "slipEvidenceId",
    "extractedEvidenceVersion",
    "extractedData",
    "bindings",
    "claims",
    "relatedReadTruncated",
  ]);
  need(s.sourceType === sourceType && s.sourceId === sourceId);
  need(
    s.status === "approved" &&
      s.slipEvidenceClass === "legacy_compatibility_required" &&
      s.evidenceVersion === 0
  );
  need(
    s.slipEvidenceId === null &&
      s.extractedEvidenceVersion === null &&
      s.extractedData === null
  );
  text(s.slipImageUrl);
  need(isAuditTrustedLegacyReference(s.slipImageUrl));
  positive(s.ownerUserId);
  empty(s.claims);
  empty(s.bindings);
  need(s.relatedReadTruncated === false && o.truncated === false);
  const r = fields(
    o.record,
    sourceType === "order_payment" ? PAYMENT_FIELDS : WALLET_FIELDS
  );
  need(r.id === sourceId);
  for (const name of [
    "status",
    "slipImageUrl",
    "slipEvidenceClass",
    "evidenceVersion",
    "slipEvidenceId",
    "extractedEvidenceVersion",
    "extractedData",
  ])
    need(s[name] === r[name]);
  if (sourceType === "order_payment") {
    const order = fields(o.order, ORDER_FIELDS);
    need(order.id === r.orderId && order.userId === s.ownerUserId);
  } else {
    need(o.order === null && r.userId === s.ownerUserId);
  }
  const related = exact(o.related, [
    "claims",
    "bindings",
    "unknowns",
    "collisions",
  ]);
  empty(related.claims);
  empty(related.bindings);
  empty(related.collisions);
  need(Array.isArray(related.unknowns) && related.unknowns.length <= 20);
  const unknownIds = new Set<number>();
  for (const unknown of related.unknowns) {
    const u = exact(unknown, [
      "id",
      "sourceType",
      "sourceId",
      "reason",
      "recordedAt",
    ]);
    positive(u.id);
    need(!unknownIds.has(u.id));
    unknownIds.add(u.id);
    need(u.sourceType === sourceType && u.sourceId === sourceId);
    text(u.reason);
    timestamp(u.recordedAt);
  }
  return o as unknown as RelinkSourceSnapshot;
}
function candidate(
  value: Json,
  sourceType: string,
  sourceId: number
): RepairCandidate {
  const c = exact(value, [
    "key",
    "etag",
    "size",
    "rawHash",
    "canonicalHash",
    "mimeType",
  ]);
  text(c.key, 1024);
  text(c.etag, 256);
  hex(c.rawHash);
  hex(c.canonicalHash);
  const prefix = `payment-slips/legacy/${sourceType === "order_payment" ? "payments" : "wallet-topups"}/${sourceId}/`;
  need(
    c.key.startsWith(prefix) &&
      /^\d+-[a-z0-9]+\.(jpg|png|pdf)$/.test(c.key.slice(prefix.length))
  );
  need(/^"[A-Za-z0-9._-]+"$/.test(c.etag));
  positive(c.size);
  need(c.size <= MAX_OBJECT_BYTES);
  need(
    c.mimeType === "image/jpeg" ||
      c.mimeType === "image/png" ||
      c.mimeType === "application/pdf"
  );
  need(
    c.key.endsWith(
      c.mimeType === "image/jpeg"
        ? ".jpg"
        : c.mimeType === "image/png"
          ? ".png"
          : ".pdf"
    )
  );
  return c as unknown as RepairCandidate;
}
function intentBase(value: Json): Omit<RepairIntent, "intentSha256"> {
  const o = exact(value, [
    "sourceType",
    "sourceId",
    "planSha256",
    "planRunId",
    "targetFingerprint",
    "before",
    "candidate",
  ]);
  need(
    o.sourceType === REPAIR_TARGET.sourceType &&
      o.sourceId === REPAIR_TARGET.sourceId
  );
  hex(o.planSha256);
  hex(o.targetFingerprint);
  need(o.planRunId === PINNED_REPAIR_RUN_ID);
  snapshot(o.before, REPAIR_TARGET.sourceType, REPAIR_TARGET.sourceId);
  candidate(o.candidate, REPAIR_TARGET.sourceType, REPAIR_TARGET.sourceId);
  return o as unknown as Omit<RepairIntent, "intentSha256">;
}
/** Deterministic private-context digest, NOT proof of mapping or write authority. */
export function digestRepairIntent(
  value: Omit<RepairIntent, "intentSha256">
): string {
  try {
    const clone = plain(value);
    intentBase(clone);
    return createHash("sha256").update(canonical(clone)).digest("hex");
  } catch {
    throw new RepairError("INVALID_REPAIR_INTENT");
  }
}
export function validateRepairIntent(value: unknown): RepairIntent {
  try {
    const o = exact(plain(value), [
      "sourceType",
      "sourceId",
      "planSha256",
      "planRunId",
      "targetFingerprint",
      "before",
      "candidate",
      "intentSha256",
    ]);
    hex(o.intentSha256);
    const { intentSha256, ...rest } = o;
    const base = intentBase(rest);
    need(digestRepairIntent(base) === intentSha256);
    return { ...base, intentSha256 };
  } catch {
    throw new RepairError("INVALID_REPAIR_INTENT");
  }
}

/** Bounded parser rejects duplicate JSON members before canonical validation. */
function parseJson(bytes: Uint8Array): Json {
  const input = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let at = 0,
    nodes = 0;
  function ws() {
    while (/[ \t\r\n]/.test(input[at] ?? "x")) at++;
  }
  function str(): string {
    const start = at++;
    need(input[start] === '"');
    while (at < input.length) {
      const ch = input[at++];
      if (ch === '"') return JSON.parse(input.slice(start, at));
      if (ch === "\\") at++;
    }
    throw new Error();
  }
  function value(depth: number): Json {
    need(depth <= 64 && ++nodes <= 100000);
    ws();
    const ch = input[at];
    if (ch === '"') return str();
    if (ch === "{") {
      at++;
      ws();
      const out: Obj = Object.create(null);
      if (input[at] === "}") {
        at++;
        return out;
      }
      while (true) {
        ws();
        const key = str();
        need(
          !Object.hasOwn(out, key) &&
            !["__proto__", "prototype", "constructor"].includes(key)
        );
        ws();
        need(input[at++] === ":");
        out[key] = value(depth + 1);
        ws();
        const end = input[at++];
        if (end === "}") return out;
        need(end === ",");
      }
    }
    if (ch === "[") {
      at++;
      ws();
      const out: Json[] = [];
      if (input[at] === "]") {
        at++;
        return out;
      }
      while (true) {
        out.push(value(depth + 1));
        ws();
        const end = input[at++];
        if (end === "]") return out;
        need(end === ",");
      }
    }
    const match =
      /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
        input.slice(at)
      );
    need(match);
    at += match[0].length;
    const v = JSON.parse(match[0]);
    need(typeof v !== "number" || Number.isFinite(v));
    return v;
  }
  const parsed = value(0);
  ws();
  need(at === input.length);
  return parsed;
}

function byteLength(bytes: Uint8Array): number {
  need(types.isUint8Array(bytes) && !types.isProxy(bytes));
  // Bypass an attacker-defined own byteLength getter on a typed-array object.
  const getter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype),
    "byteLength"
  )!.get!;
  return Reflect.apply(getter, bytes, []);
}

/** Strict private JSON input reader. No file access; callers enforce file ACLs. */
export function parsePrivateRepairJson(
  bytes: Uint8Array,
  maxBytes = MAX_PLAN_BYTES
): unknown {
  try {
    need(
      Number.isSafeInteger(maxBytes) &&
        maxBytes > 0 &&
        maxBytes <= MAX_PLAN_BYTES
    );
    need(byteLength(bytes) <= maxBytes);
    return plain(parseJson(bytes));
  } catch {
    throw new RepairError("INVALID_REPAIR_INPUT");
  }
}

/** Validate a complete pinned-scope prepare artifact and extract one intent.
 * expectedSha256 comes from a separately trusted operator/CLI pin, never a field
 * in the supplied artifact. All ten context rows are checked, none is authorized. */
export function parseRepairPlan(
  bytes: Uint8Array,
  expectedSha256: string
): RepairIntent {
  try {
    need(typeof expectedSha256 === "string" && HEX64.test(expectedSha256));
    if (byteLength(bytes) > MAX_PLAN_BYTES)
      throw new RepairError("PLAN_TOO_LARGE");
    if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256)
      throw new RepairError("PLAN_DIGEST_MISMATCH");
  } catch (error) {
    if (error instanceof RepairError) throw error;
    throw new RepairError("INVALID_REPAIR_INPUT");
  }
  try {
    const p = exact(parseJson(bytes), [
      "schema",
      "mode",
      "runId",
      "preparedAt",
      "declaredCodeSha",
      "toolSourceDigest",
      "targetFingerprint",
      "codeShaVerification",
      "toolSourceDigestPurpose",
      "targetScope",
      "collisionCoverage",
      "historicalCoverageComplete",
      "snapshotTimestampSemantics",
      "rows",
      "writeAuthorized",
      "isApplyManifest",
      "pointInTimeOnly",
      "requiredNextAction",
    ]);
    need(
      p.schema === "legacy-slip-reference-review-plan/v1" &&
        p.mode === "PREPARE_ONLY" &&
        p.runId === PINNED_REPAIR_RUN_ID
    );
    instant(p.preparedAt);
    text(p.declaredCodeSha);
    need(/^[a-f0-9]{40}$/.test(p.declaredCodeSha));
    hex(p.toolSourceDigest);
    hex(p.targetFingerprint);
    need(
      p.codeShaVerification === "OPERATOR_DECLARED_NOT_VERIFIED" &&
        p.toolSourceDigestPurpose ===
          "EXACT_LOCAL_SOURCE_FINGERPRINT_NOT_DEPLOYMENT_ATTESTATION"
    );
    need(
      p.targetScope === "PINNED_PREVIEW_TEN_LEGACY_RECORDS" &&
        p.collisionCoverage ===
          "KNOWN_REGISTRIES_OBJECT_REFERENCES_AND_THIS_BATCH_ONLY"
    );
    need(
      p.historicalCoverageComplete === false &&
        p.snapshotTimestampSemantics ===
          "DATABASE_SESSION_WALL_TIME_NOT_NORMALIZED_TO_UTC"
    );
    need(
      p.writeAuthorized === false &&
        p.isApplyManifest === false &&
        p.pointInTimeOnly === true &&
        p.requiredNextAction ===
          "HUMAN_MAPPING_REVIEW_THEN_SEPARATE_IMPLEMENTATION_AUTHORIZATION"
    );
    need(
      Array.isArray(p.rows) && p.rows.length === PREVIEW_AUDIT_TARGETS.length
    );
    const seen = new Set<string>(),
      hashes = new Set<string>(),
      keys = new Set<string>();
    let selected: Omit<RepairIntent, "intentSha256"> | undefined;
    for (const value of p.rows) {
      const row = exact(value, [
        "sourceType",
        "sourceId",
        "status",
        "blockers",
        "snapshot",
        "candidate",
        "crossReferences",
        "proposal",
        "mappingProvenance",
        "historicalByteIdentity",
        "approval",
        "writeAuthorized",
        "pointInTimeOnly",
      ]);
      const target = PREVIEW_AUDIT_TARGETS.find(
        t => t.sourceType === row.sourceType && t.sourceId === row.sourceId
      );
      need(target);
      const identity = `${target.sourceType}:${target.sourceId}`;
      need(!seen.has(identity));
      seen.add(identity);
      need(row.status === "NEEDS_ATTESTATION");
      empty(row.blockers);
      need(
        row.mappingProvenance === "UNREVIEWED" &&
          row.historicalByteIdentity === "UNPROVEN" &&
          row.approval === null &&
          row.writeAuthorized === false &&
          row.pointInTimeOnly === true
      );
      const snap = exact(row.snapshot, ["before", "after"]);
      const before = snapshot(snap.before, target.sourceType, target.sourceId);
      snapshot(snap.after, target.sourceType, target.sourceId);
      need(same(snap.before, snap.after));
      const c = exact(row.candidate, ["listing", "candidate", "bytes"]);
      const listing = exact(c.listing, [
        "candidateCount",
        "unexpectedObjectCount",
        "truncated",
      ]);
      need(
        listing.candidateCount === 1 &&
          listing.unexpectedObjectCount === 0 &&
          listing.truncated === false
      );
      const object = exact(c.candidate, ["key", "etag", "size"]),
        body = exact(c.bytes, [
          "rawHash",
          "canonicalHash",
          "byteLength",
          "mimeType",
        ]);
      need(body.byteLength === object.size);
      const selectedCandidate = candidate(
        {
          ...object,
          rawHash: body.rawHash,
          canonicalHash: body.canonicalHash,
          mimeType: body.mimeType,
        },
        target.sourceType,
        target.sourceId
      );
      need(!keys.has(selectedCandidate.key));
      keys.add(selectedCandidate.key);
      const localHashes = new Set([
        selectedCandidate.rawHash,
        selectedCandidate.canonicalHash,
      ]);
      for (const hash of Array.from(localHashes)) {
        need(!hashes.has(hash));
        hashes.add(hash);
      }
      const cross = exact(row.crossReferences, [
        "claims",
        "collisions",
        "bindings",
        "uploads",
        "references",
        "truncated",
      ]);
      need(cross.truncated === false);
      for (const field of [
        "claims",
        "collisions",
        "bindings",
        "uploads",
        "references",
      ])
        empty(cross[field]);
      const proposal = exact(row.proposal, [
        "field",
        "before",
        "after",
        "referenceOnly",
        "preserveAllOtherFields",
        "updatedAtMayChangeAutomatically",
      ]);
      need(
        proposal.field === "slipImageUrl" &&
          proposal.before === before.source.slipImageUrl &&
          proposal.after === `r2p:${selectedCandidate.key}`
      );
      need(
        proposal.referenceOnly === true &&
          proposal.preserveAllOtherFields === true &&
          proposal.updatedAtMayChangeAutomatically === true
      );
      if (
        target.sourceType === REPAIR_TARGET.sourceType &&
        target.sourceId === REPAIR_TARGET.sourceId
      )
        selected = {
          ...REPAIR_TARGET,
          planSha256: expectedSha256,
          planRunId: PINNED_REPAIR_RUN_ID,
          targetFingerprint: p.targetFingerprint,
          before,
          candidate: selectedCandidate,
        };
    }
    need(selected);
    return validateRepairIntent({
      ...selected,
      intentSha256: digestRepairIntent(selected),
    });
  } catch {
    throw new RepairError("INVALID_REPAIR_PLAN");
  }
}

function reviewText(value: Json, max: number): asserts value is string {
  text(value, max);
  need(
    value.length > 0 &&
      value.trim() === value &&
      !/[\u0000-\u001f\u007f]/.test(value)
  );
}
/** A recorded first-human assertion only; never fills independent review. */
export function createOperatorAttestation(
  intent: RepairIntent,
  input: OperatorAttestationInput
): OperatorAttestation {
  try {
    const checked = validateRepairIntent(intent);
    const details = exact(plain(input), [
      "reviewer",
      "reason",
      "evidenceReference",
      "recordedAt",
    ]);
    return validateOperatorAttestation(
      {
        schema: "legacy-slip-operator-attestation/v1",
        ...REPAIR_TARGET,
        planSha256: checked.planSha256,
        planRunId: checked.planRunId,
        intentSha256: checked.intentSha256,
        targetFingerprint: checked.targetFingerprint,
        candidate: checked.candidate,
        ...details,
        sameTransactionConfirmed: true,
        assertionVerification: "OPERATOR_DECLARED_NOT_INDEPENDENTLY_VERIFIED",
        historicalByteIdentity: "UNPROVEN",
        independentReview: null,
        writeAuthorized: false,
      },
      checked
    );
  } catch {
    throw new RepairError("INVALID_OPERATOR_ATTESTATION");
  }
}
export function validateOperatorAttestation(
  value: unknown,
  intent: RepairIntent
): OperatorAttestation {
  try {
    const checked = validateRepairIntent(intent);
    const a = exact(plain(value), [
      "schema",
      "sourceType",
      "sourceId",
      "planSha256",
      "planRunId",
      "intentSha256",
      "targetFingerprint",
      "candidate",
      "reviewer",
      "reason",
      "evidenceReference",
      "recordedAt",
      "sameTransactionConfirmed",
      "assertionVerification",
      "historicalByteIdentity",
      "independentReview",
      "writeAuthorized",
    ]);
    need(
      a.schema === "legacy-slip-operator-attestation/v1" &&
        a.sourceType === REPAIR_TARGET.sourceType &&
        a.sourceId === REPAIR_TARGET.sourceId
    );
    for (const field of [
      "planSha256",
      "planRunId",
      "intentSha256",
      "targetFingerprint",
    ] as const)
      need(a[field] === checked[field]);
    candidate(a.candidate, REPAIR_TARGET.sourceType, REPAIR_TARGET.sourceId);
    need(same(a.candidate, plain(checked.candidate)));
    reviewText(a.reviewer, 200);
    reviewText(a.reason, 2000);
    reviewText(a.evidenceReference, 2048);
    instant(a.recordedAt);
    need(
      a.sameTransactionConfirmed === true &&
        a.assertionVerification ===
          "OPERATOR_DECLARED_NOT_INDEPENDENTLY_VERIFIED" &&
        a.historicalByteIdentity === "UNPROVEN" &&
        a.independentReview === null &&
        a.writeAuthorized === false
    );
    return a as unknown as OperatorAttestation;
  } catch {
    throw new RepairError("INVALID_OPERATOR_ATTESTATION");
  }
}

/** Canonical record binding, not a signature or independent identity check. */
export function digestOperatorAttestation(
  value: OperatorAttestation,
  intent: RepairIntent
): string {
  const checked = validateOperatorAttestation(value, intent);
  return createHash("sha256")
    .update(canonical(plain(checked)))
    .digest("hex");
}

/** Byte-level attestation guard including duplicate members and strict UTF-8. */
export function parseOperatorAttestationBytes(
  bytes: Uint8Array,
  intent: RepairIntent
): OperatorAttestation {
  try {
    return validateOperatorAttestation(
      parsePrivateRepairJson(bytes, 64 * 1024),
      intent
    );
  } catch {
    throw new RepairError("INVALID_OPERATOR_ATTESTATION");
  }
}
