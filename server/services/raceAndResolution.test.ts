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
    // Scoped to the WRITABLE `fields` parameter only - not the whole
    // signature, which also carries an optional `expectedSlipVersion` guard.
    // That guard legitimately mentions slipSubmittedAt (it compares against
    // it in the WHERE clause), but must never appear in what gets written.
    const idx = dbCode.indexOf("export async function updatePaymentIfNotFinalized");
    const fieldsIdx = dbCode.indexOf("fields: {", idx);
    const fieldsEndIdx = dbCode.indexOf("},", fieldsIdx);
    expect(fieldsIdx).toBeGreaterThan(-1);
    expect(fieldsEndIdx).toBeGreaterThan(fieldsIdx);
    const fieldsBlock = dbCode.slice(fieldsIdx, fieldsEndIdx);
    expect(fieldsBlock).not.toMatch(/status\?:/);
    expect(fieldsBlock).not.toMatch(/slipSubmittedAt/);

    // The slip-version guard exists but is read-only comparison state - it
    // narrows the WHERE clause, and is never passed to `.set()`.
    const signature = dbCode.slice(idx, fieldsEndIdx + 500);
    expect(signature).toMatch(/expectedSlipVersion\?:/);
    const setIdx = dbCode.indexOf(".set(fields as any)", fieldsEndIdx);
    expect(setIdx).toBeGreaterThan(-1);
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
    const endIdx = recheck.indexOf("\n}", idx);
    const block = recheck.slice(idx, endIdx);
    expect(block).toMatch(/db\.getPaymentById\(originalPayment\.id\)/);
    expect(block).toMatch(/readyForAdminApproval: false/);
    // Dynamic, not a fixed literal: a lost CAS is either an admin
    // finalization or a slip replacement, distinguished by comparing the
    // reloaded row's slip identity against the one this recheck was bound
    // to (IPE-001 P1-C) - so supersededByFinalization must be computed, not
    // hardcoded true.
    expect(block).toMatch(/supersededByFinalization: !slipReplaced/);
    expect(block).toMatch(/RECHECK_SUPERSEDED_BY_SLIP_REPLACEMENT/);
    expect(block).toMatch(/sameSlipVersion\(slipVersionAtStart, \{/);
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

  it("refuses on an already finalized subject", () => {
    expect(svc).toMatch(/already \$\{subject\.status\}/);
    expect(svc).toMatch(/function isReviewable/);
  });

  it("is subject-agnostic - order AND wallet both have an adapter", () => {
    // Building an order-only resolver while the wallet path still raised
    // LEGACY_CASE_AMBIGUITY_REQUIRES_RESOLUTION pointed admins at a route
    // that did not exist.
    expect(svc).toMatch(/subjectType: LegacyCaseSubjectType/);
    expect(svc).toMatch(/function adapterFor/);
    expect(svc).toMatch(/db\.approveWalletTopup\(/);
    expect(svc).toMatch(/db\.rejectWalletTopup\(/);
    expect(svc).toMatch(/orderService\.approvePayment\(/);
    expect(svc).toMatch(/orderService\.rejectPayment\(/);
  });

  it("the generic layer hard-codes no subject specifics", () => {
    const genericStart = svc.indexOf("export async function resolveLegacyCaseAmbiguity");
    const generic = svc.slice(genericStart);
    expect(generic).not.toMatch(/getPaymentById/);
    expect(generic).not.toMatch(/orderService\./);
    expect(generic).not.toMatch(/approveWalletTopup/);
  });

  it("the successful audit is written INSIDE the approval transaction", () => {
    // Writing it beforehand permanently consumed the subject-unique slot when
    // approval then failed, leaving the subject stuck with no retry.
    expect(svc).toMatch(/auditResolution: async \(tx: any\) =>/);
    expect(svc).toMatch(/insertResolution\(tx, \{/);
  });

  it("still requires a REAL strong identifier - it is not a NO_STRONG_IDENTIFIER override", () => {
    expect(svc).toMatch(/hasStrongIdentifier\(identifiers\)/);
    expect(svc).toMatch(/NO_STRONG_IDENTIFIER/);
  });

  it("confirmed_distinct approves through the NORMAL atomic claim", () => {
    expect(svc).toMatch(/orderService\.approvePayment\(/);
    // The waiver is bound to the adjudicated evidence, not a bare boolean.
    expect(svc).toMatch(/legacyCaseAmbiguityResolution: \{/);
    expect(svc).toMatch(/expectedMatchedSourceId: adjudicated\.matchedSourceId/);
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
  // Identifier derivation now lives in its own pure, testable module (IPE-001:
  // "legacy uppercase must not become exact ownership") - see
  // server/backfillIdentifierDerivation.test.ts for full behavioural coverage.
  const derivation = readCode("scripts/lib/backfillIdentifierDerivation.mjs");

  it("case-preserving evidence yields NO alias", () => {
    expect(derivation).toMatch(
      /legacyReferenceUpperHash: undefined,\s*\n\s*referenceEvidence: parsed\?\.referenceHash/
    );
  });

  it("a reparsed rawText recovers casing, so it yields NO alias", () => {
    expect(derivation).toMatch(/legacyReferenceUpperHash: undefined,\s*\n\s*referenceEvidence: "reparsed_raw_text"/);
  });

  it("only legacy_uppercase evidence receives one, and referenceHash is stripped alongside it", () => {
    const start = derivation.indexOf("if (isLegacyUppercaseOnly) {");
    expect(start).toBeGreaterThan(-1);
    const block = derivation.slice(start, start + 500);
    expect(block).toMatch(/referenceHash: undefined/);
    expect(block).toMatch(/legacyReferenceUpperHash: aliasIfUnrecoverable\(\)/);
    expect(block).toMatch(/referenceEvidence: "legacy_uppercase"/);
  });

  it("the main script delegates to the pure module rather than deriving inline", () => {
    expect(code).toMatch(
      /import \{ deriveIdentifiers as deriveIdentifiersPure \} from "\.\/lib\/backfillIdentifierDerivation\.mjs"/
    );
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


// ─── Wallet resolution parity ────────────────────────────────────────────

describe("wallet has the SAME audited resolution path as orders", () => {
  const routers = readCode("server/routers.ts");
  const svc = readCode("server/services/legacyCaseResolutionService.ts");
  const dbCode = readCode("server/db.ts");
  const ui = readCode("client/src/pages/AdminWalletTopupDetailPage.tsx");

  it("exposes an admin-only wallet resolution endpoint", () => {
    const idx = routers.indexOf("resolveLegacyCaseAmbiguity:");
    const walletIdx = routers.indexOf("resolveLegacyCaseAmbiguity:", idx + 1);
    expect(walletIdx).toBeGreaterThan(-1);
    expect(routers.slice(walletIdx, walletIdx + 200)).toMatch(/adminProcedure/);
  });

  it("the wallet endpoint requires a substantive reason", () => {
    const walletIdx = routers.indexOf('subjectType: "wallet_topup"');
    expect(walletIdx).toBeGreaterThan(-1);
    const block = routers.slice(Math.max(0, walletIdx - 700), walletIdx);
    expect(block).toMatch(/reason: z\.string\(\)\.trim\(\)\.min\(10\)/);
  });

  it("both subject types route through the same generic resolver", () => {
    expect(routers).toMatch(/subjectType: "order_payment"/);
    expect(routers).toMatch(/subjectType: "wallet_topup"/);
  });

  it("wallet approval accepts the resolution flag and an in-transaction audit", () => {
    expect(dbCode).toMatch(/legacyCaseAmbiguityResolution\?: \{/);
    expect(dbCode).toMatch(/expectedMatchedSourceType: "order_payment" \| "wallet_topup";/);
    expect(dbCode).toMatch(/auditResolution\?: \(tx: any\) => Promise<void>;/);
    expect(dbCode).toMatch(/await options\.auditResolution\(tx\)/);
  });

  it("the wallet audit hook runs INSIDE the crediting transaction", () => {
    const txIdx = dbCode.indexOf("return await db.transaction(async (tx) => {");
    const auditIdx = dbCode.indexOf("await options.auditResolution(tx)");
    expect(auditIdx).toBeGreaterThan(txIdx);
    // And after the wallet credit, so a failed credit rolls the audit back.
    const creditIdx = dbCode.indexOf("Step 5: Create wallet transaction record");
    expect(auditIdx).toBeGreaterThan(creditIdx);
  });

  it("the wallet resolver cannot bypass real anti-replay", () => {
    // Only the advisory alias is skipped, and only the adjudicated one; the
    // exact atomic claim still runs.
    expect(svc).toMatch(/legacyCaseAmbiguityResolution: \{/);
    expect(svc).toMatch(/hasStrongIdentifier\(identifiers\)/);
    expect(svc).toMatch(/NO_STRONG_IDENTIFIER/);
  });

  it("the wallet admin page offers both explicit choices", () => {
    expect(ui).toMatch(/Legacy Reference Case Ambiguity/);
    expect(ui).toMatch(/Reject as Duplicate/);
    expect(ui).toMatch(/Approve as Distinct Transaction/);
    expect(ui).toMatch(/not proof of a duplicate/i);
  });

  it("the wallet page requires a reason before either action", () => {
    expect(ui).toMatch(/legacyReason\.trim\(\)\.length < 10/);
  });
});

// ─── Resolution audit commits with finalization ──────────────────────────

describe("a failed resolution never consumes the subject slot", () => {
  const svc = readCode("server/services/legacyCaseResolutionService.ts");
  const orderCode = readCode("server/services/orderService.ts");

  it("the successful audit is passed as a callback, not written up front", () => {
    expect(svc).toMatch(/auditResolution: async \(tx: any\) =>/);
    // The standalone pre-approval insert is gone from the distinct path.
    const distinctIdx = svc.indexOf("confirmed_distinct still requires");
    const block = svc.slice(distinctIdx, distinctIdx + 1800);
    expect(block).not.toMatch(/await insertResolution\(await requireDb\(\)/);
  });

  it("order approval invokes the audit inside its transaction, after finalization", () => {
    const finalizeIdx = orderCode.indexOf("finalizeOrderCompletion(order.id");
    const auditIdx = orderCode.indexOf("await options.auditResolution(tx)");
    expect(auditIdx).toBeGreaterThan(finalizeIdx);
  });

  it("the duplicate-key path reports CONFLICT rather than double-recording", () => {
    expect(svc).toMatch(/ER_DUP_ENTRY/);
    expect(svc).toMatch(/already been resolved by another admin/);
  });

  it("rollback frees the slot - the insert is inside the same transaction", () => {
    expect(svc).toMatch(/insertResolution\(tx, \{/);
  });
});

// ─── OCR-disabled file identifier recovery ───────────────────────────────

describe("recheck repairs a legacy row even when OCR is disabled", () => {
  const code = readCode("server/services/ocrRecheckService.ts");

  it("recovers the file hash BEFORE the OCR-enabled guard", () => {
    const hashIdx = code.indexOf("const preOcrFileHash");
    const guardIdx = code.indexOf("if (!config.enabled)");
    expect(hashIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(hashIdx);
  });

  it("persists it conditionally, so a finalized payment is never mutated", () => {
    // Two separate assertions rather than one multiline regex: the write goes
    // through the CAS helper, and it merges rather than replaces.
    expect(code).toMatch(/updatePaymentIfNotFinalized\(payment\.id, \{/);
    expect(code).toMatch(/extractedData: mergeFileHashInto\(/);
  });

  it("stops before any provider call when that write loses the race", () => {
    const hashIdx = code.indexOf("const preOcrFileHash");
    const providerIdx = code.indexOf("prepareSlipImageForOcr(payment.slipImageUrl)");
    expect(code.slice(hashIdx, providerIdx)).toMatch(/buildSupersededResult/);
  });

  it("never calls the provider when OCR is disabled", () => {
    const guardIdx = code.indexOf("if (!config.enabled)");
    const providerIdx = code.indexOf("prepareSlipImageForOcr(payment.slipImageUrl)");
    // The guard returns before the provider call is reached.
    expect(providerIdx).toBeGreaterThan(guardIdx);
    const guardBlock = code.slice(guardIdx, providerIdx);
    expect(guardBlock).toMatch(/return \{/);
  });

  it("reports the recovered identifier accurately, never fabricated", () => {
    const guardIdx = code.indexOf("if (!config.enabled)");
    const block = code.slice(guardIdx, guardIdx + 1400);
    expect(block).toMatch(/hasStrongIdentifier: Boolean\(preOcrFileHash\)/);
    expect(block).toMatch(/describeFileIdentifierStatus\(\{ fileHash: preOcrFileHash \}\)/);
    expect(block).not.toMatch(/fileIdentifierStatus: "UNAVAILABLE"/);
  });

  it("the OCR-disabled result still never approves, rejects or claims", () => {
    const guardIdx = code.indexOf("if (!config.enabled)");
    const block = code.slice(guardIdx, guardIdx + 1400);
    expect(block).toMatch(/verificationPassed: false/);
    expect(block).toMatch(/readyForAdminApproval: false/);
  });
});
