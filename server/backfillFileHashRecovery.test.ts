/**
 * IPE-001 P1-A: "Backfill approved rows that have no extraction data".
 *
 * scripts/lib/backfillFileHashRecovery.mjs is the pure decision helper the
 * backfill script calls when an approved historical row's extractedData
 * carried no strong identifier (including the NULL case). It attempts to
 * recover the exact-file identifier server-side from the row's own stored
 * slip bytes via the injected computeSlipFileHash, and never trusts
 * anything else.
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  recoverFileHashIdentifier,
  UNRESOLVED_NO_SLIP_URL,
  UNRESOLVED_HASH_RECOVERY_FAILED,
} from "../scripts/lib/backfillFileHashRecovery.mjs";

function readCode(relativePath: string): string {
  return fs
    .readFileSync(path.resolve(process.cwd(), relativePath), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const HASH = "f".repeat(64);

describe("recoverFileHashIdentifier", () => {
  it("A. no slipImageUrl at all -> unresolved, computeSlipFileHash never called", async () => {
    const computeSlipFileHash = vi.fn();
    const result = await recoverFileHashIdentifier({
      slipImageUrl: undefined,
      computeSlipFileHash,
    });
    expect(result.fileHash).toBeUndefined();
    expect(result.unresolvedReason).toBe(UNRESOLVED_NO_SLIP_URL);
    expect(computeSlipFileHash).not.toHaveBeenCalled();
  });

  it("null slipImageUrl is treated the same as undefined", async () => {
    const computeSlipFileHash = vi.fn();
    const result = await recoverFileHashIdentifier({
      slipImageUrl: null,
      computeSlipFileHash,
    });
    expect(result.unresolvedReason).toBe(UNRESOLVED_NO_SLIP_URL);
    expect(computeSlipFileHash).not.toHaveBeenCalled();
  });

  it("B. slipImageUrl present, bytes recoverable -> fileHash returned", async () => {
    const computeSlipFileHash = vi.fn().mockResolvedValue(HASH);
    const result = await recoverFileHashIdentifier({
      slipImageUrl: "r2p:payment-slips/abc",
      computeSlipFileHash,
    });
    expect(result.fileHash).toBe(HASH);
    expect(result.unresolvedReason).toBeUndefined();
    expect(computeSlipFileHash).toHaveBeenCalledWith("r2p:payment-slips/abc");
  });

  it("D. slipImageUrl present, hash recovery fails (undefined) -> unresolved, fails closed", async () => {
    const computeSlipFileHash = vi.fn().mockResolvedValue(undefined);
    const result = await recoverFileHashIdentifier({
      slipImageUrl: "r2p:payment-slips/abc",
      computeSlipFileHash,
    });
    expect(result.fileHash).toBeUndefined();
    expect(result.unresolvedReason).toBe(UNRESOLVED_HASH_RECOVERY_FAILED);
  });

  it("an empty-string slipImageUrl is treated as absent, not passed through", async () => {
    const computeSlipFileHash = vi.fn();
    const result = await recoverFileHashIdentifier({
      slipImageUrl: "",
      computeSlipFileHash,
    });
    expect(result.unresolvedReason).toBe(UNRESOLVED_NO_SLIP_URL);
    expect(computeSlipFileHash).not.toHaveBeenCalled();
  });
});

describe("the backfill script wires recovery in for every row with no strong identifier", () => {
  const script = readCode("scripts/backfill-slip-claims.mjs");

  it("imports recoverFileHashIdentifier and the real slipFileHashService primitive", () => {
    expect(script).toMatch(
      /import \{[\s\S]*?recoverFileHashIdentifier[\s\S]*?\} from "\.\/lib\/backfillFileHashRecovery\.mjs"/
    );
    expect(script).toMatch(
      /fileHashService = await import\("\.\.\/server\/services\/slipFileHashService\.ts"\)/
    );
  });

  it("E/F. recovery is attempted before a row is ever counted unresolved", () => {
    // IPE-001-C01: recovery is no longer gated on "no strong identifier at
    // all" - a pre-existing reference/QR must not excuse missing exact
    // fileHash coverage, so recovery is attempted whenever fileHash itself is
    // absent, regardless of what else the row carries.
    const start = script.indexOf("if (!ids.fileHash) {");
    expect(start).toBeGreaterThan(-1);
    const body = script.slice(start, start + 2000);
    expect(body).toMatch(/const recovery = await recoverFileHashIdentifier\(/);
    expect(body).toMatch(/slipImageUrl: row\.slipImageUrl/);
    expect(body).toMatch(/computeSlipFileHash: fileHashService\.computeSlipFileHash/);
    expect(body).toMatch(/stats\.fileHashRecovered \+= 1/);
    // IPE-004 fix: only ONE branch increments noIdentifier now - the row that
    // has no strong identifier at all AND no recoverable fileHash. A row that
    // DOES carry a reference/QR is not identifier-less: it records only the
    // file axis as unknown and falls through to claim its known identifiers.
    expect(body.match(/stats\.noIdentifier \+= 1/g)?.length).toBe(1);
    expect(body).toMatch(/else if \(!identifiers\.hasStrongIdentifier\(ids\)\) \{/);
  });

  it("a reference/QR identifier is still claimed when fileHash is unrecoverable - only the file axis is recorded unknown", () => {
    // IPE-004 review finding P1: dropping a known reference/QR here was a
    // replay hole - after completion a same-reference / same-QR replay could
    // create value again. readCode() strips comments, so this checks the
    // executable branch shape directly: the `else` arm (recovery failed with
    // ANOTHER identifier present) records the file axis unknown, pushes an
    // unresolvedRows entry tagged fileAxisOnly, does NOT increment
    // noIdentifier, and does NOT `continue` - it falls through so the normal
    // claim path below still records the reference/QR.
    const start = script.indexOf("if (!ids.fileHash) {");
    const body = script.slice(start, start + 2000);
    const elseIdx = body.indexOf("} else {", body.indexOf("else if (!identifiers.hasStrongIdentifier(ids)) {"));
    expect(elseIdx).toBeGreaterThan(-1);
    // Scope to just the else block body - up to the line that closes it.
    const elseEnd = body.indexOf("\n      }", elseIdx);
    expect(elseEnd).toBeGreaterThan(elseIdx);
    const elseBody = body.slice(elseIdx, elseEnd);
    expect(elseBody).toMatch(/stats\.unresolvedRows\.push/);
    expect(elseBody).toMatch(/fileAxisOnly: true/);
    expect(elseBody).toMatch(/await recordUnknownRow\(sourceType, row\.id, recovery\.unresolvedReason\)/);
    expect(elseBody).not.toMatch(/stats\.noIdentifier \+= 1/);
    // Crucially: no `continue` - the row falls through to the claim path so
    // its known reference/QR identifiers ARE recorded.
    expect(elseBody).not.toMatch(/\bcontinue;/);
  });

  it("G. the scan predicate no longer requires extractedData IS NOT NULL", () => {
    expect(script).not.toMatch(/isNotNull\(extractedCol\)/);
    expect(script).not.toMatch(/isNotNull,/);
    const start = script.indexOf("async function scanAll(");
    const body = script.slice(start, start + 900);
    expect(body).toMatch(/eq\(statusCol, "approved"\), gt\(idCol, cursor\)/);
  });

  it("slipImageUrl is selected for both order-payment and wallet-topup scans", () => {
    expect(script).toMatch(/orderId: schema\.payments\.orderId, slipImageUrl: schema\.payments\.slipImageUrl/);
    expect(script).toMatch(
      /userId: schema\.walletTopups\.userId, slipImageUrl: schema\.walletTopups\.slipImageUrl/
    );
  });

  // IPE-004 production incident: a real dry-run backfill found 915 approved
  // historical rows (out of 4,147) that can NEVER be resolved
  // (no_slip_image_url - the bytes are permanently gone). Requiring
  // `stats.noIdentifier === 0` before completion meant --mark-complete could
  // NEVER succeed for this exact, real corpus, so the O(N) legacy scan
  // stayed enabled forever and blocked unrelated new approvals. The fix:
  // completion instead requires every unresolved row to be durably
  // CLASSIFIED (written to paymentSlipLegacyUnknown) - see
  // scripts/lib/backfillCompletionGate.mjs and backfillCompletionGate.test.ts.
  it("H. cleanRun no longer requires zero unresolved rows - it requires every one durably classified", () => {
    const start = script.indexOf("const gate = evaluateBackfillCompletion(");
    expect(start).toBeGreaterThan(-1);
    const body = script.slice(start, start + 400);
    // Every unresolved row's durable-write outcome feeds the gate...
    expect(body).toMatch(/unknownRowsFailed: stats\.unknownRowsFailed/);
    // ...and the OLD all-or-nothing rule is gone from THIS script entirely.
    expect(script).not.toMatch(/stats\.noIdentifier === 0/);
  });

  it("every unresolved row is durably recorded as unknown, inline, as soon as it is scanned", () => {
    const start = script.indexOf("if (!ids.fileHash) {");
    const body = script.slice(start, start + 2500);
    expect(body.match(/await recordUnknownRow\(sourceType, row\.id, recovery\.unresolvedReason\)/g)?.length).toBe(2);
  });

  it("unresolved rows never leak a slip URL, only source + reason code", () => {
    const start = script.indexOf("if (stats.unresolvedRows.length > 0) {");
    expect(start).toBeGreaterThan(-1);
    // Widened in IPE-004-C05 (the console message grew to describe the
    // narrower, accurate post-completion sufficiency rule instead of
    // claiming the table is never consulted).
    const body = script.slice(start, start + 1200);
    expect(body).not.toMatch(/slipImageUrl/);
    expect(body).toMatch(/u\.source/);
    expect(body).toMatch(/u\.reason/);
  });

  it("a FAILED durable write for an unresolved row still sets a non-zero exit code", () => {
    const start = script.indexOf("const hasGenuineProblem =");
    expect(start).toBeGreaterThan(-1);
    const body = script.slice(start, start + 300);
    expect(body).toMatch(/stats\.unknownRowsFailed > 0/);
  });

  it("unresolved rows alone (successfully classified) no longer force a live run's exit code non-zero", () => {
    // The OLD unconditional rule - collisions/unresolved rows ALWAYS force
    // exit 1 - is gone. It is now conditioned on NOT being a live run
    // (dryRunHasFindings), or on a genuine failure (hasGenuineProblem).
    const start = script.indexOf("const dryRunHasFindings =");
    expect(start).toBeGreaterThan(-1);
    const body = script.slice(start, start + 200);
    expect(body).toMatch(/!isLive/);
  });
});
