import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const GOOGLE_DIR = path.resolve(process.cwd(), "server/nqa/google");

function productionGoogleSources(): string[] {
  return fs
    .readdirSync(GOOGLE_DIR)
    .filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map(file => path.join(GOOGLE_DIR, file));
}

describe("NQA M05 Google adapter isolation", () => {
  it("does not import shared router, workspace, database, or client surfaces", () => {
    const forbiddenImports = [
      /from\s+["'][^"']*routers?["']/i,
      /from\s+["'][^"']*workspace[^"']*["']/i,
      /from\s+["'][^"']*drizzle[^"']*["']/i,
      /from\s+["'][^"']*(?:db|database)[^"']*["']/i,
      /from\s+["'][^"']*client[^"']*["']/i,
    ];

    for (const file of productionGoogleSources()) {
      const source = fs.readFileSync(file, "utf8");
      for (const pattern of forbiddenImports) {
        expect(
          pattern.test(source),
          `forbidden import in ${path.basename(file)}`
        ).toBe(false);
      }
    }
  });
  it("contains no mutating HTTP methods or Google write endpoints", () => {
    const forbiddenMutationPatterns = [
      /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i,
      /:batchUpdate/i,
      /\/values\/[^"'?]+\?/i,
      /permissions\.create/i,
      /files\.update/i,
      /documents\.batchUpdate/i,
      /spreadsheets\.batchUpdate/i,
    ];

    for (const file of productionGoogleSources()) {
      const source = fs.readFileSync(file, "utf8");
      for (const pattern of forbiddenMutationPatterns) {
        expect(
          pattern.test(source),
          `mutation surface in ${path.basename(file)}: ${pattern}`
        ).toBe(false);
      }
    }
  });

  it("declares readonly OAuth scopes only", () => {
    const contracts = fs.readFileSync(
      path.join(GOOGLE_DIR, "contracts.ts"),
      "utf8"
    );
    const scopeLines = contracts
      .split("\n")
      .filter(line => line.includes("googleapis.com/auth/"));

    expect(scopeLines.length).toBeGreaterThan(0);
    expect(scopeLines.every(line => line.includes(".readonly"))).toBe(true);
  });
});
