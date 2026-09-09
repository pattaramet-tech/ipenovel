import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("./services/accountRecoveryCompensationService.ts", import.meta.url)),
  "utf8"
);
const routersSource = readFileSync(
  fileURLToPath(new URL("./routers.ts", import.meta.url)),
  "utf8"
);

describe("IPE-045 compensating recovery static safety", () => {
  it("has no database write/reconciliation/identity-transfer execution primitive", () => {
    for (const forbidden of [
      /\b(?:db|database|tx)\s*\.\s*insert\s*\(/,
      /\b(?:db|database|tx)\s*\.\s*update\s*\(/,
      /\b(?:db|database|tx)\s*\.\s*delete\s*\(/,
      /\b(?:db|database|tx)\s*\.\s*transaction\s*\(/,
      /moveAuthIdentityOwner\s*\(/,
      /finalizeAccountRecoveryTargetUser\s*\(/,
      /reconcileAccountMergeFinancials/,
      /reconcileAccountMergeData/,
    ]) {
      expect(source, `forbidden side-effect primitive: ${forbidden}`).not.toMatch(forbidden);
    }
    expect(source).toContain('createHash("sha256").update(');
  });

  it("hard-codes dry-run mode and executionAuthorized=false", () => {
    expect(source).toContain('mode: "dry_run_only"');
    expect(source).toContain("executionAuthorized: false");
    expect(source).not.toContain("executionAuthorized: true");
  });

  it("exposes compensating recovery only as an admin query with no sibling mutation endpoint", () => {
    expect(routersSource).toMatch(/compensatingPlan:\s*adminProcedure[\s\S]*?\.query\(/);
    expect(routersSource).not.toMatch(/compensating(?:Execute|Apply|Repair|Commit)[\w]*:\s*adminProcedure[\s\S]*?\.mutation\(/i);
  });
});
