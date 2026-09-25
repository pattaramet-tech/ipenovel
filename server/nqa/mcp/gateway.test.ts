import { describe, expect, it, vi } from "vitest";

import {
  NQA_CAPABILITIES,
  NQA_V1_ENABLED_PERMISSION_TIERS,
} from "../controlPlane";
import { InMemoryNqaGatewayAuditSink } from "./audit";
import { NqaMcpGateway } from "./gateway";
import { NqaGatewayHandlerRegistry } from "./handlers";
import { InMemoryNqaIdempotencyStore } from "./idempotency";

const NOW = "2026-09-24T01:00:00+07:00";

function principal(
  permissions: Array<"READ" | "QA_OPERATE">,
  authenticated = true
) {
  return {
    principalId: "trusted-principal",
    sessionId: "session-1",
    permissions,
    authenticated,
  };
}

function request(capability: string, overrides: Record<string, unknown> = {}) {
  return {
    requestId: "req-1",
    correlationId: "corr-1",
    actorId: "claimed-actor",
    capability,
    target: { row: 1562, chapter: 197 },
    requestedAt: NOW,
    ...overrides,
  };
}

function createGateway(
  handlers: ConstructorParameters<typeof NqaGatewayHandlerRegistry>[0] = {},
  enabledPermissionTiers?: readonly ("READ" | "QA_OPERATE")[]
) {
  const auditSink = new InMemoryNqaGatewayAuditSink();
  const idempotencyStore = new InMemoryNqaIdempotencyStore();
  const gateway = new NqaMcpGateway({
    handlers: new NqaGatewayHandlerRegistry(handlers),
    idempotencyStore,
    auditSink,
    enabledPermissionTiers,
    now: () => NOW,
  });

  return { gateway, auditSink, idempotencyStore };
}

describe("NQA MCP secure gateway", () => {
  it("allows READ capability for a READ principal", async () => {
    const { gateway } = createGateway({
      "nqa.chapter.extract": () => ({ chapter: 197 }),
    });

    const result = await gateway.dispatch({
      request: request("nqa.chapter.extract"),
      principal: principal(["READ"]),
    });

    expect(result).toMatchObject({
      status: "OK",
      result: { chapter: 197 },
      authorization: {
        allowed: true,
        requiredPermission: "READ",
      },
    });
  });

  it("denies QA_OPERATE capability to a READ-only principal", async () => {
    const { gateway } = createGateway({
      "nqa.qa.run_semantic": () => ({ decision: "PASS" }),
    });

    const result = await gateway.dispatch({
      request: request("nqa.qa.run_semantic", {
        idempotencyKey: "a".repeat(64),
      }),
      principal: principal(["READ"]),
    });

    expect(result).toMatchObject({
      status: "ERROR",
      error: { code: "MISSING_PERMISSION" },
    });
  });
  it("does not imply READ from QA_OPERATE", async () => {
    const { gateway } = createGateway({
      "nqa.chapter.extract": () => ({ chapter: 197 }),
    });

    const result = await gateway.dispatch({
      request: request("nqa.chapter.extract"),
      principal: principal(["QA_OPERATE"]),
    });

    expect(result).toMatchObject({
      status: "ERROR",
      error: { code: "MISSING_PERMISSION" },
    });
  });

  it("allows READ and QA_OPERATE when both are explicitly granted", async () => {
    const { gateway } = createGateway({
      "nqa.chapter.extract": () => ({ chapter: 197 }),
      "nqa.qa.run_semantic": () => ({ decision: "PASS" }),
    });

    const readResult = await gateway.dispatch({
      request: request("nqa.chapter.extract"),
      principal: principal(["READ", "QA_OPERATE"]),
    });
    const qaResult = await gateway.dispatch({
      request: request("nqa.qa.run_semantic", {
        requestId: "req-2",
        idempotencyKey: "b".repeat(64),
      }),
      principal: principal(["READ", "QA_OPERATE"]),
    });

    expect(readResult.status).toBe("OK");
    expect(qaResult.status).toBe("OK");
  });

  it("fails closed for an arbitrary capability", async () => {
    const { gateway, auditSink } = createGateway();

    const result = await gateway.dispatch({
      request: request("nqa.unregistered.operation"),
      principal: principal(["READ", "QA_OPERATE"]),
    });

    expect(result).toMatchObject({
      status: "ERROR",
      error: { code: "UNKNOWN_CAPABILITY" },
    });
    expect(auditSink.records.at(-1)).toMatchObject({
      event: "AUTHORIZATION_REJECTED",
      outcome: "REJECTED",
      errorCode: "UNKNOWN_CAPABILITY",
    });
  });
  it("fails closed when a valid capability has no registered handler", async () => {
    const { gateway } = createGateway();

    const result = await gateway.dispatch({
      request: request("nqa.chapter.extract"),
      principal: principal(["READ"]),
    });

    expect(result).toMatchObject({
      status: "ERROR",
      error: { code: "HANDLER_NOT_REGISTERED" },
    });
  });

  it("rejects an unauthenticated caller before authorization", async () => {
    const { gateway, auditSink } = createGateway({
      "nqa.chapter.extract": () => ({ chapter: 197 }),
    });

    const result = await gateway.dispatch({
      request: request("nqa.chapter.extract"),
      principal: principal(["READ"], false),
    });

    expect(result).toMatchObject({
      status: "ERROR",
      error: { code: "UNAUTHENTICATED" },
    });
    expect(auditSink.records.at(-1)).toMatchObject({
      event: "AUTHENTICATION_REJECTED",
      principalId: "anonymous",
    });
  });

  it("uses authenticated principal identity instead of spoofed actorId", async () => {
    const handler = vi.fn(context => ({
      principalId: context.principal.principalId,
    }));
    const { gateway, auditSink } = createGateway({
      "nqa.chapter.extract": handler,
    });

    const result = await gateway.dispatch({
      request: request("nqa.chapter.extract", {
        actorId: "spoofed-administrator",
      }),
      principal: principal(["READ"]),
    });

    expect(result).toMatchObject({
      status: "OK",
      result: { principalId: "trusted-principal" },
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(
      auditSink.records.every(
        record => record.principalId === "trusted-principal"
      )
    ).toBe(true);
    expect(JSON.stringify(auditSink.records)).not.toContain(
      "spoofed-administrator"
    );
  });
  it("rejects a QA state-write request without idempotency key", async () => {
    const handler = vi.fn(() => ({ decision: "PASS" }));
    const { gateway } = createGateway({
      "nqa.qa.run_semantic": handler,
    });

    const result = await gateway.dispatch({
      request: request("nqa.qa.run_semantic"),
      principal: principal(["QA_OPERATE"]),
    });

    expect(result).toMatchObject({
      status: "ERROR",
      error: { code: "IDEMPOTENCY_KEY_REQUIRED" },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("reuses a completed idempotent result without re-executing", async () => {
    const handler = vi.fn(() => ({ decision: "FAIL", reason: "fixture" }));
    const { gateway, auditSink } = createGateway({
      "nqa.qa.run_regression": handler,
    });
    const repeatedRequest = request("nqa.qa.run_regression", {
      idempotencyKey: "c".repeat(64),
      inputFingerprint: "d".repeat(64),
    });

    const first = await gateway.dispatch({
      request: repeatedRequest,
      principal: principal(["QA_OPERATE"]),
    });
    const second = await gateway.dispatch({
      request: repeatedRequest,
      principal: principal(["QA_OPERATE"]),
    });

    expect(first.status).toBe("OK");
    expect(second).toMatchObject({
      status: "REUSED",
      result: { decision: "FAIL", reason: "fixture" },
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(
      auditSink.records.some(record => record.event === "IDEMPOTENCY_REUSED")
    ).toBe(true);
  });
  it("rejects a duplicate while the first idempotent request is in progress", async () => {
    let releaseHandler!: () => void;
    let notifyStarted!: () => void;
    const started = new Promise<void>(resolve => {
      notifyStarted = resolve;
    });
    const blocker = new Promise<void>(resolve => {
      releaseHandler = resolve;
    });
    const handler = vi.fn(async () => {
      notifyStarted();
      await blocker;
      return { decision: "PASS" };
    });
    const { gateway } = createGateway({
      "nqa.qa.run_semantic": handler,
    });
    const repeatedRequest = request("nqa.qa.run_semantic", {
      idempotencyKey: "e".repeat(64),
      inputFingerprint: "f".repeat(64),
    });

    const firstPromise = gateway.dispatch({
      request: repeatedRequest,
      principal: principal(["QA_OPERATE"]),
    });
    await started;

    const second = await gateway.dispatch({
      request: repeatedRequest,
      principal: principal(["QA_OPERATE"]),
    });

    expect(second).toMatchObject({
      status: "ERROR",
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });

    releaseHandler();
    const first = await firstPromise;
    expect(first.status).toBe("OK");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects reuse of an idempotency key for a different request", async () => {
    const { gateway } = createGateway({
      "nqa.qa.run_semantic": () => ({ decision: "PASS" }),
    });
    const key = "1".repeat(64);
    await gateway.dispatch({
      request: request("nqa.qa.run_semantic", {
        idempotencyKey: key,
        inputFingerprint: "2".repeat(64),
      }),
      principal: principal(["QA_OPERATE"]),
    });

    const conflict = await gateway.dispatch({
      request: request("nqa.qa.run_semantic", {
        idempotencyKey: key,
        inputFingerprint: "3".repeat(64),
      }),
      principal: principal(["QA_OPERATE"]),
    });

    expect(conflict).toMatchObject({
      status: "ERROR",
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });
  });

  it("does not leak handler exceptions into the response or audit", async () => {
    const secret = "super-secret-token-value";
    const { gateway, auditSink } = createGateway({
      "nqa.chapter.extract": () => {
        throw new Error(secret);
      },
    });

    const result = await gateway.dispatch({
      request: request("nqa.chapter.extract"),
      principal: principal(["READ"]),
    });

    expect(result).toMatchObject({
      status: "ERROR",
      error: {
        code: "EXECUTION_FAILED",
        message: "NQA handler execution failed.",
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(auditSink.records)).not.toContain(secret);
    expect(auditSink.records.at(-1)?.event).toBe("EXECUTION_FAILED");
  });
  it("enforces runtime-disabled permission tiers", async () => {
    const { gateway } = createGateway(
      {
        "nqa.qa.run_semantic": () => ({ decision: "PASS" }),
      },
      ["READ"]
    );

    const result = await gateway.dispatch({
      request: request("nqa.qa.run_semantic", {
        idempotencyKey: "4".repeat(64),
      }),
      principal: principal(["QA_OPERATE"]),
    });

    expect(result).toMatchObject({
      status: "ERROR",
      error: { code: "TIER_DISABLED" },
    });
  });

  it("declares M17 production mutation capabilities but keeps the V1 tier disabled", () => {
    expect(
      Object.values(NQA_CAPABILITIES).some(
        definition => definition.requiredPermission === "PRODUCTION_MUTATION"
      )
    ).toBe(true);
    expect(NQA_V1_ENABLED_PERMISSION_TIERS).not.toContain(
      "PRODUCTION_MUTATION"
    );

    expect(
      Object.values(NQA_CAPABILITIES).some(
        definition => definition.requiredPermission === "REMEDIATION"
      )
    ).toBe(true);
    expect(NQA_V1_ENABLED_PERMISSION_TIERS).not.toContain("REMEDIATION");
  });

  it("rejects malformed request envelopes without executing a handler", async () => {
    const handler = vi.fn(() => ({ chapter: 197 }));
    const { gateway } = createGateway({
      "nqa.chapter.extract": handler,
    });

    const result = await gateway.dispatch({
      request: {
        ...request("nqa.chapter.extract"),
        target: { row: -1 },
      },
      principal: principal(["READ"]),
    });

    expect(result).toMatchObject({
      status: "ERROR",
      error: { code: "INVALID_REQUEST" },
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
