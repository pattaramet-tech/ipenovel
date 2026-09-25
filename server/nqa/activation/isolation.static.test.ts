import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const DIR = path.resolve(process.cwd(), "server/nqa/activation");

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

describe("NQA M17 activation isolation", () => {
  it("contains no Google/content mutation, application listener, database, or raw novel-text surface", () => {
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
      /sourceText\s*:/,
      /translationText\s*:/,
    ];
    for (const pattern of forbidden) {
      expect(pattern.test(source)).toBe(false);
    }
  });

  it("does not import or overwrite the static active alignment policy module", () => {
    const source = productionSources();
    expect(source).not.toMatch(
      /from\s+["']\.\.\/semantic\/alignment\/policy["']/
    );
    expect(source).not.toMatch(/DEFAULT_NQA_ALIGNMENT_POLICY/);
    expect(source).not.toMatch(/mergeNqaAlignmentPolicy/);
    expect(source).not.toContain("server/nqa/semantic/alignment/policy.ts");
  });

  it("limits filesystem mutation to the dedicated append-only activation registry implementation", () => {
    const store = fs.readFileSync(path.join(DIR, "store.ts"), "utf8");
    const otherSources = fs
      .readdirSync(DIR)
      .filter(
        file =>
          file.endsWith(".ts") &&
          !file.endsWith(".test.ts") &&
          file !== "testSupport.ts" &&
          file !== "store.ts"
      )
      .map(file => fs.readFileSync(path.join(DIR, file), "utf8"))
      .join("\n");

    expect(store).toContain('flag: "wx"');
    expect(store).toContain("transaction.lock");
    expect(otherSources).not.toMatch(/\bwriteFile(?:Sync)?\s*\(/);
    expect(otherSources).not.toMatch(/\bappendFile(?:Sync)?\s*\(/);
  });
});
