#!/usr/bin/env tsx
import {
  parseLegacySlipAuditArgs,
  validateLegacySlipAuditEnvironment,
  AuditOptionsError,
} from "./lib/legacySlipAuditOptions";

async function main(): Promise<void> {
  // Reject unsafe flags BEFORE loading any database/storage modules or env file.
  const mode = parseLegacySlipAuditArgs(process.argv.slice(2));
  if (mode === "help") {
    console.log(
      "Usage: tsx scripts/audit-legacy-slip-references.ts --dry-run --confirm-preview\n" +
        "Read-only audit of exactly 10 approved legacy-slip targets on the pinned Preview DB/private bucket.\n" +
        "No apply/live mode. No source URLs, object keys, hashes or credentials in output.\n" +
        "Exit 0: every row identity-verified for review (NOT write permission); 1: blocked/skipped/unproven; 2: configuration/arguments/run failure."
    );
    return;
  }
  const config = validateLegacySlipAuditEnvironment(process.env);
  const { createPreviewAuditReaders, auditPreviewLegacySlips } =
    await import("./lib/legacySlipAuditRuntime");
  const readers = createPreviewAuditReaders(config);
  try {
    const reports = await auditPreviewLegacySlips(readers, report =>
      console.log(JSON.stringify(report))
    );
    const reviewCount = reports.filter(
      report => report.action === "REVIEW_REFERENCE_REPAIR"
    ).length;
    console.log(
      JSON.stringify({
        type: "summary",
        mode: "dry-run",
        targetCount: 10,
        reportedCount: reports.length,
        identityVerifiedForReview: reviewCount,
        notReadyForReview: reports.length - reviewCount,
        databaseWrites: 0,
        objectWrites: 0,
        writeAuthorized: false,
        pointInTimeOnly: true,
        nextAction: "INDEPENDENT_REVIEW_NO_APPLY",
      })
    );
    process.exitCode = reviewCount === 10 ? 0 : 1;
  } finally {
    readers.close();
  }
}

main().catch(error => {
  console.error(
    JSON.stringify({
      type: "fatal",
      code:
        error instanceof AuditOptionsError ? error.code : "AUDIT_RUN_FAILED",
    })
  );
  process.exitCode = 2;
});
