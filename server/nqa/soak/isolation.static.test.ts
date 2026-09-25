import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const DIR = path.resolve(process.cwd(), "server/nqa/soak");

function productionSources(): string {
  return fs
    .readdirSync(DIR)
    .filter(
      file =>
        file.endsWith(".ts") &&
        !file.endsWith(".test.ts") &&
        file !== "testSupport.ts"
    )
    .map(file => fs.readFileSync(path.join(DIR, file), "utf8"))
    .join("\n");
}

describe("NQA M19 soak/expansion isolation", () => {
  it("contains no Google/content mutation, HTTP listener, production DB, or raw novel text persistence", () => {
    const source = productionSources();
    const forbidden = [
      /documents\.batchUpdate/i,
      /spreadsheets\.batchUpdate/i,
      /values\.update/i,
      /values\.append/i,
      /permissions\.(?:create|update|delete)/i,
      /\bapp\.(?:get|post|put|patch|delete)\s*\(/,
      /\brouter\.(?:get|post|put|patch|delete)\s*\(/,
      /\.listen\s*\(/,
      /from\s+["'][^"']*drizzle[^"']*["']/i,
      /sourceText\s*:/,
      /translationText\s*:/,
    ];
    for (const pattern of forbidden) {
      expect(pattern.test(source)).toBe(false);
    }
  });

  it("cannot activate/rollback policy or auto-expand scope from production M19 code", () => {
    const source = productionSources();
    expect(source).not.toMatch(/activateNqaCandidatePolicy\s*\(/);
    expect(source).not.toMatch(/rollbackNqaActivePolicy\s*\(/);
    expect(source).not.toMatch(/setInterval\s*\(/);
    expect(source).not.toMatch(/setTimeout\s*\([^,]+,/);
  });
});
