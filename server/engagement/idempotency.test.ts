import { describe, expect, it } from "vitest";
import {
  canonicalizePayload,
  resolveIdempotency,
  IdempotencyCanonicalizationError,
} from "./idempotency";

describe("canonicalizePayload", () => {
  it("sorts object keys recursively so key order cannot cause conflicts", () => {
    const a = { subject: "s", message: "m", nested: { z: 1, a: 2 } };
    const b = { message: "m", nested: { a: 2, z: 1 }, subject: "s" };
    expect(canonicalizePayload(a)).toBe(canonicalizePayload(b));
  });
  it("keeps nulls and distinguishes them from missing keys", () => {
    expect(canonicalizePayload({ a: 1, c: null })).toBe(canonicalizePayload({ c: null, a: 1 }));
    expect(canonicalizePayload({ a: 1, c: null })).not.toBe(canonicalizePayload({ a: 1 }));
  });
  it("keeps array order (order is semantic)", () => {
    expect(canonicalizePayload([1, 2])).not.toBe(canonicalizePayload([2, 1]));
  });
  it("distinguishes genuinely different payloads", () => {
    expect(canonicalizePayload({ message: "a" })).not.toBe(canonicalizePayload({ message: "b" }));
  });

  it("REGRESSION (R1): never returns undefined - top-level unsupported values are rejected", () => {
    for (const bad of [undefined, () => {}, Symbol("x"), 10n]) {
      expect(() => canonicalizePayload(bad)).toThrow(IdempotencyCanonicalizationError);
    }
    // the historical hazard: JSON.stringify(undefined) === undefined
    expect(canonicalizePayload(null)).toBe("null");
    expect(typeof canonicalizePayload({ a: 1 })).toBe("string");
  });
  it("REGRESSION (R1): rejects unsupported JSON-incompatible values anywhere in the tree", () => {
    expect(() => canonicalizePayload({ nested: { deep: new Date(0) } })).toThrow(IdempotencyCanonicalizationError);
    expect(() => canonicalizePayload({ m: new Map() })).toThrow(IdempotencyCanonicalizationError);
    expect(() => canonicalizePayload({ fn: () => {} })).toThrow(IdempotencyCanonicalizationError);
    expect(() => canonicalizePayload({ b: 1n })).toThrow(IdempotencyCanonicalizationError);
    expect(() => canonicalizePayload({ inf: Number.POSITIVE_INFINITY })).toThrow(IdempotencyCanonicalizationError);
    expect(() => canonicalizePayload({ nan: Number.NaN })).toThrow(IdempotencyCanonicalizationError);
    expect(() => canonicalizePayload([1, undefined, 2])).toThrow(IdempotencyCanonicalizationError);
    expect(() => canonicalizePayload({ a: { present: undefined } })).toThrow(IdempotencyCanonicalizationError);
    expect(() => canonicalizePayload(new (class Thing {})())).toThrow(IdempotencyCanonicalizationError);
  });
  it("REGRESSION (R1): rejects circular references, allows shared non-cyclic references", () => {
    const circular: Record<string, unknown> = { self: null };
    circular.self = circular;
    expect(() => canonicalizePayload(circular)).toThrow(IdempotencyCanonicalizationError);

    const shared = { s: 1 };
    const dag = { x: shared, y: shared }; // same object twice, NOT a cycle
    expect(() => canonicalizePayload(dag)).not.toThrow();
    expect(canonicalizePayload(dag)).toBe(canonicalizePayload({ y: { s: 1 }, x: { s: 1 } }));
  });
  it("REGRESSION (R2): sparse arrays are rejected - never canonicalized as dense or empty", () => {
    // new Array(n): length n but every slot is a hole
    expect(() => canonicalizePayload(new Array(1))).toThrow(IdempotencyCanonicalizationError);
    expect(() => canonicalizePayload(new Array(3))).toThrow(IdempotencyCanonicalizationError);
    // interior holes
    const holed = [1, , 3];
    expect(() => canonicalizePayload(holed)).toThrow(IdempotencyCanonicalizationError);
    expect(() => canonicalizePayload([,])).toThrow(IdempotencyCanonicalizationError);
    // hole deep inside a tree is still rejected, with a locatable path
    expect(() => canonicalizePayload({ a: { b: [1, , 2] } })).toThrow(/a\.b\[1\]/);
    // dense arrays (including empty) still pass unchanged
    expect(canonicalizePayload([])).toBe("[]");
    expect(canonicalizePayload([1, null, 3])).toBe("[1,null,3]");
    expect(canonicalizePayload({ list: [1, 2, 3] })).toBe(canonicalizePayload({ list: [1, 2, 3] }));
  });
  it("REGRESSION (R2): circular and shared references keep their R1 behavior (cycle reject / DAG accept)", () => {
    const circular: Record<string, unknown> = { list: [] };
    circular.list.push(circular);
    expect(() => canonicalizePayload(circular)).toThrow(IdempotencyCanonicalizationError);

    const shared = { s: 1 };
    expect(() => canonicalizePayload([shared, shared])).not.toThrow();
    expect(canonicalizePayload([shared, shared])).toBe(canonicalizePayload([{ s: 1 }, { s: 1 }]));
  });
  it("REGRESSION (R1): special object keys are inert strings - no prototype/special-key effects", () => {
    const tricky = JSON.parse('{"__proto__": {"x": 1}, "constructor": "c"}');
    expect(() => canonicalizePayload(tricky)).not.toThrow();
    // same content under different key order still canonicalizes equal
    const reordered = JSON.parse('{"constructor": "c", "__proto__": {"x": 1}}');
    expect(canonicalizePayload(tricky)).toBe(canonicalizePayload(reordered));
    // and the canonical form of a payload never becomes a live object again
    const out = canonicalizePayload(tricky);
    expect(typeof out).toBe("string");
    expect(out).toContain("__proto__"); // present as TEXT inside the fingerprint
  });
});

describe("resolveIdempotency", () => {
  const stored = { canonicalPayload: canonicalizePayload({ message: "hello" }), result: { id: 42 } };

  it("no stored record -> create", () => {
    expect(resolveIdempotency({ stored: null, incomingPayload: { message: "x" } })).toEqual({
      decision: "create",
    });
  });
  it("REGRESSION (R2): validation happens BEFORE the decision - unsupported payload throws even with no stored record", () => {
    for (const bad of [
      new Array(2), // sparse
      { nested: new Date(0) },
      undefined,
      { fn: () => {} },
    ]) {
      expect(() => resolveIdempotency({ stored: null, incomingPayload: bad })).toThrow(
        IdempotencyCanonicalizationError
      );
    }
    // valid payload + no record still creates
    expect(resolveIdempotency({ stored: null, incomingPayload: { ok: 1 } }).decision).toBe("create");
  });
  it("same key + same canonical payload -> replay the ORIGINAL result", () => {
    // different key ORDER - still the same canonical form
    const incoming = { message: "hello" };
    expect(resolveIdempotency({ stored, incomingPayload: incoming })).toEqual({
      decision: "replay",
      result: { id: 42 },
    });
  });
  it("same key + different payload -> conflict", () => {
    expect(resolveIdempotency({ stored, incomingPayload: { message: "changed" } })).toEqual({
      decision: "conflict",
    });
  });
  it("replays are value-stable: replaying twice yields the identical result object", () => {
    const first = resolveIdempotency({ stored, incomingPayload: { message: "hello" } });
    const second = resolveIdempotency({ stored, incomingPayload: { message: "hello" } });
    expect(first).toEqual(second);
  });
  it("an incoming payload that cannot be canonicalized rejects loudly (no silent create/compare)", () => {
    expect(() => resolveIdempotency({ stored, incomingPayload: { bad: new Date() } })).toThrow(
      IdempotencyCanonicalizationError
    );
  });
  it("documented race guidance: the loser of a unique-key race re-runs this decision (no DB proof here)", () => {
    // Simulates the post-duplicate-key-error path: loser re-selects the
    // winner's stored record and applies the SAME pure rules. This is the
    // unit-level stand-in; real transactional concurrency is proven only
    // by the future database integration tests.
    const loserSeesWinner = stored;
    const samePayload = resolveIdempotency({ stored: loserSeesWinner, incomingPayload: { message: "hello" } });
    expect(samePayload.decision).toBe("replay");
    const differentPayload = resolveIdempotency({ stored: loserSeesWinner, incomingPayload: { message: "nope" } });
    expect(differentPayload.decision).toBe("conflict");
  });
});
