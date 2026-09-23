import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const IDENTITY_DIR = path.resolve(process.cwd(), "server/nqa/identity");

function productionIdentitySources(): string[] {
  return fs
    .readdirSync(IDENTITY_DIR)
    .filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map(file => path.join(IDENTITY_DIR, file));
}

describe("NQA M06 identity isolation", () => {
  it("does not import shared router, workspace, database, or client surfaces", () => {
    const forbiddenImports = [
      /from\s+["'][^"']*routers?["']/i,
      /from\s+["'][^"']*workspace[^"']*["']/i,
      /from\s+["'][^"']*drizzle[^"']*["']/i,
      /from\s+["'][^"']*(?:db|database)[^"']*["']/i,
      /from\s+["'][^"']*client[^"']*["']/i,
    ];

    for (const file of productionIdentitySources()) {
      const source = fs.readFileSync(file, "utf8");
      for (const pattern of forbiddenImports) {
        expect(
          pattern.test(source),
          `forbidden import in ${path.basename(file)}`
        ).toBe(false);
      }
    }
  });
  it("contains no Google mutation or production transport registration", () => {
    const forbiddenPatterns = [
      /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i,
      /:batchUpdate/i,
      /\.listen\s*\(/,
      /\bapp\.(?:get|post|put|patch|delete)\s*\(/,
      /\brouter\.(?:get|post|put|patch|delete)\s*\(/,
    ];

    for (const file of productionIdentitySources()) {
      const source = fs.readFileSync(file, "utf8");
      for (const pattern of forbiddenPatterns) {
        expect(
          pattern.test(source),
          `mutation/transport surface in ${path.basename(file)}`
        ).toBe(false);
      }
    }
  });

  it("does not contain an automatic fuzzy merge operation", () => {
    for (const file of productionIdentitySources()) {
      const source = fs.readFileSync(file, "utf8");
      expect(source).not.toMatch(/auto.?merge/i);
      expect(source).not.toMatch(/fuzzy.*authority:\s*["']EXACT["']/i);
    }
  });
});
