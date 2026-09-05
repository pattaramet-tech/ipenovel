#!/usr/bin/env tsx
import {
  LEGACY_REPAIR_EXECUTION_RELEASED,
  parseRepairExecutionArgs,
  repairExecutionDisabledSummary,
  RepairExecutionError,
} from "./lib/legacySlipRepairExecution";

async function main() {
  const args = parseRepairExecutionArgs(process.argv.slice(2));
  if (args.mode === "help") {
    console.log(
      "DISABLED release candidate; only order_payment:11280001. No live execution is available.\n" +
        "Requires separate release review, real Linux/MariaDB gates, actual second-human mapping review, explicit live authorization, external comprehensive writer freeze and separately approved audit schema.\n" +
        "Future syntax: --execute --confirm-preview --plan=/private/plan.json --attestation=/private/attestation.json --review=/private/review.json --authorization=/private/authorization.json --code-sha=FULL_SHA\n" +
        "Read-only recovery inspection: --reconcile instead of --execute, retaining the exact original four private artifacts; expired original grants are not renewed. No R2 access, write or automatic retry.\n" +
        "Linux private files only: directory0700/file0600; no symlinks. No env/flag bypass, target overrides, DDL, R2 writes, OCR or approval.\n" +
        "Execution stays disabled BEFORE environment/private file/network access. No automatic retry; UNKNOWN requires independent read-only reconciliation."
    );
    return;
  }
  if (args.mode === "reconcile") {
    const { runLegacySlipRepairReconciliation } =
      await import("./lib/legacySlipRepairExecution");
    const result = await runLegacySlipRepairReconciliation(args);
    console.log(
      JSON.stringify({
        ...result,
        declaredCodeSha: args.codeSha,
        codeShaVerification: "OPERATOR_DECLARED_NOT_VERIFIED",
      })
    );
    process.exitCode = result.status === "MATCHING_AUDIT_AND_STATE" ? 0 : 1;
    return;
  }
  if (!LEGACY_REPAIR_EXECUTION_RELEASED) {
    console.log(JSON.stringify(repairExecutionDisabledSummary(args.codeSha)));
    process.exitCode = 1;
    return;
  }
  const { runPreparedLegacySlipRepairExecution } =
    await import("./lib/legacySlipRepairExecution");
  const result = await runPreparedLegacySlipRepairExecution(args);
  console.log(
    JSON.stringify({
      ...result,
      declaredCodeSha: args.codeSha,
      codeShaVerification: "OPERATOR_DECLARED_NOT_VERIFIED",
    })
  );
  process.exitCode =
    result.status === "APPLIED" || result.status === "ALREADY_APPLIED" ? 0 : 1;
}
main().catch(error => {
  console.error(
    JSON.stringify({
      type: "fatal",
      status: "BLOCKED",
      code:
        error instanceof RepairExecutionError
          ? "INVALID_EXECUTION_ARGUMENTS"
          : "EXECUTION_ENTRYPOINT_FAILED",
      liveApplyAvailable: false,
      automaticRetry: false,
    })
  );
  process.exitCode = 2;
});
