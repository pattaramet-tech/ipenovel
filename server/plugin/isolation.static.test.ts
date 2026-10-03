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
  it("imports workspace surface ONLY via the mandated .service reuse (IPE-PLUGIN-001D); never NQA, shared routers, or client surfaces", () => {
    // IPE-PLUGIN-001D authorization: the draft/checker tools MUST reuse the
    // real Workspace services verbatim, so `server/workspace/<name>.service`
    // imports are the single allowed workspace surface. Every other
    // workspace import (domain helpers, internals, router, tests) stays
    // banned, as do NQA, the shared router, and all client surfaces.
    const workspaceImport = /from\s+["'][^"']*workspace[^"']*["']/gi;
    const allowedWorkspaceImport = /from\s+["']\.\.\/\.\.\/workspace\/[a-zA-Z0-9]+\.service["']/;
    const forbiddenImportPatterns = [
      /from\s+["'][^"']*nqa[^"']*["']/i,
      /from\s+["'][^"']*routers?["']/i,
      /from\s+["'][^"']*client\/[^"']*["']/i,
      /from\s+["'][^"']*googleDocs/i,
    ];

    for (const file of productionPluginSources()) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(workspaceImport)) {
        expect(
          allowedWorkspaceImport.test(match[0]),
          `workspace import outside the mandated .service reuse in ${path.relative(PLUGIN_DIR, file)}: ${match[0]}`
        ).toBe(true);
      }
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

  it("keeps the capability registry at exactly the thirteen tools (identity + tenant reads + 001D editorial slice)", () => {
    expect([...Object.keys(PLUGIN_CAPABILITIES)].sort()).toEqual(
      [
        "checker.get",
        "checker.run",
        "chapter.get",
        "chapter.list",
        "draft.edit",
        "draft.get",
        "identity.whoami",
        "novel.get",
        "novel.list",
        "pack.get",
        "pack.list",
        "workspace.get",
        "workspace.list",
      ].sort()
    );
    expect([...PLUGIN_V1_ENABLED_CAPABILITIES].sort()).toEqual([
      ...Object.keys(PLUGIN_CAPABILITIES),
    ].sort());
    for (const [name, definition] of Object.entries(PLUGIN_CAPABILITIES)) {
      expect(["READ_ONLY", "MUTATION"], name).toContain(definition.effect);
      expect(PLUGIN_PERMISSION_SCOPES, name).toContain(definition.requiredScope);
    }
  });

  it("keeps the 001D mutation surface at exactly draft.edit + checker.run", () => {
    const mutations = Object.entries(PLUGIN_CAPABILITIES).filter(([, definition]) => definition.effect === "MUTATION");
    expect(mutations.map(([name]) => name).sort()).toEqual(["checker.run", "draft.edit"]);
  });

  it("never exposes any surface beyond the bounded editorial slice", () => {
    for (const name of Object.keys(PLUGIN_CAPABILITIES)) {
      expect(name, name).not.toMatch(
        /stage|publish|writeback|bulk|undo|exclude|restore|disposition|confirm|allowword|allow_word|transition|replace_tab|full_checker|fullchecker/i
      );
    }
  });
});
