import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("./services/historicalAccountMergeCompensationService.ts", import.meta.url)),
  "utf8"
);
const dbSource = readFileSync(fileURLToPath(new URL("./db.ts", import.meta.url)), "utf8");
const routerSource = readFileSync(fileURLToPath(new URL("./routers.ts", import.meta.url)), "utf8");
const schemaSource = readFileSync(fileURLToPath(new URL("../drizzle/schema.ts", import.meta.url)), "utf8");

function compensationServiceBody(): string {
  return source;
}

describe("Historical Account Merge compensation static safety", () => {
  it("never rewrites/deletes the historical Case, reconciliation receipts, or merge audit rows", () => {
    for (const forbidden of [
      ".update(accountMergeCases)",
      ".delete(accountMergeCases)",
      ".update(accountMergeFinancialReconciliations)",
      ".delete(accountMergeFinancialReconciliations)",
      ".update(accountMergeDataReconciliations)",
      ".delete(accountMergeDataReconciliations)",
      ".update(accountMergeAuditLogs)",
      ".delete(accountMergeAuditLogs)",
      "reconcileAccountMergeFinancials(",
      "reconcileAccountMergeFinancialsInTransaction(",
    ]) {
      expect(compensationServiceBody()).not.toContain(forbidden);
    }
    expect(source).toContain("HISTORICAL_EVIDENCE_MUTATED");
    expect(source).toContain("HISTORICAL_IMMUTABLE_DATA_MUTATED");
  });

  it("moves only the existing identity by CAS and never creates or exposes a provider subject", () => {
    expect(source).toContain("db.moveAuthIdentityOwner");
    expect(source).not.toContain("linkGoogleIdentity");
    expect(source).not.toContain("createGoogleUserWithIdentity");
    expect(source).not.toContain("providerSubject");
  });

  it("uses a unique additive lifecycle/receipt barrier and an exact SHA-256 snapshot digest", () => {
    expect(schemaSource).toContain('"accountMergeCompensations"');
    expect(schemaSource).toContain('uniqueIndex("accountMergeCompensations_historical_case_unique")');
    expect(schemaSource).toContain('uniqueIndex("accountMergeCompensationReceipts_historical_case_unique")');
    expect(source).toContain('createHash("sha256")');
    expect(source).toContain("SNAPSHOT_DIGEST_DRIFT");
    expect(source).toContain('status: "completed"');
  });

  it("does not globally disable the Account Merge guard: release is receipt-bound and Donor receives a dedicated guard", () => {
    expect(dbSource).toContain("hasValidCompletedHistoricalCompensationRelease");
    expect(dbSource).toContain("active.status === \"completed\"");
    expect(dbSource).toContain("AccountMergeCompensationDonorGuardError");
    expect(dbSource).toContain("getHistoricalCompensationDonorGuardsForUpdate");
    expect(dbSource).toContain("ACCOUNT_MERGE_GUARDED_STATUSES");
  });

  it("exposes execution only through the admin mutation with expectedSnapshotDigest and an explicit fail-closed environment/scope gate", () => {
    expect(routerSource).toMatch(/historicalMergeCompensationPreflight:\s*adminProcedure[\s\S]*?\.query\(/);
    expect(routerSource).toMatch(/historicalMergeCompensationExecute:\s*adminProcedure[\s\S]*?\.mutation\(/);
    expect(routerSource).toContain("expectedSnapshotDigest");
    expect(routerSource).toContain("actorAdminId: Number(ctx.user.id)");
    expect(source).toContain("ACCOUNT_MERGE_HISTORICAL_COMPENSATION_EXECUTION_ENABLED");
    expect(source).toContain("ACCOUNT_MERGE_HISTORICAL_COMPENSATION_SCOPE");
    expect(source).toContain('AUTHORIZED_EXECUTION_SCOPE = "90007:1:21960193:763680006:5370059"');
    expect(source).toContain("expectedScope !== AUTHORIZED_EXECUTION_SCOPE");
    expect(source).toContain("process.env[EXECUTION_SCOPE_ENV] !== AUTHORIZED_EXECUTION_SCOPE");
    expect(source).toContain("EXECUTION_DISABLED");
    expect(source).toContain("EXECUTION_SCOPE_MISMATCH");
    expect(source).toContain("assertExecutionAuthorized(input)");
    expect(source).toContain("COMPENSATION_STATE_CAS_FAILED");
    expect(source).toContain("eq(accountMergeCompensations.status, expectedStartStatus)");
    expect(source).toContain('eq(accountMergeCompensations.status, "in_progress")');
    expect(source).toContain("assertLifecycleCas(startedUpdate");
    expect(source).toContain("assertLifecycleCas(completedUpdate");
    expect(source).toContain("assertLifecycleCas(failedUpdate");
  });
});
