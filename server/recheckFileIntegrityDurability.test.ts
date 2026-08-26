/**
 * IPE-001-C08: "Admin Recheck must fail closed on provider failure and on any
 * unavailable second hash - a single pre-OCR hash must never become manual-
 * approval authority after same-URL bytes may have changed."
 *
 * ── The bugs ───────────────────────────────────────────────────────────────
 * recheckOrderPaymentOcr computes `preOcrFileHash` ONCE, before OCR runs.
 *
 * P1 #1 (provider/image-preparation failure): the catch block terminalized
 * using `technicalPathFileHash = preOcrFileHash` directly, with NO re-check
 * at all - regardless of how long the (possibly retried) provider call took,
 * or whether the object at that URL changed underneath it. The row's
 * extractedData had ALREADY been persisted with this hash before the
 * provider call (a pre-existing, unconditional write), so a normal admin
 * Approve reading that row could still claim the stale hash.
 *
 * P1 #2 (successful OCR, second hash unavailable): the post-extraction
 * checkpoint only blocked when `recomputedFileHash` was truthy AND differed
 * from `preOcrFileHash` - `effectiveFileHash = recomputedFileHash ??
 * preOcrFileHash` then treated a FAILED second fetch identically to a
 * CONFIRMED-stable one, silently trusting the baseline and potentially
 * clearing a prior integrity block.
 *
 * ── The fix ────────────────────────────────────────────────────────────────
 * One shared `verifyStableOrBlock` helper, called at BOTH checkpoints: it
 * re-hashes the SAME stored slip and durably blocks (SLIP_INTEGRITY_BLOCK_REASON,
 * via the existing db.updatePaymentIfNotFinalized/buildSupersededResult CAS
 * machinery) whenever the rehash differs from the baseline OR is unavailable.
 * Only a rehash that EXACTLY matches the baseline lets the caller proceed
 * using it as current file identity.
 *
 * Structural, matching ocrRecheckService.test.ts's own established pattern:
 * this file requires a live database transaction to exercise end-to-end (the
 * `.integration.test.ts` project, unavailable in this sandbox).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

function readCode(relativePath: string): string {
  return fs
    .readFileSync(path.resolve(process.cwd(), relativePath), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("ocrRecheckService.ts: one shared stability checkpoint, used at every terminal path that could publish a stale baseline", () => {
  const code = readCode("server/services/ocrRecheckService.ts");

  it("defines ONE shared verifyStableOrBlock helper", () => {
    const idx = code.indexOf("async function verifyStableOrBlock(");
    expect(idx).toBeGreaterThan(-1);
    expect(code.match(/async function verifyStableOrBlock\(/g)?.length).toBe(1);
  });

  it("the helper re-hashes and blocks on ANY mismatch, including an unavailable second hash", () => {
    const idx = code.indexOf("async function verifyStableOrBlock(");
    const body = code.slice(idx, idx + 800);
    expect(body).toMatch(/const rehash = await computeSlipFileHash\(payment\.slipImageUrl\);/);
    expect(body).toMatch(/if \(rehash === baselineHash\) return undefined;/);
    // No separate truthiness check before the equality test - an undefined
    // rehash (failed re-fetch) falls straight into the "not equal" / block
    // branch exactly like a genuine mismatch, never a silent pass-through.
    expect(body).not.toMatch(/if \(rehash && rehash === baselineHash\)/);
  });

  it("is called at both the provider/image-preparation failure path and the post-extraction path", () => {
    const calls = code.match(/await verifyStableOrBlock\(/g);
    expect(calls?.length).toBe(2);
  });

  it("the provider-failure checkpoint runs BEFORE that path's attempt is recorded and its result returned", () => {
    const catchIdx = code.indexOf("} catch (error) {");
    expect(catchIdx).toBeGreaterThan(-1);
    const checkIdx = code.indexOf("await verifyStableOrBlock(", catchIdx);
    const technicalPathFileHashIdx = code.indexOf("const technicalPathFileHash = preOcrFileHash;", catchIdx);
    expect(checkIdx).toBeGreaterThan(catchIdx);
    expect(checkIdx).toBeLessThan(technicalPathFileHashIdx);
  });

  it("the post-extraction checkpoint runs BEFORE the final extraction write that would publish it", () => {
    const extractIdx = code.indexOf("const extracted = extractSlipData(ocrText, providerConfidence);");
    expect(extractIdx).toBeGreaterThan(-1);
    const checkIdx = code.indexOf("await verifyStableOrBlock(", extractIdx);
    const finalWriteIdx = code.indexOf("const wroteFinal = await db.updatePaymentIfNotFinalized(");
    expect(checkIdx).toBeGreaterThan(extractIdx);
    expect(checkIdx).toBeLessThan(finalWriteIdx);
  });

  it("a missing baseline (first hash attempt itself failed) skips the check and still allows the second attempt to add an identifier - monotonic, never a false block", () => {
    const idx = code.indexOf("let effectiveFileHash: string | undefined = preOcrFileHash || undefined;");
    expect(idx).toBeGreaterThan(-1);
    const body = code.slice(idx, idx + 700);
    expect(body).toMatch(/\} else \{/);
    expect(body).toMatch(/effectiveFileHash = await computeSlipFileHash\(payment\.slipImageUrl\);/);
  });

  it("the block write uses the existing SLIP_INTEGRITY_BLOCK_REASON and CAS machinery - not a new, parallel mechanism", () => {
    const idx = code.indexOf("async function verifyStableOrBlock(");
    const body = code.slice(idx, idx + 1400);
    expect(body).toMatch(/reviewReason: SLIP_INTEGRITY_BLOCK_REASON,/);
    expect(body).toMatch(/db\.updatePaymentIfNotFinalized\(/);
    expect(body).toMatch(/slipVersionAtStart/);
    expect(body).toMatch(/await buildSupersededResult\(/);
  });

  it("the block always reports readyForAdminApproval: false and hasStrongIdentifier: true - blocked, not evidence-less", () => {
    const idx = code.indexOf("async function verifyStableOrBlock(");
    const body = code.slice(idx, idx + 2000);
    expect(body).toMatch(/readyForAdminApproval: false,/);
    expect(body).toMatch(/hasStrongIdentifier: true,/);
  });
});

describe("OCR_DISABLED consistency audit, IPE-001-C08", () => {
  // Uses the RAW source (not readCode) - the audit conclusion this pins is
  // itself documented in a comment, so it must not be stripped.
  const raw = fs.readFileSync(
    path.resolve(process.cwd(), "server/services/ocrRecheckService.ts"),
    "utf-8"
  );

  it("has no OCR/provider call between persisting preOcrFileHash and the OCR_DISABLED return - no second boundary exists to re-verify against", () => {
    const hashLine = "const preOcrFileHash = await computeSlipFileHash(payment.slipImageUrl);";
    const hashWriteIdx = raw.indexOf(hashLine);
    const disabledGateIdx = raw.indexOf("if (!config.enabled) {", hashWriteIdx);
    expect(hashWriteIdx).toBeGreaterThan(-1);
    expect(disabledGateIdx).toBeGreaterThan(hashWriteIdx);

    const between = raw.slice(hashWriteIdx + hashLine.length, disabledGateIdx);
    // Only the CAS-guarded write and its superseded fallback may run here -
    // no provider round-trip and no second hash attempt, which is exactly
    // why there is no separate boundary for this early exit to re-verify at.
    expect(between).toMatch(/db\.updatePaymentIfNotFinalized\(/);
    expect(between).not.toMatch(/prepareSlipImageForOcr|parseSlipImage|computeSlipFileHash/);
  });

  it("documents the audit conclusion for this early exit", () => {
    expect(raw).toMatch(/IPE-001-C08 consistency audit/);
  });
});
