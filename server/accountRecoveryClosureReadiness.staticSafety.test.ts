import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const service = readFileSync(
  fileURLToPath(new URL("./services/accountRecoveryClosureReadinessService.ts", import.meta.url)),
  "utf8"
);
const routers = readFileSync(fileURLToPath(new URL("./routers.ts", import.meta.url)), "utf8");

describe("IPE-045 closure readiness static safety", () => {
  it("contains no direct write/transaction/identity/merge execution primitive", () => {
    for (const forbidden of [
      /\b(?:db|database|tx)\s*\.\s*insert\s*\(/,
      /\b(?:db|database|tx)\s*\.\s*update\s*\(/,
      /\b(?:db|database|tx)\s*\.\s*delete\s*\(/,
      /\b(?:db|database|tx)\s*\.\s*transaction\s*\(/,
      /executeAccountMerge\s*\(/,
      /moveAuthIdentityOwner\s*\(/,
      /supersedeBlockedAccountRecoveryRequest\s*\(/,
    ]) {
      expect(service).not.toMatch(forbidden);
    }
    expect(service).toContain('executionAuthorized: false');
  });

  it("exposes closure readiness only as an admin query", () => {
    const start = routers.indexOf("closureReadiness: adminProcedure");
    const end = routers.indexOf("supersedeDuplicate: adminProcedure", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const block = routers.slice(start, end);
    expect(block).toMatch(/\.query\(/);
    expect(block).not.toMatch(/\.mutation\(/);
  });
});
