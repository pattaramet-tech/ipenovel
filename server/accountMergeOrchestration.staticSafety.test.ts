import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  resolve(here, "services/accountMergeOrchestrationService.ts"),
  "utf8"
);

function position(fragment: string, startAt = 0): number {
  const index = source.indexOf(fragment, startAt);
  expect(
    index,
    `expected orchestration source to contain ${fragment}`
  ).toBeGreaterThanOrEqual(0);
  return index;
}

describe("IPE-008 final orchestration static safety invariants", () => {
  it("orders final locked preview -> financial -> data -> Survivor identity-preservation guard -> completed transition -> completion audit", () => {
    const preview = position("await buildAccountMergePreview(");
    const financial = position(
      "await reconcileAccountMergeFinancialsInTransaction("
    );
    const data = position("await reconcileAccountMergeDataInTransaction(");
    const identityGuard = position("if (sourceIdentity || !targetIdentity)", data);
    const complete = position('status: "completed"', identityGuard);
    const audit = position('action: "merge_completed"', complete);

    expect(preview).toBeLessThan(financial);
    expect(financial).toBeLessThan(data);
    expect(data).toBeLessThan(identityGuard);
    expect(identityGuard).toBeLessThan(complete);
    expect(complete).toBeLessThan(audit);
    expect(source).not.toContain("moveAuthIdentityOwner(");
    expect(source).not.toContain("finalizeAccountRecoveryTargetUser(");
  });

  it("never hard-deletes Source or deletes from users/auth anti-replay tables", () => {
    expect(source).not.toMatch(/delete\s*\(\s*users\s*\)/);
    expect(source).not.toMatch(/delete\s*\(\s*authIdentities\s*\)/);

  });

  it("binds explicit Donor/Survivor roles to the locked recovery requester and never accepts legacy source/target execute inputs", () => {
    const signature = source.slice(
      position("export async function executeAccountMerge"),
      position("await db.assertDatabaseAvailable")
    );
    expect(signature).toContain("donorAccountId: number");
    expect(signature).toContain("survivorAccountId: number");
    expect(signature).not.toMatch(/sourceUserId\s*:/);
    expect(signature).not.toMatch(/targetUserId\s*:/);
    expect(source).toContain("requesterUserId: Number(requestRow.requesterUserId)");
    expect(source).toContain("donorAccountId: params.donorAccountId");
    expect(source).toContain("survivorAccountId: params.survivorAccountId");
    expect(source).toContain("const sourceUserId = roleBinding.donorAccountId");
    expect(source).toContain("const targetUserId = roleBinding.survivorAccountId");
  });

  it("requires a persisted blocked recovery request and exact typed confirmation before reconciliation writes", () => {
    expect(source).toContain('requestRow.status !== "blocked"');
    expect(source).toMatch(
      /isAccountMergeConfirmationExact\(\s*sourceUserId,\s*targetUserId,\s*params\.confirmation\s*\)/
    );
  });
});
