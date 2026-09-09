import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const lifecycleSource = readFileSync(
  fileURLToPath(new URL("./services/accountRecoveryLifecycleService.ts", import.meta.url)),
  "utf8"
);
const routersSource = readFileSync(
  fileURLToPath(new URL("./routers.ts", import.meta.url)),
  "utf8"
);

describe("IPE-045 post-merge recovery lifecycle static safety", () => {
  it("keeps lifecycle finalization read-only and never rewrites the persisted Recovery request", () => {
    for (const forbidden of [
      /\.insert\s*\(/,
      /\.update\s*\(/,
      /\.delete\s*\(/,
      /transitionAccountRecoveryRequestStatus\s*\(/,
      /reviewAccountRecoveryRequest\s*\(/,
      /moveAuthIdentityOwner\s*\(/,
      /executeAccountMerge\s*\(/,
    ]) {
      expect(lifecycleSource, `forbidden lifecycle side effect: ${forbidden}`).not.toMatch(forbidden);
    }
    expect(lifecycleSource).toContain('effectiveStatus: "resolved_via_advanced_merge"');
    expect(lifecycleSource).toContain('persistedStatus !== "blocked"');
  });

  it("exposes lifecycle only through existing read queries, with no new finalization mutation", () => {
    expect(routersSource).toMatch(/myRequests:\s*authenticatedProcedure\.query/);
    expect(routersSource).toMatch(/detail:\s*adminProcedure[\s\S]*?\.query/);
    expect(routersSource).not.toMatch(/(?:lifecycle|finaliz)[\w]*:\s*(?:adminProcedure|authenticatedProcedure)[\s\S]*?\.mutation\(/i);
  });
});
