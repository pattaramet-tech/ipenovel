import { describe, expect, it } from "vitest";
import {
  PLUGIN_CAPABILITIES,
  PLUGIN_PERMISSION_SCOPES,
  PLUGIN_V1_ENABLED_CAPABILITIES,
  authorizePluginCapability,
  parsePluginScopes,
} from "./controlPlane";

const ALL_NINE_CAPABILITIES = [
  "chapter.get",
  "chapter.list",
  "identity.whoami",
  "novel.get",
  "novel.list",
  "pack.get",
  "pack.list",
  "workspace.get",
  "workspace.list",
];

describe("plugin capability registry (read-only identity + tenant slice)", () => {
  it("registers exactly the nine read-only tools and nothing else", () => {
    expect(Object.keys(PLUGIN_CAPABILITIES).sort()).toEqual(ALL_NINE_CAPABILITIES);
  });

  it("every registered capability is READ_ONLY with a known scope", () => {
    for (const [name, definition] of Object.entries(PLUGIN_CAPABILITIES)) {
      expect(definition.effect, name).toBe("READ_ONLY");
      expect(PLUGIN_PERMISSION_SCOPES, name).toContain(definition.requiredScope);
    }
  });

  it("no capability name hints at any mutation surface", () => {
    for (const name of Object.keys(PLUGIN_CAPABILITIES)) {
      expect(name, name).not.toMatch(/stage|publish|write|update|create|delete|approve|move|sync/i);
    }
  });

  it("tenant tools require their own resource scopes", () => {
    expect(PLUGIN_CAPABILITIES["workspace.list"].requiredScope).toBe("workspace:read");
    expect(PLUGIN_CAPABILITIES["workspace.get"].requiredScope).toBe("workspace:read");
    expect(PLUGIN_CAPABILITIES["novel.list"].requiredScope).toBe("novel:read");
    expect(PLUGIN_CAPABILITIES["novel.get"].requiredScope).toBe("novel:read");
    expect(PLUGIN_CAPABILITIES["pack.list"].requiredScope).toBe("pack:read");
    expect(PLUGIN_CAPABILITIES["pack.get"].requiredScope).toBe("pack:read");
    expect(PLUGIN_CAPABILITIES["chapter.list"].requiredScope).toBe("chapter:read");
    expect(PLUGIN_CAPABILITIES["chapter.get"].requiredScope).toBe("chapter:read");
  });

  it("enable allowlist covers all nine and nothing else", () => {
    expect([...PLUGIN_V1_ENABLED_CAPABILITIES].sort()).toEqual(ALL_NINE_CAPABILITIES);
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

  it("allows workspace.list with workspace:read", () => {
    const decision = authorizePluginCapability({
      capability: "workspace.list",
      grantedScopes: ["identity:read", "workspace:read"],
    });
    expect(decision).toEqual({
      allowed: true,
      capability: "workspace.list",
      requiredScope: "workspace:read",
      reason: "ALLOW",
    });
  });

  it("rejects unknown capabilities with UNKNOWN_CAPABILITY", () => {
    const decision = authorizePluginCapability({
      capability: "publish.stage",
      grantedScopes: ["identity:read", "workspace:read"],
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

  it("rejects tenant tools without their resource scope (identity:read is not enough)", () => {
    const decision = authorizePluginCapability({
      capability: "workspace.list",
      grantedScopes: ["identity:read"],
    });
    expect(decision).toMatchObject({
      allowed: false,
      reason: "INSUFFICIENT_SCOPE",
      requiredScope: "workspace:read",
    });
  });
});

describe("parsePluginScopes", () => {
  it("parses a space-separated scope string across all five scopes (request order)", () => {
    expect(parsePluginScopes("identity:read workspace:read novel:read pack:read chapter:read")).toEqual([
      "identity:read",
      "workspace:read",
      "novel:read",
      "pack:read",
      "chapter:read",
    ]);
  });

  it("deduplicates and drops unknown scopes (fail closed)", () => {
    expect(parsePluginScopes("identity:read novel:read identity:read")).toEqual([
      "identity:read",
      "novel:read",
    ]);
  });

  it("returns empty for null/empty/garbage", () => {
    expect(parsePluginScopes(null)).toEqual([]);
    expect(parsePluginScopes(undefined)).toEqual([]);
    expect(parsePluginScopes("")).toEqual([]);
    expect(parsePluginScopes("workspace:list")).toEqual([]);
  });
});
