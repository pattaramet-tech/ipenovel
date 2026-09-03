import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relative), "utf8");
}

function between(source: string, startAnchor: string, endAnchor: string): string {
  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("IPE-021-D / 0047 immutable slip evidence foundation", () => {
  const migration = read("drizzle/0047_add_slip_evidence_foundation.sql");
  const db = read("server/db.ts");
  const r2 = read("server/services/r2PrivateStorage.ts");
  const upload = read("server/services/slipFileUploadService.ts");
  const order = read("server/services/orderService.ts");
  const submission = read("server/services/slipSubmissionService.ts");
  const recheck = read("server/services/ocrRecheckService.ts");
  const walletSubmission = read("server/services/walletTopupSubmissionService.ts");

  it("adds a write-once registry and monotonic version fields without promoting legacy extraction", () => {
    expect(migration).toContain("CREATE TABLE `slipEvidenceObjects`");
    expect(migration).toContain("ALTER TABLE `payments` ADD `evidenceVersion`");
    expect(migration).toContain("ALTER TABLE `walletTopups` ADD `evidenceVersion`");
    expect(migration).toContain("legacy_compatibility_required");
    expect(migration).toContain("`evidenceVersion` = CASE WHEN `slipImageUrl` IS NOT NULL");
    // Historical extractedData cannot be certified retroactively.
    const paymentBackfill = between(migration, "UPDATE `payments`", "ALTER TABLE `walletTopups`");
    const walletBackfill = between(migration, "UPDATE `walletTopups`", "CREATE INDEX `slipEvidenceObjects_ownerUserId_idx`");
    expect(paymentBackfill).not.toContain("extractedDataEvidenceVersion` =");
    expect(walletBackfill).not.toContain("extractedDataEvidenceVersion` =");
  });

  it("makes modern R2 writes create-only and content-binds the generated object namespace", () => {
    expect(r2).toMatch(/IfNoneMatch:\s*"\*"/);
    expect(upload).toMatch(/createHash\("sha256"\)\.update\(fileBuffer\)\.digest\("hex"\)/);
    expect(upload).toMatch(/payment-slips\/\$\{input\.userId\}\/\$\{fileHash\}\//);
    const putIdx = upload.indexOf('putPrivateObject("paymentSlip"');
    const registerIdx = upload.indexOf("registerModernSlipEvidenceObject", putIdx);
    const refIdx = upload.indexOf("toPrivateObjectRef(key)", registerIdx);
    expect(putIdx).toBeGreaterThan(-1);
    expect(registerIdx).toBeGreaterThan(putIdx);
    expect(refIdx).toBeGreaterThan(registerIdx);
  });

  it("registry identity is idempotent only for identical immutable metadata", () => {
    const body = between(
      db,
      "export async function registerModernSlipEvidenceObject(",
      "async function resolvePublishedSlipEvidence("
    );
    expect(body).toContain("insert(slipEvidenceObjects)");
    expect(body).toContain("isDuplicateKeyError(error)");
    expect(body).toContain("existing.ownerUserId");
    expect(body).toContain("existing.fileHash");
    expect(body).toContain("existing.byteSize");
    expect(body).toContain("existing.contentType");
    expect(body).toContain("SLIP_EVIDENCE_OBJECT_IDENTITY_CONFLICT");
  });

  it("only a registry-backed private object is classified modern_immutable", () => {
    const body = between(db, "async function resolvePublishedSlipEvidence(", "export async function createPayment(");
    expect(body).toContain("isPrivateObjectRef(slipImageUrl)");
    expect(body).toContain("from(slipEvidenceObjects)");
    expect(body).toContain("SLIP_EVIDENCE_OWNER_MISMATCH");
    expect(body).toContain('evidenceClass: "modern_immutable"');
    expect(body).toContain('evidenceClass: "legacy_compatibility_required"');
  });

  it("order and wallet replacement publish increment and CAS evidenceVersion atomically", () => {
    const orderPublish = between(db, "export async function publishReplacementSlipIfReviewable(", "export async function lockPaymentForUpdate(");
    expect(orderPublish).toContain("const nextEvidenceVersion = Number(current.evidenceVersion) + 1");
    expect(orderPublish).toContain("evidenceVersion: nextEvidenceVersion");
    expect(orderPublish).toContain("evidenceObjectKey: publishedEvidence.evidenceObjectKey");
    expect(orderPublish).toContain("extractedDataEvidenceVersion: fields.extractedData ? nextEvidenceVersion : null");
    expect(orderPublish).toContain("eq(payments.evidenceVersion, Number(current.evidenceVersion))");

    const walletPublish = between(db, "export async function publishWalletTopupReplacementIfReviewable(", "export async function createWalletTransaction(");
    expect(walletPublish).toContain("const nextEvidenceVersion = Number(current.evidenceVersion) + 1");
    expect(walletPublish).toContain("evidenceVersion: nextEvidenceVersion");
    expect(walletPublish).toContain("eq(walletTopups.evidenceVersion, Number(current.evidenceVersion))");
  });

  it("OCR/recheck persistence binds the monotonic version, not only URL + timestamp", () => {
    expect(submission).toContain("evidenceVersion: Number(publishedPayment?.evidenceVersion ?? 0)");
    expect(submission).toContain("extractedDataEvidenceVersion: publishedSlipVersion.evidenceVersion");
    expect(recheck).toContain("evidenceVersion: Number(payment.evidenceVersion)");
    expect(recheck).toContain("evidenceVersion: Number(current.evidenceVersion)");
    expect(walletSubmission).toContain("evidenceVersion: Number(topup.evidenceVersion)");
    expect(walletSubmission).toContain("Number(current.evidenceVersion) === expectedSlipVersion.evidenceVersion");
    expect(order).toContain("a.evidenceVersion !== undefined && a.evidenceVersion !== b.evidenceVersion");
  });

  it("generic financial evidence setters cannot bypass the publication contract", () => {
    const updatePayment = between(db, "export async function updatePayment(", "export async function approvePayment(");
    expect(updatePayment).not.toContain("slipImageUrl?:");
    expect(updatePayment).not.toContain("slipSubmittedAt?:");
    const bareWalletSetter = between(db, "export async function updateWalletTopupSlip(", "export async function publishWalletTopupReplacementIfReviewable(");
    expect(bareWalletSetter).toContain("SLIP_EVIDENCE_PUBLISH_REQUIRED");
    expect(bareWalletSetter).not.toContain(".update(walletTopups)");
  });
});
