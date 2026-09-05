#!/usr/bin/env tsx
import {
  parseLegacySlipRepairArgs,
  readPrivateRepairInput,
  requirePrivateLinux,
  RepairInputError,
} from "./lib/legacySlipRepairPrivateInput";
import {
  createPrivateRelinkOutput,
  RelinkOutputError,
} from "./lib/legacySlipRelinkPrivateOutput";
import {
  parseRepairPlan,
  createOperatorAttestation,
  validateOperatorAttestation,
  parsePrivateRepairJson,
  PINNED_REPAIR_PLAN_SHA256,
  RepairError,
} from "./lib/legacySlipRepairContract";
import {
  validateLegacySlipAuditEnvironment,
  AuditOptionsError,
} from "./lib/legacySlipAuditOptions";

let artifactState:
  "NOT_STARTED" | "DIRECTORY_READY" | "WRITE_ATTEMPTED" | "FINALIZED" =
  "NOT_STARTED";
let privateOutputDirectory: string | undefined;

async function main(): Promise<void> {
  const args = parseLegacySlipRepairArgs(process.argv.slice(2));
  if (args.mode === "help") {
    console.log(
      "Single payment 11280001; Linux only. No apply/live mode.\n" +
        "Record a private FIRST operator attestation, no network:\n" +
        "  --record-attestation --plan=/private/plan.json --statement=/private/statement.json --code-sha=FULL_SHA\n" +
        "Read-only Preview revalidation:\n" +
        "  --dry-run --confirm-preview --plan=/private/plan.json --attestation=/private/attestation.json --code-sha=FULL_SHA\n" +
        "Input directory0700/file0600; no symlinks. Statement fields: reviewer,reason,evidenceReference,sameTransactionConfirmed:true.\n" +
        "A statement is an operator assertion, not identity authentication or second-human review.\n" +
        "Share sanitized summary only. Exit0=record created/dry-run match,1=blocked,2=fatal. No exit code authorizes writing."
    );
    return;
  }
  requirePrivateLinux();
  const plan = await readPrivateRepairInput(args.plan, 8 * 1024 * 1024);
  const intent = parseRepairPlan(plan, PINNED_REPAIR_PLAN_SHA256);
  const inputBytes = await readPrivateRepairInput(args.input, 64 * 1024);
  const input = parsePrivateRepairJson(inputBytes, 64 * 1024);
  const tool = {
    declaredCodeSha: args.codeSha,
    codeShaVerification: "OPERATOR_DECLARED_NOT_VERIFIED",
  };
  if (args.mode === "record-attestation") {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new RepairInputError("PRIVATE_INPUT_FAILED");
    const s = input as Record<string, unknown>;
    const keys = [
      "reviewer",
      "reason",
      "evidenceReference",
      "sameTransactionConfirmed",
    ];
    if (
      Object.keys(s).length !== keys.length ||
      Object.keys(s).some(k => !keys.includes(k)) ||
      s.sameTransactionConfirmed !== true ||
      typeof s.reviewer !== "string" ||
      typeof s.reason !== "string" ||
      typeof s.evidenceReference !== "string"
    )
      throw new RepairInputError("PRIVATE_INPUT_FAILED");
    const attestation = createOperatorAttestation(intent, {
      reviewer: s.reviewer,
      reason: s.reason,
      evidenceReference: s.evidenceReference,
      recordedAt: new Date().toISOString(),
    });
    const output = await createPrivateRelinkOutput();
    privateOutputDirectory = output.directory;
    artifactState = "DIRECTORY_READY";
    artifactState = "WRITE_ATTEMPTED";
    const artifact = await output.writePlan(attestation);
    artifactState = "FINALIZED";
    console.log(
      JSON.stringify({
        type: "summary",
        mode: "record-operator-attestation",
        sourceType: "order_payment",
        sourceId: 11280001,
        status: "OPERATOR_ATTESTATION_RECORDED",
        independentReview: "PENDING",
        historicalByteIdentity: "UNPROVEN",
        databaseWrites: 0,
        objectWrites: 0,
        writeAuthorized: false,
        liveApplyAvailable: false,
        artifactCreated: true,
        privateAttestationPath: artifact.path,
        privateAttestationSha256: artifact.sha256,
        ...tool,
      })
    );
    return;
  }
  const attestation = validateOperatorAttestation(input, intent);
  const config = validateLegacySlipAuditEnvironment(process.env);
  const { relinkTargetFingerprint, createRelinkReaders } =
    await import("./lib/legacySlipRelinkPlan");
  const fingerprint = relinkTargetFingerprint(config);
  // Refuse even constructing network clients if the reviewed account/DB target changed.
  if (fingerprint !== intent.targetFingerprint)
    throw new RepairInputError("PRIVATE_INPUT_UNSAFE");
  const { dryRunLegacySlipRepair } =
    await import("./lib/legacySlipRepairDryRun");
  const readers = createRelinkReaders(config);
  let result;
  try {
    result = await dryRunLegacySlipRepair(intent, attestation, readers, {
      targetFingerprint: fingerprint,
    });
  } finally {
    readers.close();
  }
  console.log(JSON.stringify({ ...result, ...tool }));
  process.exitCode = result.status === "DRY_RUN_MATCH" ? 0 : 1;
}

main().catch(error => {
  const code =
    error instanceof RepairInputError ||
    error instanceof RelinkOutputError ||
    error instanceof RepairError ||
    error instanceof AuditOptionsError
      ? error.code
      : "REPAIR_PREPARATION_FAILED";
  console.error(
    JSON.stringify({
      type: "fatal",
      code,
      artifactCreated:
        artifactState === "FINALIZED"
          ? true
          : artifactState === "WRITE_ATTEMPTED"
            ? null
            : false,
      artifactState:
        artifactState === "WRITE_ATTEMPTED"
          ? "UNCERTAIN_CHECK_PRIVATE_DIRECTORY"
          : artifactState,
      ...(privateOutputDirectory ? { privateOutputDirectory } : {}),
      databaseWrites: 0,
      objectWrites: 0,
      writeAuthorized: false,
      liveApplyAvailable: false,
    })
  );
  process.exitCode = 2;
});
