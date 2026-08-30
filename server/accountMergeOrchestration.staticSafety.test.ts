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
  it("orders final locked preview -> financial -> data -> Google identity move -> completed transition -> completion audit", () => {
    const preview = position("await buildAccountMergePreview(");
    const financial = position(
      "await reconcileAccountMergeFinancialsInTransaction("
    );
    const data = position("await reconcileAccountMergeDataInTransaction(");
    const authMove = position("await db.moveAuthIdentityOwner(");
    const complete = position('status: "completed"', authMove);
    const audit = position('action: "merge_completed"', complete);

    expect(preview).toBeLessThan(financial);
    expect(financial).toBeLessThan(data);
    expect(data).toBeLessThan(authMove);
    expect(authMove).toBeLessThan(complete);
    expect(complete).toBeLessThan(audit);
  });

  it("never hard-deletes Source or deletes from users/auth anti-replay tables", () => {
    expect(source).not.toMatch(/delete\s*\(\s*users\s*\)/);
    expect(source).not.toMatch(/delete\s*\(\s*authIdentities\s*\)/);
    expect(source).not.toMatch(/delete\s*\(\s*paymentSlipClaims\s*\)/);
  });

  it("derives Source from the locked recovery request and never accepts sourceUserId as execute input", () => {
    const signature = source.slice(
      position("export async function executeAccountMerge"),
      position("await db.assertDatabaseAvailable")
    );
    expect(signature).not.toMatch(/sourceUserId\s*:/);
    expect(source).toContain(
      "const sourceUserId = Number(requestRow.requesterUserId)"
    );
  });

  it("requires a persisted blocked recovery request and exact typed confirmation before reconciliation writes", () => {
    expect(source).toContain('requestRow.status !== "blocked"');
    expect(source).toMatch(
      /isAccountMergeConfirmationExact\(\s*sourceUserId,\s*targetUserId,\s*params\.confirmation\s*\)/
    );
  });
});
