/**
 * IPE-001-C09 P1: "Rehash the current slip during manual approval."
 *
 * ── The bug ────────────────────────────────────────────────────────────────
 * Manual admin approval (orderService.ts's approvePaymentInTx, db.ts's
 * approveWalletTopup) locks and reloads the row, then derives strong
 * identifiers from `persistedExtractedData` - the extraction written by the
 * LAST successful OCR/Recheck. It never re-reads the bytes currently served
 * at `slipImageUrl`. The row lock and the slip-version/status/
 * SLIP_INTEGRITY_BLOCK_REASON guards all serialize concurrent WRITES to this
 * row; none of them serialize an external object-store mutation of the same
 * storage key. So if the bytes behind the same URL change after the last
 * stable OCR/Recheck but before an admin clicks Approve, the persisted
 * fileHash still describes the OLD bytes, and this code claimed it anyway -
 * approving the payment while displaying NEW bytes whose actual hash was
 * never claimed and remained reusable.
 *
 * ── The fix ────────────────────────────────────────────────────────────────
 * Both approval paths now recompute the current slip's hash INSIDE the
 * approval transaction, immediately before claimSlip:
 *   - A persisted fileHash exists and disagrees with the current hash ->
 *     fail closed (SLIP_INTEGRITY_MISMATCH_AT_APPROVAL), zero claim/value.
 *   - The current hash cannot be computed at all -> fail closed
 *     (SLIP_CURRENT_BYTES_UNAVAILABLE) - unavailability is uncertainty,
 *     never proof of stability.
 *   - Otherwise the freshly confirmed current hash is bound into the
 *     identifiers this SAME transaction claims, enriching a reference-only
 *     record and re-confirming one that already had a hash. A reference
 *     match alone never bypasses this when a slip file exists.
 *
 * Order and wallet are structurally identical fixes; wallet's
 * `approveWalletTopup` runs inside a real DB transaction and requires
 * TEST_DATABASE_URL (the `.integration.test.ts` project, unavailable in this
 * sandbox), so both are pinned structurally here, matching this codebase's
 * established pattern for other DB-transaction-heavy files.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

function readCode(relativePath: string): string {
  return fs
    .readFileSync(path.resolve(process.cwd(), relativePath), "utf-8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("orderService.ts approvePaymentInTx: current-byte integrity before claim, IPE-001-C09", () => {
  const code = readCode("server/services/orderService.ts");

  it("recomputes the current hash from slipImageUrl, not from persisted extraction", () => {
    const fnIdx = code.indexOf("async function approvePaymentInTx(");
    expect(fnIdx).toBeGreaterThan(-1);
    const checkIdx = code.indexOf(
      "const currentFileHash = isLegacyStorageUrl(payment.slipImageUrl)",
      fnIdx
    );
    expect(checkIdx).toBeGreaterThan(fnIdx);
  });

  it("runs AFTER the strong-identifier check but BEFORE claimSlip - even a reference-only record is checked when a slip exists", () => {
    const fnIdx = code.indexOf("async function approvePaymentInTx(");
    const strongIdIdx = code.indexOf("if (!hasStrongIdentifier(identifiers)) {", fnIdx);
    const checkIdx = code.indexOf(
      "const currentFileHash = isLegacyStorageUrl(payment.slipImageUrl)",
      fnIdx
    );
    const claimIdx = code.indexOf(
      'const claim = await atOrderPaymentApprovalStage("slip_claim"',
      fnIdx
    );
    expect(strongIdIdx).toBeGreaterThan(fnIdx);
    expect(checkIdx).toBeGreaterThan(strongIdIdx);
    expect(checkIdx).toBeLessThan(claimIdx);
  });

  it("caps the locked current-byte fetch below the generic storage timeout without moving it outside the transaction", () => {
    expect(code).toMatch(/export const ORDER_APPROVAL_SLIP_HASH_TIMEOUT_MS = 3_000;/);
    const idx = code.indexOf("const currentFileHash = isLegacyStorageUrl(payment.slipImageUrl)");
    const body = code.slice(idx, idx + 1200);
    expect(body).toMatch(/computeTrustedLegacySlipFileHash\(payment\.slipImageUrl, \{\s*timeoutMs: ORDER_APPROVAL_SLIP_HASH_TIMEOUT_MS/);
    expect(body).toMatch(/computeSlipFileHash\(payment\.slipImageUrl, \{\s*timeoutMs: ORDER_APPROVAL_SLIP_HASH_TIMEOUT_MS/);
  });

  it("fails closed when the current hash is unavailable - unavailability is never treated as stability", () => {
    const idx = code.indexOf("const currentFileHash = isLegacyStorageUrl(payment.slipImageUrl)");
    const body = code.slice(idx, idx + 1400);
    expect(body).toMatch(/if \(!currentFileHash\) \{/);
    expect(body).toMatch(/throw new Error\(\s*\n\s*"SLIP_CURRENT_BYTES_UNAVAILABLE:/);
  });

  it("fails closed when a persisted fileHash disagrees with the current hash", () => {
    const idx = code.indexOf("const currentFileHash = isLegacyStorageUrl(payment.slipImageUrl)");
    const body = code.slice(idx, idx + 1400);
    expect(body).toMatch(/if \(persistedFileHash && currentFileHash !== persistedFileHash\) \{/);
    expect(body).toMatch(/throw new Error\(\s*\n\s*"SLIP_INTEGRITY_MISMATCH_AT_APPROVAL:/);
  });

  it("binds the freshly confirmed hash into identifiers.fileHash before claimSlip runs", () => {
    const idx = code.indexOf("const currentFileHash = isLegacyStorageUrl(payment.slipImageUrl)");
    const claimIdx = code.indexOf("const claim = await claimSlip(", idx);
    const body = code.slice(idx, claimIdx);
    expect(body).toMatch(/identifiers\.fileHash = currentFileHash;/);
  });

  it("only runs when a slip actually exists and keeps legacy absolute URLs out of the hash fetch", () => {
    const idx = code.indexOf("if (payment.slipImageUrl) {");
    expect(idx).toBeGreaterThan(-1);
    const compatibilityIdx = code.indexOf("const currentFileHash = isLegacyStorageUrl(payment.slipImageUrl)", idx);
    const privateFetchIdx = code.indexOf(": await computeSlipFileHash(payment.slipImageUrl, {", compatibilityIdx);
    expect(compatibilityIdx).toBeGreaterThan(idx);
    expect(compatibilityIdx - idx).toBeLessThan(500);
    expect(privateFetchIdx).toBeGreaterThan(compatibilityIdx);
  });
});

describe("db.ts approveWalletTopup: current-byte integrity before claim, IPE-001-C09", () => {
  const code = readCode("server/db.ts");

  it("recomputes the current hash from slipImageUrl, not from persisted extraction", () => {
    const fnIdx = code.indexOf("export async function approveWalletTopup(");
    expect(fnIdx).toBeGreaterThan(-1);
    const checkIdx = code.indexOf(
      "currentFileHash = isLegacyStorageUrl(topup.slipImageUrl as string)",
      fnIdx
    );
    expect(checkIdx).toBeGreaterThan(fnIdx);
  });

  it("caps wallet approval current-byte hashing at 3s while keeping it inside the approval transaction", () => {
    expect(code).toMatch(/export const WALLET_APPROVAL_SLIP_HASH_TIMEOUT_MS = 3_000;/);
    const fnIdx = code.indexOf("export async function approveWalletTopup(");
    const checkIdx = code.indexOf(
      "currentFileHash = isLegacyStorageUrl(topup.slipImageUrl as string)",
      fnIdx
    );
    const body = code.slice(checkIdx, checkIdx + 1200);
    expect(body).toMatch(/computeTrustedLegacySlipFileHash\(topup\.slipImageUrl as string, \{\s*timeoutMs: WALLET_APPROVAL_SLIP_HASH_TIMEOUT_MS/);
    expect(body).toMatch(/computeSlipFileHash\(topup\.slipImageUrl as string, \{\s*timeoutMs: WALLET_APPROVAL_SLIP_HASH_TIMEOUT_MS/);
    expect(body).toMatch(/stage=wallet_current_byte_hash/);
  });

  it("recovers current bytes BEFORE the final strong-identifier refusal and BEFORE claimSlip", () => {
    const fnIdx = code.indexOf("export async function approveWalletTopup(");
    const walletClaimNeedle = 'const claim = await atWalletApprovalStage("wallet_slip_claim"';
    const strongIdIdx = code.indexOf("if (!hasStrongIdentifier(identifiers)) {", fnIdx);
    const checkIdx = code.indexOf(
      "currentFileHash = isLegacyStorageUrl(topup.slipImageUrl as string)",
      fnIdx
    );
    const claimIdx = code.indexOf(walletClaimNeedle, fnIdx);
    expect(strongIdIdx).toBeGreaterThan(fnIdx);
    expect(checkIdx).toBeGreaterThan(fnIdx);
    expect(checkIdx).toBeLessThan(strongIdIdx);
    expect(strongIdIdx).toBeLessThan(claimIdx);
  });

  it("fails closed when the current hash is unavailable on normal approval", () => {
    const idx = code.indexOf("currentFileHash = isLegacyStorageUrl(topup.slipImageUrl as string)");
    const body = code.slice(idx, idx + 2200);
    expect(body).toMatch(/if \(!currentFileHash && !breakGlassRequested\) \{/);
    expect(body).toMatch(/"NO_STRONG_IDENTIFIER",/);
    expect(body).toMatch(/"SLIP_CURRENT_BYTES_UNAVAILABLE",/);
  });

  it("fails closed when a persisted fileHash disagrees with the current hash", () => {
    const idx = code.indexOf("currentFileHash = isLegacyStorageUrl(topup.slipImageUrl as string)");
    const body = code.slice(idx, idx + 2600);
    expect(body).toMatch(/if \(currentFileHash && persistedFileHash && currentFileHash !== persistedFileHash\) \{/);
    expect(body).toMatch(/"SLIP_INTEGRITY_MISMATCH_AT_APPROVAL",/);
  });

  it("binds the freshly confirmed hash into identifiers.fileHash before claimSlip runs", () => {
    const idx = code.indexOf("currentFileHash = isLegacyStorageUrl(topup.slipImageUrl as string)");
    const claimIdx = code.indexOf(
      'const claim = await atWalletApprovalStage("wallet_slip_claim"',
      idx
    );
    const body = code.slice(idx, claimIdx);
    expect(body).toMatch(/identifiers\.fileHash = currentFileHash;/);
  });

  it("known integrity codes are deterministically mapped as admin preconditions", () => {
    const walletServiceCode = readCode("server/services/walletService.ts");
    expect(walletServiceCode).toMatch(/WALLET_APPROVAL_PRECONDITION_CODES/);
    expect(walletServiceCode).toMatch(/"SLIP_CURRENT_BYTES_UNAVAILABLE"/);
    expect(walletServiceCode).toMatch(/"SLIP_INTEGRITY_MISMATCH_AT_APPROVAL"/);
    expect(walletServiceCode).toMatch(/const badRequest =/);
    expect(walletServiceCode).toMatch(/code === "LEGACY_BREAK_GLASS_REASON_REQUIRED"/);
    expect(walletServiceCode).toMatch(/code === "LEGACY_FILE_AXIS_RISK_REASON_REQUIRED"/);
    expect(walletServiceCode).toMatch(/code: badRequest \? "BAD_REQUEST" : "PRECONDITION_FAILED"/);
  });
});

describe("confirmed-distinct legacy-case resolution routes through the same current-byte gate, IPE-001-C09", () => {
  it("order: resolveLegacyCaseAmbiguity's approval call goes through approvePayment -> approvePaymentInTx", () => {
    const resolutionCode = readCode("server/services/legacyCaseResolutionService.ts");
    expect(resolutionCode).toMatch(/orderService\.approvePayment\(/);

    const orderCode = readCode("server/services/orderService.ts");
    const exportedIdx = orderCode.indexOf("export async function approvePayment(");
    expect(exportedIdx).toBeGreaterThan(-1);
    const body = orderCode.slice(exportedIdx, exportedIdx + 900);
    expect(body).toMatch(/return approvePaymentInTx\(/);
  });

  it("wallet: resolveLegacyCaseAmbiguity's approval call goes directly through db.approveWalletTopup - the same function with the new gate", () => {
    const resolutionCode = readCode("server/services/legacyCaseResolutionService.ts");
    expect(resolutionCode).toMatch(/db\.approveWalletTopup\(/);
  });

  it("neither resolution path can skip the current-byte gate via legacyCaseAmbiguityResolution - that option only waives the advisory alias check inside claimSlip, never this pre-claim gate", () => {
    const orderCode = readCode("server/services/orderService.ts");
    const gateIdx = orderCode.indexOf("if (payment.slipImageUrl) {");
    const claimIdx = orderCode.indexOf(
      'const claim = await atOrderPaymentApprovalStage("slip_claim"',
      gateIdx
    );
    const gateBody = orderCode.slice(gateIdx, claimIdx);
    expect(gateBody).not.toMatch(/legacyCaseAmbiguityResolution/);
  });
});
