import { describe, expect, it } from "vitest";

import { InMemoryNqaIdempotencyStore } from "./idempotency";

describe("NQA MCP idempotency store", () => {
  it("moves NEW work through IN_PROGRESS to COMPLETED", () => {
    const store = new InMemoryNqaIdempotencyStore();

    const reservation = store.reserve({
      key: "a".repeat(64),
      capability: "nqa.qa.run_semantic",
      requestFingerprint: "request-a",
      principalId: "principal-1",
      now: "2026-09-24T01:00:00+07:00",
    });

    expect(reservation.outcome).toBe("RESERVED");
    expect(reservation.entry.status).toBe("IN_PROGRESS");

    const completed = store.complete({
      key: "a".repeat(64),
      result: { decision: "PASS" },
      now: "2026-09-24T01:00:01+07:00",
    });

    expect(completed).toMatchObject({
      status: "COMPLETED",
      result: { decision: "PASS" },
    });
  });
  it("returns an existing in-progress reservation without overwriting it", () => {
    const store = new InMemoryNqaIdempotencyStore();
    const input = {
      key: "b".repeat(64),
      capability: "nqa.qa.run_semantic",
      requestFingerprint: "request-b",
      principalId: "principal-1",
      now: "2026-09-24T01:00:00+07:00",
    };

    expect(store.reserve(input).outcome).toBe("RESERVED");
    const duplicate = store.reserve({
      ...input,
      now: "2026-09-24T01:00:01+07:00",
    });

    expect(duplicate.outcome).toBe("EXISTS");
    expect(duplicate.entry.status).toBe("IN_PROGRESS");
  });

  it("allows an explicitly failed reservation to be retried", () => {
    const store = new InMemoryNqaIdempotencyStore();
    const key = "c".repeat(64);

    store.reserve({
      key,
      capability: "nqa.qa.run_semantic",
      requestFingerprint: "request-c",
      principalId: "principal-1",
      now: "2026-09-24T01:00:00+07:00",
    });
    store.fail({
      key,
      errorCode: "EXECUTION_FAILED",
      now: "2026-09-24T01:00:01+07:00",
    });

    const retry = store.reserve({
      key,
      capability: "nqa.qa.run_semantic",
      requestFingerprint: "request-c",
      principalId: "principal-1",
      now: "2026-09-24T01:00:02+07:00",
    });

    expect(retry.outcome).toBe("RESERVED");
    expect(retry.entry.status).toBe("IN_PROGRESS");
  });
});
