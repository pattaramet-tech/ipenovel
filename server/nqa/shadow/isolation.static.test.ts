import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const DIR = path.resolve(process.cwd(), "server/nqa/shadow");

function productionSources(): string[] {
  return fs
    .readdirSync(DIR)
    .filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map(file => path.join(DIR, file));
}

describe("NQA M13 shadow isolation", () => {
  it("contains no production Google mutation, application listener, or database surface", () => {
    const source = productionSources()
      .map(file => fs.readFileSync(file, "utf8"))
      .join("\n");

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

  it("does not persist raw source or translation chapter text", () => {
    const contracts = fs.readFileSync(path.join(DIR, "contracts.ts"), "utf8");
    const store = fs.readFileSync(path.join(DIR, "store.ts"), "utf8");

    expect(contracts).not.toMatch(/sourceText\s*:/);
    expect(contracts).not.toMatch(/translationText\s*:/);
    expect(store).not.toMatch(/sourceText\s*:/);
    expect(store).not.toMatch(/translationText\s*:/);
  });

  it("keeps writes scoped to the injected QA shadow root", () => {
    const store = fs.readFileSync(path.join(DIR, "store.ts"), "utf8");

    expect(store).toContain("private readonly rootDir");
    expect(store).toContain("path.join(this.rootDir");
    expect(store).not.toMatch(/google/i);
    expect(store).not.toMatch(/https?:\/\//i);
  });
});
