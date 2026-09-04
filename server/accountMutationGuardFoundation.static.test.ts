import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("IPE-021-D account mutation guard foundation", () => {
  const schema = read("drizzle/schema.ts");
  const migration = read("drizzle/0045_add_payment_v2_foundation.sql");
  const dbCode = read("server/db.ts");
  const lifecycle = read("server/services/accountMergeGuardService.ts");

  it("defines one dedicated guard per user with generation and durable merge binding", () => {
    expect(schema).toContain('export const accountMutationGuards = mysqlTable(');
    expect(schema).toContain('userId: int("userId").primaryKey()');
    expect(schema).toContain('bigint("generation", { mode: "number", unsigned: true })');
    expect(schema).toContain('mysqlEnum("mergeState", ["open", "merge_guarded"])');
    expect(schema).toContain('uniqueIndex("accountMutationGuards_activeMergeCaseId_unique")');
    expect(schema).toContain('name: "accountMutationGuards_userId_fk"');
  });

  it("backfills every existing user from authoritative non-cancelled merge cases", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS `accountMutationGuards`");
    expect(migration).toContain("INSERT INTO `accountMutationGuards`");
    expect(migration).toContain("FROM `users` u");
    expect(migration).toContain("LEFT JOIN `accountMergeCases` amc");
    expect(migration).toContain("amc.`status` <> 'cancelled'");
    expect(migration).toContain("CASE WHEN amc.`id` IS NULL THEN 'open' ELSE 'merge_guarded' END");
  });

  it("provisions guards with users and repairs legacy-created users from canonical merge state", () => {
    const provisioningStart = dbCode.indexOf("async function ensureProvisionedAccountMutationGuard");
    const upsertStart = dbCode.indexOf("export async function upsertUser");
    const guardLockStart = dbCode.indexOf("export async function lockAccountMutationGuardRows");
    const legacyLockStart = dbCode.indexOf("async function lockLegacyAccountMergeUsersExclusive");
    expect(provisioningStart).toBeGreaterThan(-1);
    expect(upsertStart).toBeGreaterThan(provisioningStart);
    expect(dbCode.slice(upsertStart, upsertStart + 4000)).toContain("ensureProvisionedAccountMutationGuard");

    const guardLockBody = dbCode.slice(guardLockStart, legacyLockStart);
    expect(guardLockBody).toContain("throw new AccountMutationGuardMissingError(userId)");
    expect(guardLockBody).not.toContain("insert(accountMutationGuards)");
    expect(guardLockBody).toContain("ensureProvisionedAccountMutationGuard(userId, tx)");
    expect(dbCode.slice(provisioningStart, upsertStart)).toContain("accountMergeCases");
    expect(dbCode.slice(provisioningStart, upsertStart)).toContain("onDuplicateKeyUpdate");
  });

  it("bridges both merge lifecycle and ordinary V1 mutations through the new guard before users", () => {
    const lifecycleStart = dbCode.indexOf("export async function lockAccountMergeUserRows");
    const mutationStart = dbCode.indexOf("async function lockAccountMergeMutationUserRows");
    const activationStart = dbCode.indexOf("export async function activateAccountMutationGuardForMerge");
    const lifecycleBody = dbCode.slice(lifecycleStart, mutationStart);
    const mutationBody = dbCode.slice(mutationStart, activationStart);

    expect(lifecycleBody.indexOf('lockAccountMutationGuardRows(ordered, tx, "exclusive")')).toBeGreaterThan(-1);
    expect(lifecycleBody.indexOf("lockLegacyAccountMergeUsersExclusive(ordered, tx)")).toBeGreaterThan(
      lifecycleBody.indexOf('lockAccountMutationGuardRows(ordered, tx, "exclusive")')
    );
    expect(mutationBody.indexOf('lockAccountMutationGuardRows(ordered, tx, "shared")')).toBeGreaterThan(-1);
    expect(mutationBody.indexOf("lockLegacyAccountMergeUsersShared(ordered, tx)")).toBeGreaterThan(
      mutationBody.indexOf('lockAccountMutationGuardRows(ordered, tx, "shared")')
    );
  });

  it("activates the guard atomically with prepare and releases it only on cancellation", () => {
    const insertIndex = lifecycle.indexOf("tx.insert(accountMergeCases)");
    const activateIndex = lifecycle.indexOf("db.activateAccountMutationGuardForMerge");
    const faultIndex = lifecycle.indexOf('maybeInjectLifecycleFault("after_case_insert")');
    expect(insertIndex).toBeGreaterThan(-1);
    expect(activateIndex).toBeGreaterThan(insertIndex);
    expect(faultIndex).toBeGreaterThan(activateIndex);

    const cancelBranch = lifecycle.indexOf('if (params.transition === "cancel")');
    const releaseIndex = lifecycle.indexOf("db.releaseAccountMutationGuardFromMerge", cancelBranch);
    expect(cancelBranch).toBeGreaterThan(-1);
    expect(releaseIndex).toBeGreaterThan(cancelBranch);

    expect(dbCode).toContain('generation: sql`${accountMutationGuards.generation} + 1`');
  });
});
