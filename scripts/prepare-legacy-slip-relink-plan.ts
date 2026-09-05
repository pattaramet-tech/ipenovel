#!/usr/bin/env tsx
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  parseLegacySlipRelinkArgs,
  RelinkOptionsError,
} from "./lib/legacySlipRelinkOptions";
import {
  validateLegacySlipAuditEnvironment,
  AuditOptionsError,
} from "./lib/legacySlipAuditOptions";
import {
  createPrivateRelinkOutput,
  RelinkOutputError,
} from "./lib/legacySlipRelinkPrivateOutput";

let artifactState:
  "NOT_STARTED" | "DIRECTORY_READY" | "WRITE_ATTEMPTED" | "FINALIZED" =
  "NOT_STARTED";
let privateOutputDirectory: string | undefined;

async function sourceFingerprint(): Promise<string> {
  const digest = createHash("sha256");
  const files = [
    "prepare-legacy-slip-relink-plan.ts",
    "lib/legacySlipRelinkOptions.ts",
    "lib/legacySlipRelinkPlan.ts",
    "lib/legacySlipRelinkRead.ts",
    "lib/legacySlipRelinkPrivateOutput.ts",
    "lib/legacySlipAuditOptions.ts",
    "lib/legacySlipAuditRuntime.ts",
    "../server/helpers/legacySlipAuditBytes.ts",
    "../server/helpers/legacySlipReconciliationPlan.ts",
    "../server/services/r2PrivateConfigValidator.ts",
  ];
  for (const file of files) {
    const bytes = await readFile(new URL(file, import.meta.url));
    digest
      .update(file)
      .update("\0")
      .update(String(bytes.length))
      .update("\0")
      .update(bytes);
  }
  return digest.digest("hex");
}

async function main(): Promise<void> {
  const args = parseLegacySlipRelinkArgs(process.argv.slice(2));
  if (args.mode === "help") {
    console.log(
      "Usage: node --import tsx scripts/prepare-legacy-slip-relink-plan.ts --prepare --confirm-preview --code-sha=<40 lowercase hex>\n" +
        "Linux Preview only. DB/R2 read-only; creates a private /tmp review artifact (directory0700/file0600).\n" +
        "Exactly ten legacy targets. No apply, attestation-acceptance, override or output-path flags.\n" +
        "The SHA is operator-declared; actual tool sources are fingerprinted separately.\n" +
        "Exit 0: all ten await human attestation, not write permission; 1: blocked/skipped rows; 2: fatal/preflight/output failure.\n" +
        "Share only the sanitized stdout summary. Do not paste the private plan into chat."
    );
    return;
  }
  const config = validateLegacySlipAuditEnvironment(process.env);
  const toolSourceDigest = await sourceFingerprint();
  // Fail on unsupported platforms/permissions BEFORE connecting to DB or R2.
  const output = await createPrivateRelinkOutput();
  privateOutputDirectory = output.directory;
  artifactState = "DIRECTORY_READY";
  const {
    prepareLegacySlipRelinkPlan,
    createRelinkReaders,
    relinkTargetFingerprint,
    summarizeRelinkPlan,
  } = await import("./lib/legacySlipRelinkPlan");
  const readers = createRelinkReaders(config);
  let plan;
  try {
    plan = await prepareLegacySlipRelinkPlan(readers, {
      runId: randomUUID(),
      preparedAt: new Date().toISOString(),
      declaredCodeSha: args.declaredCodeSha,
      toolSourceDigest,
      targetFingerprint: relinkTargetFingerprint(config),
    });
  } finally {
    readers.close();
  }
  artifactState = "WRITE_ATTEMPTED";
  const artifact = await output.writePlan(plan);
  artifactState = "FINALIZED";
  // No private data is printed, including on output failure. Paths are locally generated.
  console.log(
    JSON.stringify({
      ...summarizeRelinkPlan(plan),
      artifactCreated: true,
      privatePlanPath: artifact.path,
      privatePlanSha256: artifact.sha256,
    })
  );
  process.exitCode = plan.rows.every(row => row.status === "NEEDS_ATTESTATION")
    ? 0
    : 1;
}

main().catch(error => {
  const code =
    error instanceof RelinkOptionsError ||
    error instanceof AuditOptionsError ||
    error instanceof RelinkOutputError
      ? error.code
      : "PREPARE_PLAN_FAILED";
  // A post-publication filesystem error may leave a complete private plan.
  // Do not falsely report absence, retry over it, or print its contents.
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
      writeAuthorized: false,
    })
  );
  process.exitCode = 2;
});
