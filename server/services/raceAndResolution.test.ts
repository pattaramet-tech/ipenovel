import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getTableConfig } from "drizzle-orm/mysql-core";
import { paymentSlipReviewResolutions } from "../../drizzle/schema";

/**
 * Covers the remaining three findings:
 *
 *  - wallet auto-approval could commit a slip claim without creating the
 *    value that claim protects (zero-row conditional update returned instead
 *    of throwing)
 *  - a late-finishing recheck could overwrite finalized payment evidence
 *  - a legacy case ambiguity had no admin resolution path
 *
 * The first two are ordering/state properties inside a database transaction,
 * so they are asserted structurally: a behavioural test would need a live
 * MySQL transaction, which this sandbox does not have.
 */

function readCode(relativePath: string): string {
  return fs
    .readFileSync(path.resolve(process.cwd(), relativePath), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

// ─── Wallet: a claim must never outlive the value it protects ────────────

describe("wallet auto-approval cannot commit a claim without a credit", () => {
  const code = readCode("server/db.ts");

  it("a zero-row conditional status update THROWS instead of returning", () => {
    // Returning committed the already-inserted claim while creating no
    // approval and no wallet credit, permanently consuming that reference.
    expect(code).toMatch(/throw new WalletSlipClaimError\(\s*\n?\s*"TOPUP_STATE_RACE"/);
  });

  it("no longer returns the existing top-up after a failed conditional update", () => {
    expect(code).not.toMatch(
      /Already processed - return existing topup without crediting again/
    );
    // The specific return that leaked a committed claim is gone.
    const idx = code.indexOf('"TOPUP_STATE_RACE"');
    expect(idx).toBeGreaterThan(-1);
    const before = code.slice(Math.max(0, idx - 400), idx);
    expect(before).not.toMatch(/return existing\[0\];/);
  });

  it("the throw sits inside the same transaction as the claim, so it rolls back", () => {
    const txIdx = code.indexOf("return await db.transaction(async (tx) => {");
    const raceIdx = code.indexOf('"TOPUP_STATE_RACE"');
    expect(txIdx).toBeGreaterThan(-1);
    expect(raceIdx).toBeGreaterThan(txIdx);
  });

  it("explains the invariant it protects", () => {
    const raw = fs.readFileSync(path.resolve(process.cwd(), "server/db.ts"), "utf-8");
    expect(raw).toMatch(/CLAIM MUST NEVER COMMIT WITHOUT THE VALUE CREATION IT\s*\n?\s*\/\/\s*PROTECTS/);
  });

  it("the admin approval path already threw on zero rows and still does", () => {
    expect(code).toMatch(/Wallet top-up already processed by another request/);
  });

  it("an unresolved legacy ambiguity is not treated as a duplicate on either wallet path", () => {
    expect(code).toMatch(/"LEGACY_REFERENCE_CASE_AMBIGUITY"/);
    expect(code).toMatch(/"LEGACY_CASE_AMBIGUITY_REQUIRES_RESOLUTION"/);
  });
});

// ─── Recheck: never mutate finalized evidence ────────────────────────────

describe("recheck writes are conditional on the payment still being reviewable", () => {
  const recheck = readCode("server/services/ocrRecheckService.ts");
  const dbCode = readCode("server/db.ts");

  it("db exposes a compare-and-set helper scoped to non-finalized payments", () => {
    expect(dbCode).toMatch(/export async function updatePaymentIfNotFinalized/);
    expect(dbCode).toMatch(/eq\(payments\.status, "pending"\)/);
    expect(dbCode).toMatch(/eq\(payments\.status, "pending_review"\)/);
    expect(dbCode).toMatch(/affectedRows \|\| 0\) > 0/);
  });

  it("the helper cannot be used to move status or rewrite slipSubmittedAt", () => {
    const idx = dbCode.indexOf("export async function updatePaymentIfNotFinalized");
    const signature = dbCode.slice(idx, idx + 700);
    expect(signature).not.toMatch(/status\?:/);
    expect(signature).not.toMatch(/slipSubmittedAt/);
  });

  it("EVERY recheck payment write goes through the conditional helper", () => {
    // No unconditional db.updatePayment remains on this path.
    expect(recheck).not.toMatch(/db\.updatePayment\(/);
    expect(recheck).toMatch(/db\.updatePaymentIfNotFinalized\(/);
  });

  it("the pre-OCR fileHash write happens BEFORE the provider call", () => {
    const preIdx = recheck.indexOf("const preOcrFileHash");
    const providerIdx = recheck.indexOf("prepareSlipImageForOcr(payment.slipImageUrl)");
    expect(preIdx).toBeGreaterThan(-1);
    expect(providerIdx).toBeGreaterThan(preIdx);
  });

  it("losing the pre-OCR race stops before any provider call", () => {
    const preIdx = recheck.indexOf("const preOcrFileHash");
    const providerIdx = recheck.indexOf("prepareSlipImageForOcr(payment.slipImageUrl)");
    const block = recheck.slice(preIdx, providerIdx);
    expect(block).toMatch(/buildSupersededResult/);
  });

  it("losing the FINAL write race changes nothing and reports superseded", () => {
    expect(recheck).toMatch(/const wroteFinal = await db\.updatePaymentIfNotFinalized/);
    expect(recheck).toMatch(/if \(!wroteFinal\)/);
  });

  it("a lost race is classified as STATE, not a provider or OCR failure", () => {
    const idx = recheck.indexOf("async function buildSupersededResult");
    const block = recheck.slice(idx, idx + 1600);
    expect(block).toMatch(/reviewCategory: "STATE"/);
    expect(block).toMatch(/RECHECK_SUPERSEDED_BY_FINALIZATION/);
    expect(block).toMatch(/result: "needs_review"/);
    expect(block).not.toMatch(/result: "technical_failure"/);
  });

  it("the superseded result reports the CURRENT status, not the stale one", () => {
    const idx = recheck.indexOf("async function buildSupersededResult");
    const block = recheck.slice(idx, idx + 1600);
    expect(block).toMatch(/db\.getPaymentById\(originalPayment\.id\)/);
    expect(block).toMatch(/readyForAdminApproval: false/);
    expect(block).toMatch(/supersededByFinalization: true/);
  });

  it("the technical-failure path no longer writes a second time", () => {
    const idx = recheck.indexOf("const technicalPathFileHash = preOcrFileHash");
    expect(idx).toBeGreaterThan(-1);
    const block = recheck.slice(idx, idx + 900);
    expect(block).not.toMatch(/updatePayment/);
  });

  it("mergeFileHashInto preserves existing evidence", () => {
    expect(recheck).toMatch(/export function mergeFileHashInto/);
    const idx = recheck.indexOf("export function mergeFileHashInto");
    const block = recheck.slice(idx, idx + 700);
    expect(block).toMatch(/JSON\.parse\(existingJson\)/);
    expect(block).toMatch(/merged\.fileHash = fileHash/);
  });

  it("recheck still never claims, approves, rejects, or touches slipSubmittedAt", () => {
    expect(recheck).not.toMatch(/\bclaimSlip\s*\(/);
    expect(recheck).not.toMatch(/\bapprovePayment\s*\(/);
    expect(recheck).not.toMatch(/\brejectPayment\s*\(/);
    const writes = recheck.match(/updatePaymentIfNotFinalized\([\s\S]*?\}\)/g) ?? [];
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) {
      expect(w).not.toMatch(/slipSubmittedAt/);
      expect(w).not.toMatch(/\bstatus\b/);
    }
  });
});

// ─── Admin resolution path ───────────────────────────────────────────────

describe("legacy case ambiguity has an audited admin resolution", () => {
  const svc = readCode("server/services/legacyCaseResolutionService.ts");
  const routers = readCode("server/routers.ts");

  it("is exposed as an admin-only procedure", () => {
    const idx = routers.indexOf("resolveLegacyCaseAmbiguity:");
    expect(idx).toBeGreaterThan(-1);
    expect(routers.slice(idx, idx + 200)).toMatch(/adminProcedure/);
  });

  it("requires a substantive written reason", () => {
    expect(routers).toMatch(/reason: z\.string\(\)\.trim\(\)\.min\(10\)/);
    expect(svc).toMatch(/MIN_REASON_LENGTH/);
  });

  it("revalidates the ambiguity SERVER-SIDE rather than trusting the panel", () => {
    expect(svc).toMatch(/describeLegacyCaseAmbiguity/);
    expect(svc).toMatch(/No legacy case ambiguity is currently present/);
  });

  it("refuses on an already finalized payment", () => {
    expect(svc).toMatch(/already \$\{payment\.status\}/);
  });

  it("still requires a REAL strong identifier - it is not a NO_STRONG_IDENTIFIER override", () => {
    expect(svc).toMatch(/hasStrongIdentifier\(identifiers\)/);
    expect(svc).toMatch(/NO_STRONG_IDENTIFIER/);
  });

  it("confirmed_distinct approves through the NORMAL atomic claim", () => {
    expect(svc).toMatch(/orderService\.approvePayment\(/);
    expect(svc).toMatch(/legacyCaseAmbiguityResolved: true/);
  });

  it("confirmed_duplicate reuses the existing reject flow", () => {
    expect(svc).toMatch(/orderService\.rejectPayment\(/);
  });

  it("writes an audit row with the matched source and the reason", () => {
    expect(svc).toMatch(/paymentSlipReviewResolutions/);
    expect(svc).toMatch(/matchedSourceType/);
    expect(svc).toMatch(/legacyAliasHash/);
    expect(svc).toMatch(/reason: args\.reason/);
  });

  it("a duplicate resolution attempt is rejected, not silently double-recorded", () => {
    expect(svc).toMatch(/ER_DUP_ENTRY/);
    expect(svc).toMatch(/already been resolved by another admin/);
  });

  it("is never reachable from a public/user route", () => {
    expect(svc).not.toMatch(/publicProcedure|authenticatedProcedure/);
    const idx = routers.indexOf("resolveLegacyCaseAmbiguity:");
    expect(routers.slice(idx, idx + 200)).not.toMatch(/publicProcedure/);
  });
});

describe("resolution uniqueness is on the SUBJECT, never the lossy alias", () => {
  const { indexes, uniqueConstraints } = getTableConfig(paymentSlipReviewResolutions);
  const uniqueNames = [
    ...indexes.filter((i: any) => i.config.unique).map((i: any) => i.config.name),
    ...(uniqueConstraints ?? []).map((u: any) => u.name),
  ].map(String);

  it("one resolution per subject", () => {
    expect(uniqueNames.some((n) => n.includes("subject_unique"))).toBe(true);
  });

  it("the alias is NOT unique - many legitimate payments may share one", () => {
    // Constraining the alias would recreate the dead-end this design removes.
    expect(uniqueNames.some((n) => n.toLowerCase().includes("alias"))).toBe(false);
  });
});

describe("migration 0038 is additive only", () => {
  const sql = fs.readFileSync(
    path.resolve(process.cwd(), "drizzle/0038_add_legacy_alias_and_review_resolutions.sql"),
    "utf-8"
  );

  it("adds the advisory alias column and its non-unique index", () => {
    expect(sql).toMatch(/ADD `legacyReferenceUpperHash` varchar\(64\)/);
    expect(sql).toMatch(/CREATE INDEX `paymentSlipClaims_legacyReferenceUpperHash_idx`/);
  });

  it("creates the resolution audit table", () => {
    expect(sql).toMatch(/CREATE TABLE `paymentSlipReviewResolutions`/);
  });

  it("puts NO unique constraint on the lossy alias", () => {
    expect(sql).not.toMatch(/UNIQUE[^;]*legacyReferenceUpperHash/i);
  });

  it("contains no destructive statement", () => {
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
  });
});

// ─── Backfill alias semantics ────────────────────────────────────────────

describe("the backfill sets the alias ONLY for unrecoverable legacy rows", () => {
  const code = readCode("scripts/backfill-slip-claims.mjs");

  it("case-preserving evidence yields NO alias", () => {
    expect(code).toMatch(/legacyReferenceUpperHash: undefined,\s*\n\s*referenceEvidence: parsed\?\.referenceHash/);
  });

  it("a reparsed rawText recovers casing, so it yields NO alias", () => {
    expect(code).toMatch(/legacyReferenceUpperHash: undefined,\s*\n\s*referenceEvidence: "reparsed_raw_text"/);
  });

  it("only legacy_uppercase evidence receives one", () => {
    expect(code).toMatch(/isLegacyUppercaseOnly \? aliasIfUnrecoverable\(\) : undefined/);
    expect(code).toMatch(/referenceEvidence: isLegacyUppercaseOnly \? "legacy_uppercase"/);
  });

  it("alias groups are reported SEPARATELY from strong collisions", () => {
    expect(code).toMatch(/AMBIGUOUS_LEGACY_ALIAS_GROUP/);
    expect(code).toMatch(/legacyAliasGroups/);
  });

  it("an alias group does NOT block completion - it is not proof of a duplicate", () => {
    const cleanRunIdx = code.indexOf("const cleanRun =");
    const block = code.slice(cleanRunIdx, cleanRunIdx + 300);
    expect(block).not.toMatch(/ambiguousAliasGroups/);
    expect(block).not.toMatch(/legacyAliasGroups/);
  });

  it("every source row keeps its alias - none takes ownership", () => {
    const raw = fs.readFileSync(
      path.resolve(process.cwd(), "scripts/backfill-slip-claims.mjs"),
      "utf-8"
    );
    expect(raw).toMatch(/none takes ownership/i);
    expect(code).toMatch(/existing\.push\(/);
  });
});
