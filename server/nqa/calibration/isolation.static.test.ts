import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const DIR = path.resolve(process.cwd(), "server/nqa/calibration");

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

describe("NQA M15 calibration/promotion isolation", () => {
  it("contains no production Google/content mutation, database, listener, or filesystem write surface", () => {
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
      /\bwriteFile(?:Sync)?\s*\(/,
      /\bappendFile(?:Sync)?\s*\(/,
      /from\s+["'][^"']*drizzle[^"']*["']/i,
      /from\s+["'][^"']*(?:db|database)[^"']*["']/i,
    ];

    for (const pattern of forbidden) {
      expect(pattern.test(source)).toBe(false);
    }
  });

  it("does not import or mutate the active M10 policy module", () => {
    const source = productionSources();
    expect(source).not.toMatch(
      /from\s+["']\.\.\/semantic\/alignment\/policy["']/
    );
    expect(source).not.toMatch(/DEFAULT_NQA_ALIGNMENT_POLICY/);
    expect(source).not.toMatch(/mergeNqaAlignmentPolicy/);
  });

  it("contains no raw chapter text fields or automatic promotion/apply API", () => {
    const source = productionSources();
    expect(source).not.toMatch(/sourceText\s*:/);
    expect(source).not.toMatch(/translationText\s*:/);
    expect(source).not.toMatch(/applyPromotion|autoPromote|writeThreshold/i);
  });
});
