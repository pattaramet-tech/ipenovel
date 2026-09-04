import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.resolve(import.meta.dirname, "db.ts"),
  "utf8"
);

function bodyBetween(startAnchor: string, endAnchor: string): string {
  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("Account Merge shared mutation barrier", () => {
  it("ordinary classified mutations acquire the dedicated guard first in SHARE mode, then transitional users/case SHARE locks", () => {
    const guardLocks = bodyBetween(
      "export async function lockAccountMutationGuardRows",
      "async function lockLegacyAccountMergeUsersExclusive"
    );
    const sharedBridge = bodyBetween(
      "async function lockAccountMergeMutationUserRows",
      "export async function activateAccountMutationGuardForMerge"
    );
    const sharedCaseLock = bodyBetween(
      "async function getAccountMergeCasesForSourceForShare",
      "function assertNoActiveAccountMergeCase"
    );
    const mutationGuard = bodyBetween(
      "export async function assertAccountMergeClassifiedMutationsAllowed",
      "export async function assertAccountMergePointsMutationAllowed"
    );

    expect(guardLocks).toContain("LOCK IN SHARE MODE");
    expect(sharedBridge).toContain('lockAccountMutationGuardRows(ordered, tx, "shared")');
    expect(sharedBridge).toContain("lockLegacyAccountMergeUsersShared(ordered, tx)");
    expect(sharedCaseLock).toContain("LOCK IN SHARE MODE");
    expect(mutationGuard).toContain("lockAccountMergeMutationUserRows(userIds, tx)");
    expect(mutationGuard).toContain("getAccountMergeCasesForSourceForShare(sourceUserId, tx)");
  });

  it("merge lifecycle keeps guard EXCLUSIVE, while points serialize on pointsAccounts after the shared classified guard", () => {
    const lifecycleBridge = bodyBetween(
      "export async function lockAccountMergeUserRows",
      "async function lockAccountMergeMutationUserRows"
    );
    const pointsRows = bodyBetween(
      "export async function lockPointsAccountRowsForUpdate",
      "export async function assertAccountMergePointsMutationAllowed"
    );
    const pointsGuard = bodyBetween(
      "export async function assertAccountMergePointsMutationAllowed",
      "export async function assertAccountMergeClassifiedMutationAllowed"
    );

    expect(lifecycleBridge).toContain('lockAccountMutationGuardRows(ordered, tx, "exclusive")');
    expect(lifecycleBridge).toContain("lockLegacyAccountMergeUsersExclusive(ordered, tx)");
    expect(pointsRows).toContain("FROM pointsAccounts");
    expect(pointsRows).toContain("FOR UPDATE");
    expect(pointsGuard).toContain("assertAccountMergeClassifiedMutationAllowed(userId, tx)");
    expect(pointsGuard).toContain("lockPointsAccountRowsForUpdate([userId], tx)");
    expect(pointsGuard).not.toContain("lockLegacyAccountMergeUsersExclusive");
  });

  it("repairs a legacy-created user's missing guard through the canonical-state provisioner", () => {
    const guardLocks = bodyBetween(
      "export async function lockAccountMutationGuardRows",
      "async function lockLegacyAccountMergeUsersExclusive"
    );
    expect(guardLocks).toContain("throw new AccountMutationGuardMissingError(userId)");
    expect(guardLocks).not.toContain("insert(accountMutationGuards)");
    expect(guardLocks).toContain("ensureProvisionedAccountMutationGuard(userId, tx)");
  });
});
