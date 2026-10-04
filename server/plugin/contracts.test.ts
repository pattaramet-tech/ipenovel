import { describe, expect, it } from "vitest";
import {
  JsonRpcRequestSchema,
  McpToolCallParamsSchema,
  PluginPrincipalSchema,
  jsonRpcError,
  jsonRpcResult,
} from "./contracts";

describe("JsonRpcRequestSchema", () => {
  it("accepts a valid request with id", () => {
    const parsed = JsonRpcRequestSchema.safeParse({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a notification (no id)", () => {
    const parsed = JsonRpcRequestSchema.safeParse({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects wrong protocol version and extra fields (strict)", () => {
    expect(
      JsonRpcRequestSchema.safeParse({ jsonrpc: "1.0", id: 1, method: "tools/list" }).success
    ).toBe(false);
    expect(
      JsonRpcRequestSchema.safeParse({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        extra: true,
      }).success
    ).toBe(false);
  });

  it("rejects missing/empty method and object ids", () => {
    expect(JsonRpcRequestSchema.safeParse({ jsonrpc: "2.0", id: 1, method: "" }).success).toBe(false);
    expect(JsonRpcRequestSchema.safeParse({ jsonrpc: "2.0", method: "tools/list", id: {} }).success).toBe(false);
  });
});

describe("McpToolCallParamsSchema", () => {
  it("accepts name with optional arguments", () => {
    expect(McpToolCallParamsSchema.safeParse({ name: "identity.whoami" }).success).toBe(true);
    expect(
      McpToolCallParamsSchema.safeParse({ name: "identity.whoami", arguments: {} }).success
    ).toBe(true);
  });

  it("rejects missing name and non-record arguments", () => {
    expect(McpToolCallParamsSchema.safeParse({}).success).toBe(false);
    expect(McpToolCallParamsSchema.safeParse({ name: "identity.whoami", arguments: "x" }).success).toBe(false);
  });
});

describe("PluginPrincipalSchema", () => {
  const valid = {
    userId: 7,
    clientId: "plg_client",
    authorizationId: 3,
    scopes: ["identity:read"],
    tokenId: "a".repeat(64),
    authenticated: true,
  };

  it("accepts a valid principal", () => {
    expect(PluginPrincipalSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects anonymous/unauthenticated shapes and extra fields", () => {
    expect(PluginPrincipalSchema.safeParse({ ...valid, authenticated: false }).success).toBe(false);
    expect(PluginPrincipalSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(PluginPrincipalSchema.safeParse({ ...valid, tokenId: "short" }).success).toBe(false);
  });
});

describe("jsonRpc builders", () => {
  it("builds result and error envelopes with fixed shapes", () => {
    expect(jsonRpcResult(5, { ok: true })).toEqual({ jsonrpc: "2.0", id: 5, result: { ok: true } });
    expect(jsonRpcError(null, -32600, "bad")).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "bad" },
    });
    expect(jsonRpcError(2, -32000, "denied", { reason: "INSUFFICIENT_SCOPE" })).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32000, message: "denied", data: { reason: "INSUFFICIENT_SCOPE" } },
    });
  });
});

// IPE-PLUGIN-001D-Q2-R1: ChatGPT attaches an optional top-level _meta bag to
// every tools/call - it must be accepted (and ignored for authorization),
// while unknown fields and wrong-typed _meta still fail the strict envelope.
describe("McpToolCallParamsSchema _meta compatibility (Q2-R1)", () => {
  const base = { jsonrpc: "2.0", id: 1, method: "tools/call" };

  function parseParams(params: unknown) {
    return McpToolCallParamsSchema.safeParse(params);
  }

  it("PASS: name only", () => {
    expect(parseParams({ name: "identity.whoami" }).success).toBe(true);
  });

  it("PASS: name + empty arguments", () => {
    expect(parseParams({ name: "identity.whoami", arguments: {} }).success).toBe(true);
  });

  it("PASS: name + arguments + empty _meta", () => {
    expect(
      parseParams({ name: "identity.whoami", arguments: {}, _meta: {} }).success
    ).toBe(true);
  });

  it("PASS: name + arguments + ChatGPT-style _meta object", () => {
    expect(
      parseParams({
        name: "workspace.list",
        arguments: {},
        _meta: { chatgpt: { account_id: "acct_1" }, foo: { bar: true } },
      }).success
    ).toBe(true);
  });

  it("FAIL: _meta as string", () => {
    expect(parseParams({ name: "identity.whoami", _meta: "x" }).success).toBe(false);
  });

  it("FAIL: unknown top-level field still rejected (strict)", () => {
    expect(parseParams({ name: "identity.whoami", unknownField: true }).success).toBe(false);
  });

  it("FAIL: arguments as string (wrong type)", () => {
    expect(parseParams({ name: "identity.whoami", arguments: "x" }).success).toBe(false);
  });

  it("FAIL: _meta as array (not a record)", () => {
    expect(parseParams({ name: "identity.whoami", _meta: [] }).success).toBe(false);
  });
});
