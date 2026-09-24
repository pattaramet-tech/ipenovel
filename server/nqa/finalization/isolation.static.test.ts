import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const DIR = path.resolve(process.cwd(), "server/nqa/finalization");

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

describe("NQA M20-M21 finalization/runtime isolation", () => {
  it("contains no Google/content mutation, HTTP listener, production DB, or raw novel-text persistence", () => {
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

  it("does not mutate M17 activation/rollback or M19 scope history", () => {
    const source = productionSources();
    expect(source).not.toMatch(/activateNqaCandidatePolicy\s*\(/);
    expect(source).not.toMatch(/rollbackNqaActivePolicy\s*\(/);
    expect(source).not.toMatch(/expandNqaControlledRolloutScope\s*\(/);
    expect(source).not.toMatch(/\.rm\s*\([^)]*events/i);
  });

  it("keeps M21 baseline adoption lineage-backed and release evaluation side-effect free", () => {
    const runtime = fs.readFileSync(path.join(DIR, "runtime.ts"), "utf8");
    const release = fs.readFileSync(path.join(DIR, "releaseGate.ts"), "utf8");

    expect(runtime).not.toMatch(/DEFAULT_NQA_ALIGNMENT_POLICY/);
    expect(runtime).not.toMatch(/rollbackNqaActivePolicy\s*\(/);
    expect(release).not.toMatch(/node:child_process|\bexec\s*\(|\bspawn\s*\(/);
    expect(release).not.toMatch(/git\s+push|gh\s+pr|git\s+merge/i);
  });
});
