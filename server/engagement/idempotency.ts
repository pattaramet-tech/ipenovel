/**
 * P2R3A pure idempotency engine (no DB, no I/O).
 *
 * Contract (approved P2R2R1):
 *  - No clientRequestKey        -> every request creates a new record; the
 *    caller handles that path before consulting this module.
 *  - Same key + same payload    -> REPLAY the original result (safe retry).
 *  - Same key + different payload -> CONFLICT (key reuse is rejected).
 *
 * Canonicalization (R1 hardened) is restricted to JSON-compatible,
 * Zod-parsed payloads and is computed by a purpose-built recursive encoder:
 *  - Only null / boolean / finite number / string / array / plain object
 *    are accepted. Anything else - undefined, functions, symbols, bigints,
 *    non-finite numbers, Dates, Maps, class instances - is REJECTED with
 *    a clear error instead of silently degrading (JSON.stringify would
 *    return undefined for top-level undefined, drop function values, or
 *    run toJSON on Dates, none of which belong in an idempotency fingerprint).
 *  - Circular references are detected and rejected (path-scoped detection
 *    still allows shared, non-cyclic references).
 *  - Objects are encoded as sorted [key, value] pair arrays, so special
 *    keys such as "__proto__" or "constructor" are just strings inside the
 *    fingerprint - they can never become properties of any object this
 *    module touches.
 *
 * CONCURRENT UNIQUE-KEY RACE (guidance for the future integration - NOT
 * proven by these unit tests): two requests with the same key racing past
 * the existence check are resolved by the database's UNIQUE(userId, key)
 * index. Exactly one INSERT commits; the loser receives a duplicate-key
 * error and MUST re-SELECT the winning row and then re-run this same pure
 * decision (replay or conflict) against the winner's canonical payload.
 * Proving that transactional behavior requires the real database and is
 * explicitly out of scope for this pure module.
 */

export type IdempotencyDecision<T> =
  | { decision: "create" }
  | { decision: "replay"; result: T }
  | { decision: "conflict" };

export class IdempotencyCanonicalizationError extends Error {
  constructor(reason: string) {
    super(`Payload is not canonicalizable: ${reason}`);
    this.name = "IdempotencyCanonicalizationError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deterministic canonical string for a parsed payload. Throws
 * IdempotencyCanonicalizationError for anything outside the supported
 * JSON-compatible value space (including circular structures) - it never
 * returns undefined.
 */
export function canonicalizePayload(payload: unknown): string {
  const seen = new WeakSet<object>();
  const encode = (value: unknown, path: string): string => {
    if (value === null) return "null";
    switch (typeof value) {
      case "boolean":
        return value ? "true" : "false";
      case "number":
        if (!Number.isFinite(value)) {
          throw new IdempotencyCanonicalizationError(`${path}: non-finite number`);
        }
        return JSON.stringify(value); // handles -0 vs 0 and exponent forms deterministically
      case "string":
        return JSON.stringify(value);
      case "object":
        break;
      default:
        // undefined, function, symbol, bigint
        throw new IdempotencyCanonicalizationError(
          `${path}: unsupported ${typeof value} value`
        );
    }

    const obj = value as object;
    if (seen.has(obj)) {
      throw new IdempotencyCanonicalizationError(`${path}: circular reference`);
    }
    seen.add(obj);

    try {
      if (Array.isArray(obj)) {
        // Sparse arrays (new Array(n), holes from `delete`, trailing
        // commas in literals) must never canonicalize as if they were
        // dense - iteration collapses holes to undefined, so "[1,,3]"
        // would fingerprint like "[1,null,3]". Reject holes explicitly.
        for (let i = 0; i < obj.length; i += 1) {
          if (!(i in obj)) {
            throw new IdempotencyCanonicalizationError(`${path}[${i}]: sparse array hole`);
          }
        }
        return "[" + obj.map((item, i) => encode(item, `${path}[${i}]`)).join(",") + "]";
      }
      if (!isPlainObject(obj)) {
        throw new IdempotencyCanonicalizationError(
          `${path}: only plain objects and arrays are supported`
        );
      }
      const keys = Object.keys(obj).sort();
      const pairs = keys.map((key) => {
        const inner = obj[key];
        if (inner === undefined) {
          // An explicitly-present undefined is not representable and must
          // not be silently dropped from a nested object either.
          throw new IdempotencyCanonicalizationError(`${path}.${key}: undefined value`);
        }
        return JSON.stringify(key) + ":" + encode(inner, `${path}.${key}`);
      });
      return "{" + pairs.join(",") + "}";
    } finally {
      seen.delete(obj);
    }
  };
  return encode(payload, "$");
}

export interface IdempotencyStoredRecord<T> {
  /** Canonical payload string captured at creation time. */
  canonicalPayload: string;
  /** The result returned to the client when the record was created. */
  result: T;
}

/**
 * Decide what a retried mutation should do given the stored record (null
 * when the key has never been seen) and the incoming parsed payload.
 *
 * The incoming payload is canonicalized (validated) BEFORE any decision is
 * returned - including the `stored === null` path. An unsupported payload
 * therefore fails loudly with IdempotencyCanonicalizationError even when
 * the key has never been seen: a payload this module cannot fingerprint
 * must never be admitted into the idempotency record at all.
 */
export function resolveIdempotency<T>(input: {
  stored: IdempotencyStoredRecord<T> | null;
  incomingPayload: unknown;
}): IdempotencyDecision<T> {
  const { stored, incomingPayload } = input;
  const incomingCanonical = canonicalizePayload(incomingPayload);
  if (stored === null) return { decision: "create" };
  if (incomingCanonical === stored.canonicalPayload) {
    return { decision: "replay", result: stored.result };
  }
  return { decision: "conflict" };
}
