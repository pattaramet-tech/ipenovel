import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const DIR = path.resolve(process.cwd(), "server/nqa/review");

function productionSources(): string {
  return fs
    .readdirSync(DIR)
    .filter(
      file =>
        file.endsWith(".ts") &&
        !file.endsWith(".test.ts") &&
        !file.endsWith(".static.test.ts")
    )
    .map(file => fs.readFileSync(path.join(DIR, file), "utf8"))
    .join("\n");
}

describe("NQA M14 review/curation isolation", () => {
  it("contains no production Google/content mutation, application listener, or database surface", () => {
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
      /from\s+["'][^"']*(?:db|database)[^"']*["']/i,
    ];

    for (const pattern of forbidden) {
      expect(pattern.test(source)).toBe(false);
    }
  });

  it("does not introduce raw chapter text into review or curation contracts", () => {
    const contracts = fs.readFileSync(path.join(DIR, "contracts.ts"), "utf8");
    const exporter = fs.readFileSync(path.join(DIR, "export.ts"), "utf8");

    expect(contracts).not.toMatch(/sourceText\s*:/);
    expect(contracts).not.toMatch(/translationText\s*:/);
    expect(exporter).not.toMatch(/sourceText\s*:/);
    expect(exporter).not.toMatch(/translationText\s*:/);
  });

  it("persists journal entries with create-only semantics", () => {
    const store = fs.readFileSync(path.join(DIR, "store.ts"), "utf8");
    expect(store).toContain('flag: "wx"');
    expect(store).not.toMatch(/writeFile\([^)]*flag:\s*["']w["']/s);
  });
});
