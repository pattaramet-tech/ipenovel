import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const MCP_DIR = path.resolve(process.cwd(), "server/nqa/mcp");

function productionMcpSources(): string[] {
  return fs
    .readdirSync(MCP_DIR)
    .filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map(file => path.join(MCP_DIR, file));
}

describe("NQA M04 isolation boundary", () => {
  it("does not import shared router, workspace, database, or client surfaces", () => {
    const forbiddenImportPatterns = [
      /from\s+["'][^"']*routers?["']/i,
      /from\s+["'][^"']*workspace[^"']*["']/i,
      /from\s+["'][^"']*drizzle[^"']*["']/i,
      /from\s+["'][^"']*(?:db|database)[^"']*["']/i,
      /from\s+["'][^"']*client[^"']*["']/i,
    ];

    for (const file of productionMcpSources()) {
      const source = fs.readFileSync(file, "utf8");
      for (const pattern of forbiddenImportPatterns) {
        expect(
          pattern.test(source),
          `forbidden import in ${path.basename(file)}: ${pattern}`
        ).toBe(false);
      }
    }
  });

  it("does not register a production HTTP listener or router", () => {
    const registrationPatterns = [
      /\bexpress\s*\(/,
      /\.listen\s*\(/,
      /\bapp\.(?:get|post|put|patch|delete)\s*\(/,
      /\brouter\.(?:get|post|put|patch|delete)\s*\(/,
    ];

    for (const file of productionMcpSources()) {
      const source = fs.readFileSync(file, "utf8");
      for (const pattern of registrationPatterns) {
        expect(
          pattern.test(source),
          `production transport registration in ${path.basename(file)}`
        ).toBe(false);
      }
    }
  });

  it("keeps M04 source inside the isolated NQA namespace", () => {
    for (const file of productionMcpSources()) {
      expect(file.startsWith(MCP_DIR)).toBe(true);
    }
  });
});
