import { describe, expect, it } from "vitest";
import {
  PLUGIN_CAPABILITIES,
  PLUGIN_PERMISSION_SCOPES,
  PLUGIN_V1_ENABLED_CAPABILITIES,
  authorizePluginCapability,
  parsePluginScopes,
} from "./controlPlane";

describe("plugin capability registry (read-only identity slice)", () => {
  it("registers exactly identity.whoami and nothing else", () => {
    expect(Object.keys(PLUGIN_CAPABILITIES)).toEqual(["identity.whoami"]);
  });

  it("every registered capability is READ_ONLY with a known scope", () => {
    for (const [name, definition] of Object.entries(PLUGIN_CAPABILITIES)) {
      expect(definition.effect, name).toBe("READ_ONLY");
      expect(PLUGIN_PERMISSION_SCOPES, name).toContain(definition.requiredScope);
    }
  });

  it("enable allowlist is a subset of the registry", () => {
    for (const capability of PLUGIN_V1_ENABLED_CAPABILITIES) {
      expect(capability in PLUGIN_CAPABILITIES).toBe(true);
    }
  });
});

describe("authorizePluginCapability", () => {
  it("allows identity.whoami with identity:read", () => {
    const decision = authorizePluginCapability({
      capability: "identity.whoami",
      grantedScopes: ["identity:read"],
    });
    expect(decision).toEqual({
      allowed: true,
      capability: "identity.whoami",
      requiredScope: "identity:read",
      reason: "ALLOW",
    });
  });

  it("rejects unknown capabilities with UNKNOWN_CAPABILITY", () => {
    const decision = authorizePluginCapability({
      capability: "workspace.list",
      grantedScopes: ["identity:read"],
    });
    expect(decision).toMatchObject({ allowed: false, reason: "UNKNOWN_CAPABILITY", requiredScope: null });
  });

  it("rejects disabled capabilities even with the right scope", () => {
    const decision = authorizePluginCapability({
      capability: "identity.whoami",
      grantedScopes: ["identity:read"],
      enabledCapabilities: [],
    });
    expect(decision).toMatchObject({ allowed: false, reason: "CAPABILITY_DISABLED" });
  });

  it("rejects valid capabilities with insufficient scope", () => {
    const decision = authorizePluginCapability({
      capability: "identity.whoami",
      grantedScopes: [],
    });
    expect(decision).toMatchObject({ allowed: false, reason: "INSUFFICIENT_SCOPE", requiredScope: "identity:read" });
  });
});

describe("parsePluginScopes", () => {
  it("parses a space-separated scope string", () => {
    expect(parsePluginScopes("identity:read")).toEqual(["identity:read"]);
  });

  it("deduplicates and drops unknown scopes (fail closed)", () => {
    expect(parsePluginScopes("identity:read novel:read identity:read")).toEqual(["identity:read"]);
  });

  it("returns empty for null/empty/garbage", () => {
    expect(parsePluginScopes(null)).toEqual([]);
    expect(parsePluginScopes(undefined)).toEqual([]);
    expect(parsePluginScopes("")).toEqual([]);
    expect(parsePluginScopes("workspace:list")).toEqual([]);
  });
});
