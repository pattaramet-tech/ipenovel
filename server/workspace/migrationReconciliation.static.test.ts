import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");

describe("IPE-028-C02 test DB migration reconciliation", () => {
  it("rebuilds the guarded schema before reading migration journal state", () => {
    const source = fs.readFileSync(path.join(repoRoot, "scripts/test-db-prepare.ts"), "utf8");
    expect(source).toContain('import { resetToEmptySchema }');
    expect(source.indexOf("await resetToEmptySchema")).toBeLessThan(source.indexOf("await runTestDbMigration"));
  });

  it("keeps every reconstructed Workspace foreign-key identifier within MySQL's 64-character limit", () => {
    const migration = fs.readFileSync(
      path.join(repoRoot, "drizzle/0037_reconstruct_pr45_selected_features.sql"),
      "utf8"
    );
    const names = [...migration.matchAll(/ADD CONSTRAINT \`([^\`]+)\` FOREIGN KEY/g)].map((match) => match[1]!);
    expect(names).toHaveLength(16);
    expect(names.every((name) => name.length <= 64)).toBe(true);
  });
});
