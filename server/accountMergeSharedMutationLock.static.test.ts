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
  it("ordinary classified mutations take shared user and guard-state locks", () => {
    const sharedUserLock = bodyBetween(
      "async function lockAccountMergeMutationUserRows",
      "export async function getAccountMergeCasesForSourceForUpdate"
    );
    const sharedCaseLock = bodyBetween(
      "async function getAccountMergeCasesForSourceForShare",
      "function assertNoActiveAccountMergeCase"
    );
    const mutationGuard = bodyBetween(
      "export async function assertAccountMergeClassifiedMutationsAllowed",
      "async function assertAccountMergePointsMutationAllowed"
    );

    expect(sharedUserLock).toContain("LOCK IN SHARE MODE");
    expect(sharedCaseLock).toContain("LOCK IN SHARE MODE");
    expect(mutationGuard).toContain(
      "lockAccountMergeMutationUserRows(userIds, tx)"
    );
    expect(mutationGuard).toContain(
      "getAccountMergeCasesForSourceForShare(sourceUserId, tx)"
    );
  });

  it("merge lifecycle and points balance mutations retain exclusive locks", () => {
    const lifecycleUserLock = bodyBetween(
      "export async function lockAccountMergeUserRows",
      "async function lockAccountMergeMutationUserRows"
    );
    const pointsGuard = bodyBetween(
      "async function assertAccountMergePointsMutationAllowed",
      "export async function assertAccountMergeClassifiedMutationAllowed"
    );

    expect(lifecycleUserLock).toContain("FOR UPDATE");
    expect(pointsGuard).toContain("lockAccountMergeUserRows([userId], tx)");
    expect(pointsGuard).toContain(
      "getAccountMergeCasesForSourceForUpdate(userId, tx)"
    );
  });
});
