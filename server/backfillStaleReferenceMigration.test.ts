/**
 * IPE-001-C02 P2: "Remove stale lossy exact claims during backfill reruns".
 *
 * scripts/lib/backfillStaleReferenceMigration.mjs detects and repairs a claim
 * an OLDER backfill version wrote before this codebase stopped treating
 * lossy legacy-uppercase evidence as EXACT referenceHash ownership. Without
 * this, a rerun of the (now fixed) derivation strips that value from `ids`,
 * making the stale claim invisible to the hash-based registry lookup - so
 * the wrong exact ownership survives forever AND a rerun that recovers a
 * fileHash inserts a SECOND claim for the same source.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  detectStaleReferenceClaim,
  buildStaleReferenceMigrationPatch,
} from "../scripts/lib/backfillStaleReferenceMigration.mjs";

function readCode(relativePath: string): string {
  return fs
    .readFileSync(path.resolve(process.cwd(), relativePath), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const ALIAS = "a".repeat(64);
const OTHER_ALIAS = "b".repeat(64);
const GENUINE_EXACT_REF = "c".repeat(64);
const FILE_HASH = "d".repeat(64);
const OTHER_FILE_HASH = "e".repeat(64);

describe("detectStaleReferenceClaim", () => {
  it("6. matches a claim whose referenceHash equals today's derived lossy alias - the provenance proof", () => {
    const claim = { id: 1, referenceHash: ALIAS, legacyReferenceUpperHash: null, fileHash: null };
    expect(detectStaleReferenceClaim(claim, ALIAS)).toBe(claim);
  });

  it("no expectedAlias -> undefined (this row is not legacy_uppercase evidence at all)", () => {
    const claim = { id: 1, referenceHash: ALIAS, legacyReferenceUpperHash: null, fileHash: null };
    expect(detectStaleReferenceClaim(claim, undefined)).toBeUndefined();
  });

  it("no existing claim for the source -> undefined, nothing to migrate", () => {
    expect(detectStaleReferenceClaim(undefined, ALIAS)).toBeUndefined();
  });

  it("7. a GENUINE exact reference claim (different hash) is never flagged as stale", () => {
    // A legitimate exact reference is case-preserving and hashes to a
    // DIFFERENT value than the upper-cased fold - this is the exact
    // discrimination that proves the claim is not this bug's artifact.
    const claim = {
      id: 1,
      referenceHash: GENUINE_EXACT_REF,
      legacyReferenceUpperHash: null,
      fileHash: null,
    };
    expect(detectStaleReferenceClaim(claim, ALIAS)).toBeUndefined();
  });

  it("a claim already migrated (referenceHash cleared) is not flagged again - idempotent", () => {
    const claim = { id: 1, referenceHash: null, legacyReferenceUpperHash: ALIAS, fileHash: FILE_HASH };
    expect(detectStaleReferenceClaim(claim, ALIAS)).toBeUndefined();
  });

  it("a claim whose referenceHash matches a DIFFERENT row's alias is not flagged", () => {
    const claim = { id: 1, referenceHash: OTHER_ALIAS, legacyReferenceUpperHash: null, fileHash: null };
    expect(detectStaleReferenceClaim(claim, ALIAS)).toBeUndefined();
  });
});

describe("buildStaleReferenceMigrationPatch", () => {
  it("always clears the obsolete exact referenceHash", () => {
    const claim = { legacyReferenceUpperHash: null, fileHash: null };
    const patch = buildStaleReferenceMigrationPatch(claim, {}, ALIAS);
    expect(patch.referenceHash).toBeNull();
  });

  it("6. sets the alias when it was never recorded", () => {
    const claim = { legacyReferenceUpperHash: null, fileHash: null };
    const patch = buildStaleReferenceMigrationPatch(claim, {}, ALIAS);
    expect(patch.legacyReferenceUpperHash).toBe(ALIAS);
  });

  it("does not rewrite the alias when it already holds the exact same value", () => {
    const claim = { legacyReferenceUpperHash: ALIAS, fileHash: null };
    const patch = buildStaleReferenceMigrationPatch(claim, {}, ALIAS);
    expect(patch).not.toHaveProperty("legacyReferenceUpperHash");
  });

  it("I. adds a freshly recovered fileHash into an empty slot", () => {
    const claim = { legacyReferenceUpperHash: ALIAS, fileHash: null };
    const patch = buildStaleReferenceMigrationPatch(claim, { fileHash: FILE_HASH }, ALIAS);
    expect(patch.fileHash).toBe(FILE_HASH);
  });

  it("J. no recovered fileHash this run -> the patch never claims one", () => {
    const claim = { legacyReferenceUpperHash: ALIAS, fileHash: null };
    const patch = buildStaleReferenceMigrationPatch(claim, {}, ALIAS);
    expect(patch).not.toHaveProperty("fileHash");
  });

  it("NEVER overwrites an existing fileHash already on the claim, even with a different recovered one", () => {
    // Defense in depth: this scenario should not arise given the provenance
    // check (the stale artifact never had a fileHash), but the repair must
    // never silently discard an existing, possibly distinct, verified value.
    const claim = { legacyReferenceUpperHash: ALIAS, fileHash: OTHER_FILE_HASH };
    const patch = buildStaleReferenceMigrationPatch(claim, { fileHash: FILE_HASH }, ALIAS);
    expect(patch).not.toHaveProperty("fileHash");
  });
});

describe("the backfill script wires stale-claim migration in for legacy_uppercase rows", () => {
  const script = readCode("scripts/backfill-slip-claims.mjs");

  it("imports the pure detection and patch-building functions", () => {
    expect(script).toMatch(
      /import \{\s*detectStaleReferenceClaim,\s*buildStaleReferenceMigrationPatch,?\s*\} from "\.\/lib\/backfillStaleReferenceMigration\.mjs"/
    );
  });

  it("looks the claim up by SOURCE, never by the (now-stripped) hash value", () => {
    const start = script.indexOf("async function findSameSourceClaim(current) {");
    expect(start).toBeGreaterThan(-1);
    const body = script.slice(start, start + 500);
    expect(body).toMatch(/eq\(schema\.paymentSlipClaims\.sourceType, current\.sourceType\)/);
    expect(body).toMatch(/eq\(schema\.paymentSlipClaims\.sourceId, current\.sourceId\)/);
    expect(body).not.toMatch(/referenceHash/);
  });

  it("6/7. detection is gated on expectedAlias (legacy_uppercase only) and delegates to the pure provenance check", () => {
    const start = script.indexOf("let staleClaim;");
    expect(start).toBeGreaterThan(-1);
    const body = script.slice(start, start + 300);
    expect(body).toMatch(/if \(expectedAlias\) \{/);
    expect(body).toMatch(/staleClaim = detectStaleReferenceClaim\(sameSource, expectedAlias\)/);
  });

  it("a migrated claim is UPDATEd in place - never a second INSERT for the source", () => {
    const start = script.indexOf("async function migrateStaleReferenceClaim(");
    const end = script.indexOf("async function processRows(");
    expect(start).toBeGreaterThan(-1);
    const body = script.slice(start, end);
    expect(body).toMatch(/\.update\(schema\.paymentSlipClaims\)/);
    expect(body).toMatch(/\.set\(patch\)/);
    expect(body).not.toMatch(/\.insert\(schema\.paymentSlipClaims\)/);
  });

  it("every fileHash-recovery outcome routes through the stale-claim migration before continuing", () => {
    const start = script.indexOf("if (recovery.fileHash) {");
    const end = script.indexOf("let registry;");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = script.slice(start, end);
    // Three call sites: recovery succeeded, no-identifier-at-all unresolved,
    // and ids.fileHash already present (or a reference/QR-only row falling
    // through) before the registry path. The has-a-reference/QR-but-no-fileHash
    // branch no longer migrates inline - IPE-004 makes it fall through to the
    // shared `if (staleClaim)` migrate below rather than `continue`, so its
    // known identifiers still get claimed.
    const calls = body.match(/await migrateStaleReferenceClaim\(/g);
    expect(calls?.length).toBe(3);
  });

  it("H/I/J. stale-claim coverage gates --mark-complete, same as alias/fileHash coverage", () => {
    // The completion rule now lives in scripts/lib/backfillCompletionGate.mjs
    // (extracted as a pure function so every combination can be unit tested
    // directly - see server/backfillCompletionGate.test.ts). The script
    // forwards its stale-claim counter into that gate and takes cleanRun
    // straight from the result; the gate is where staleClaimsUncovered must
    // still both block completion and be named in the refusal reasons.
    expect(script).toMatch(
      /import \{ evaluateBackfillCompletion \} from "\.\/lib\/backfillCompletionGate\.mjs"/
    );
    const callStart = script.indexOf("evaluateBackfillCompletion(");
    expect(callStart).toBeGreaterThan(-1);
    const callBody = script.slice(callStart, callStart + 400);
    expect(callBody).toMatch(/staleClaimsUncovered: stats\.staleClaimsUncovered/);
    expect(script).toMatch(/const cleanRun = gate\.cleanRun;/);

    const gate = readCode("scripts/lib/backfillCompletionGate.mjs");
    expect(gate).toMatch(
      /const staleClaimsCoverageComplete = stats\.staleClaimsUncovered === 0;/
    );
    const gateCleanRunStart = gate.indexOf("const cleanRun =");
    const gateCleanRunBody = gate.slice(gateCleanRunStart, gateCleanRunStart + 500);
    expect(gateCleanRunBody).toMatch(/staleClaimsCoverageComplete/);
    expect(gate).toMatch(/staleClaimsUncovered=\$\{stats\.staleClaimsUncovered\}/);
  });

  it("a duplicate-key error during migration is reported as a genuine collision, never swallowed", () => {
    const start = script.indexOf("async function migrateStaleReferenceClaim(");
    const end = script.indexOf("async function processRows(");
    const body = script.slice(start, end);
    expect(body).toMatch(/ER_DUP_ENTRY/);
    expect(body).toMatch(/tracker\.collisions\.push/);
  });

  it("IPE-004 P2: a duplicate-key on the fileHash half still clears the obsolete referenceHash, or blocks completion", () => {
    // The reviewed head recorded the file collision and moved on, leaving the
    // wrong lossy exact `referenceHash` in place while the gate still passed.
    // The fix: on ER_DUP_ENTRY, retry with a fileHash-free patch that clears
    // referenceHash + ensures the alias, re-read to confirm, and only then
    // count it repaired - otherwise staleClaimsUncovered/failure is bumped so
    // --mark-complete is refused.
    const start = script.indexOf("async function migrateStaleReferenceClaim(");
    const end = script.indexOf("async function processRows(");
    const body = script.slice(start, end);
    const dupIdx = body.indexOf("if (isDuplicate) {");
    expect(dupIdx).toBeGreaterThan(-1);
    const dupBody = body.slice(dupIdx);
    // retries with a patch that has no fileHash
    expect(dupBody).toMatch(/const safePatch = \{ referenceHash: null \};/);
    expect(dupBody).toMatch(/\.set\(safePatch\)/);
    // re-reads and only counts repaired when the obsolete referenceHash is gone
    expect(dupBody).toMatch(/persisted\.referenceHash === null/);
    expect(dupBody).toMatch(/stats\.staleClaimsRepaired \+= 1/);
    // otherwise it fails closed
    expect(dupBody).toMatch(/stats\.staleClaimsUncovered \+= 1/);
    expect(dupBody).toMatch(/obsolete referenceHash not cleared after duplicate-key retry/);
  });
});
