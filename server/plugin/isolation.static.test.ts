import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PLUGIN_CAPABILITIES,
  PLUGIN_PERMISSION_SCOPES,
  PLUGIN_V1_ENABLED_CAPABILITIES,
} from "./controlPlane";
import { PLUGIN_ROUTE_PATHS } from "./oauth/routes";

const PLUGIN_DIR = path.resolve(process.cwd(), "server/plugin");

function productionPluginSources(): string[] {
  const collected: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) collected.push(full);
    }
  };
  walk(PLUGIN_DIR);
  return collected;
}

describe("plugin namespace isolation boundary", () => {
  it("never imports workspace, NQA, shared routers, or client surfaces", () => {
    const forbiddenImportPatterns = [
      /from\s+["'][^"']*workspace[^"']*["']/i,
      /from\s+["'][^"']*nqa[^"']*["']/i,
      /from\s+["'][^"']*routers?["']/i,
      /from\s+["'][^"']*client\/[^"']*["']/i,
      /from\s+["'][^"']*googleDocs/i,
    ];

    for (const file of productionPluginSources()) {
      const source = fs.readFileSync(file, "utf8");
      for (const pattern of forbiddenImportPatterns) {
        expect(
          pattern.test(source),
          `forbidden import/dependency in ${path.relative(PLUGIN_DIR, file)}: ${pattern}`
        ).toBe(false);
      }
    }
  });

  it("registers no HTTP listener and never constructs its own app", () => {
    const forbiddenPatterns = [
      /\.listen\s*\(/,
      /\bexpress\s*\(\s*\)/,
      /\bcreateServer\s*\(/,
    ];
    for (const file of productionPluginSources()) {
      const source = fs.readFileSync(file, "utf8");
      for (const pattern of forbiddenPatterns) {
        expect(
          pattern.test(source),
          `forbidden listener/app construction in ${path.relative(PLUGIN_DIR, file)}: ${pattern}`
        ).toBe(false);
      }
    }
  });

  it("registers route handlers only inside the routes module", () => {
    const routesFile = path.join(PLUGIN_DIR, "oauth", "routes.ts");
    for (const file of productionPluginSources()) {
      if (path.resolve(file) === path.resolve(routesFile)) continue;
      const source = fs.readFileSync(file, "utf8");
      expect(
        /\bapp\.(?:get|post|put|patch|delete)\s*\(/.test(source),
        `route registration outside routes.ts: ${path.relative(PLUGIN_DIR, file)}`
      ).toBe(false);
    }
  });
});

describe("plugin read-only HTTP surface lock", () => {
  it("exposes exactly the six expected paths", () => {
    expect([...PLUGIN_ROUTE_PATHS].sort()).toEqual(
      [
        "/api/plugin/oauth/authorize",
        "/api/plugin/oauth/authorize/consent",
        "/api/plugin/oauth/token",
        "/api/plugin/oauth/revoke",
        "/.well-known/oauth-authorization-server",
        "/api/plugin/mcp",
      ].sort()
    );
  });

  it("registers no /api/plugin path outside that inventory", () => {
    const routesFile = path.join(PLUGIN_DIR, "oauth", "routes.ts");
    const source = fs.readFileSync(routesFile, "utf8");
    const registered = /app\.(?:get|post)\(\s*(\w+)/g;
    const names = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = registered.exec(source)) !== null) {
      names.add(match[1]);
    }
    // Every app.get/app.post target must be one of the inventory constants.
    const allowedConstants = new Set([
      "PLUGIN_OAUTH_AUTHORIZE_PATH",
      "PLUGIN_OAUTH_CONSENT_PATH",
      "PLUGIN_OAUTH_TOKEN_PATH",
      "PLUGIN_OAUTH_REVOKE_PATH",
      "PLUGIN_WELL_KNOWN_PATH",
      "PLUGIN_MCP_PATH",
    ]);
    for (const name of names) {
      expect(allowedConstants.has(name), `unexpected route constant: ${name}`).toBe(true);
    }
    expect(names.size).toBe(6);
  });

  it("keeps the capability registry at exactly one READ_ONLY tool", () => {
    expect(Object.keys(PLUGIN_CAPABILITIES)).toEqual(["identity.whoami"]);
    expect(PLUGIN_V1_ENABLED_CAPABILITIES).toEqual(["identity.whoami"]);
    for (const definition of Object.values(PLUGIN_CAPABILITIES)) {
      expect(definition.effect).toBe("READ_ONLY");
      expect(PLUGIN_PERMISSION_SCOPES).toContain(definition.requiredScope);
    }
  });
});
