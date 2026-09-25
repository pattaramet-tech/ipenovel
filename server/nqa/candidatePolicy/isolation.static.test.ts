import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const DIR = path.resolve(process.cwd(), "server/nqa/candidatePolicy");

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

describe("NQA M16 candidate-policy isolation", () => {
  it("contains no production content mutation, listener, database, or filesystem write surface", () => {
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

  it("does not import or mutate the active alignment policy module", () => {
    const source = productionSources();
    expect(source).not.toMatch(
      /from\s+["']\.\.\/semantic\/alignment\/policy["']/
    );
    expect(source).not.toMatch(/DEFAULT_NQA_ALIGNMENT_POLICY/);
    expect(source).not.toMatch(/mergeNqaAlignmentPolicy/);
  });

  it("contains no production activation/apply API", () => {
    const source = productionSources();
    expect(source).not.toMatch(
      /activatePolicy|applyCandidatePolicy|setActivePolicy|writeActivePolicy/i
    );
    expect(source).toContain("READY_FOR_EXPLICIT_ACTIVATION_REVIEW");
    expect(source).toContain('"INACTIVE"');
  });

  it("does not expose a caller override that can weaken readiness guards", () => {
    const readiness = fs.readFileSync(path.join(DIR, "readiness.ts"), "utf8");
    expect(readiness).not.toMatch(/criteria\?:\s*Partial/);
    expect(readiness).not.toMatch(/\.\.\.input\.criteria/);
    expect(readiness).toContain("requireDistinctShadowDataset: true");
    expect(readiness).toContain("requireShadowPromote: true");
    expect(readiness).toContain("requireInactiveCandidate: true");
  });
});
