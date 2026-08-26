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
      /import \{ recoverFileHashIdentifier \} from "\.\/lib\/backfillFileHashRecovery\.mjs"/
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
    // Two distinct unresolved branches - no identifier at all, and another
    // identifier present but fileHash still unrecoverable - both count.
    expect(body.match(/stats\.noIdentifier \+= 1/g)?.length).toBe(2);
    expect(body).toMatch(/else if \(!identifiers\.hasStrongIdentifier\(ids\)\) \{/);
  });

  it("a reference/QR identifier does not excuse missing fileHash coverage - still unresolved", () => {
    // readCode() strips comments, so this checks the executable branch shape
    // directly: recovery failure with ANOTHER identifier present takes the
    // `else` arm (not the `hasStrongIdentifier` arm) and still lands on the
    // same unresolved bookkeeping - see the previous test for the count.
    const start = script.indexOf("if (!ids.fileHash) {");
    const body = script.slice(start, start + 2000);
    const elseIdx = body.indexOf("} else {", body.indexOf("else if (!identifiers.hasStrongIdentifier(ids)) {"));
    expect(elseIdx).toBeGreaterThan(-1);
    const elseBody = body.slice(elseIdx, elseIdx + 300);
    expect(elseBody).toMatch(/stats\.noIdentifier \+= 1/);
    expect(elseBody).toMatch(/stats\.unresolvedRows\.push/);
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

  it("H. cleanRun requires zero unresolved rows", () => {
    const start = script.indexOf("const cleanRun =");
    const body = script.slice(start, start + 400);
    expect(body).toMatch(/stats\.noIdentifier === 0/);
  });

  it("the refusal message names the unresolved count", () => {
    expect(script).toMatch(/noIdentifier=\$\{stats\.noIdentifier\}/);
  });

  it("unresolved rows never leak a slip URL, only source + reason code", () => {
    const start = script.indexOf("if (stats.unresolvedRows.length > 0) {");
    expect(start).toBeGreaterThan(-1);
    const body = script.slice(start, start + 700);
    expect(body).not.toMatch(/slipImageUrl/);
    expect(body).toMatch(/u\.source/);
    expect(body).toMatch(/u\.reason/);
  });

  it("a non-zero unresolved count sets a non-zero exit code even without --mark-complete", () => {
    const start = script.lastIndexOf("if (\n    tracker.collisions.length > 0");
    expect(start).toBeGreaterThan(-1);
    const body = script.slice(start, start + 300);
    expect(body).toMatch(/stats\.noIdentifier > 0/);
  });
});
