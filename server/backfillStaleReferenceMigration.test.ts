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
 *
 * IPE-004-C08 P2 extends that to EVERY claim row a source owns. The reviewed
 * head read one same-source row in unspecified order; because C04/C05
 * residual-axis rows and the C06 alias-only row mean a source can own
 * several, a non-stale row coming back first hid the stale one entirely and
 * the run was still allowed to --mark-complete.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  detectStaleReferenceClaims,
  buildStaleReferenceMigrationPatch,
  planStaleReferenceMigrations,
  evaluateStaleRepairOutcome,
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
const QR_HASH = "f".repeat(64);

/** The stale artifact: exact ownership of a value only the old lossy path could write. */
const staleRow = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  referenceHash: ALIAS,
  legacyReferenceUpperHash: null,
  fileHash: null,
  ...over,
});

/** A C04/C05 residual-axis row: partial, legitimate, NOT stale. */
const residualRow = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  referenceHash: null,
  legacyReferenceUpperHash: null,
  fileHash: OTHER_FILE_HASH,
  qrPayloadHash: QR_HASH,
  ...over,
});

/** A C06 alias-only row: asserts the advisory fold and nothing else. */
const aliasOnlyRow = (id: number) => ({
  id,
  referenceHash: null,
  legacyReferenceUpperHash: ALIAS,
  fileHash: null,
});

describe("detectStaleReferenceClaims", () => {
  it("6. matches a claim whose referenceHash equals today's derived lossy alias - the provenance proof", () => {
    const claim = staleRow(1);
    expect(detectStaleReferenceClaims([claim], ALIAS)).toEqual([claim]);
  });

  it("no expectedAlias -> nothing (this row is not legacy_uppercase evidence at all)", () => {
    expect(detectStaleReferenceClaims([staleRow(1)], undefined)).toEqual([]);
  });

  it("no existing claim for the source -> nothing to migrate", () => {
    expect(detectStaleReferenceClaims([], ALIAS)).toEqual([]);
    expect(detectStaleReferenceClaims(undefined, ALIAS)).toEqual([]);
  });

  it("7. a GENUINE exact reference claim (different hash) is never flagged as stale", () => {
    // A legitimate exact reference is case-preserving and hashes to a
    // DIFFERENT value than the upper-cased fold - this is the exact
    // discrimination that proves the claim is not this bug's artifact.
    expect(
      detectStaleReferenceClaims([staleRow(1, { referenceHash: GENUINE_EXACT_REF })], ALIAS)
    ).toEqual([]);
  });

  it("a claim already migrated (referenceHash cleared) is not flagged again - idempotent", () => {
    expect(detectStaleReferenceClaims([aliasOnlyRow(1)], ALIAS)).toEqual([]);
  });

  it("a claim whose referenceHash matches a DIFFERENT row's alias is not flagged", () => {
    expect(
      detectStaleReferenceClaims([staleRow(1, { referenceHash: OTHER_ALIAS })], ALIAS)
    ).toEqual([]);
  });

  it("E/F. a RESIDUAL row listed FIRST does not mask a stale claim listed after it (IPE-004-C08 P2)", () => {
    // The reviewed head read one same-source row with an unordered .limit(1).
    // Whichever row the database happened to return decided whether the
    // replay hole was found at all: this ordering answered "nothing stale".
    const residual = residualRow(1);
    const stale = staleRow(2);
    expect(detectStaleReferenceClaims([residual, stale], ALIAS)).toEqual([stale]);
  });

  it("F. an ALIAS-ONLY row listed first does not mask a stale claim either", () => {
    const stale = staleRow(9);
    expect(detectStaleReferenceClaims([aliasOnlyRow(4), stale], ALIAS)).toEqual([stale]);
  });

  it("G. reports EVERY stale row when a source somehow owns more than one", () => {
    // referenceHash is UNIQUE, so a healthy database holds at most one such
    // row - this is what keeps the repair honest where that index is absent.
    const first = staleRow(3);
    const second = staleRow(7);
    expect(detectStaleReferenceClaims([residualRow(1), first, aliasOnlyRow(5), second], ALIAS)).toEqual([
      first,
      second,
    ]);
  });

  it("tolerates a non-array or hole-containing read without throwing", () => {
    expect(detectStaleReferenceClaims(undefined as never, ALIAS)).toEqual([]);
    expect(detectStaleReferenceClaims({} as never, ALIAS)).toEqual([]);
    const stale = staleRow(2);
    expect(detectStaleReferenceClaims([null as never, stale], ALIAS)).toEqual([stale]);
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

describe("planStaleReferenceMigrations", () => {
  it("G. produces one in-place patch per stale row, in the order given", () => {
    const plans = planStaleReferenceMigrations([staleRow(3), staleRow(7)], {}, ALIAS);
    expect(plans.map((p: { claim: { id: number } }) => p.claim.id)).toEqual([3, 7]);
    for (const { patch } of plans) {
      expect(patch.referenceHash).toBeNull();
      expect(patch.legacyReferenceUpperHash).toBe(ALIAS);
    }
  });

  it("offers a freshly recovered fileHash to AT MOST ONE row - fileHash is UNIQUE", () => {
    // Writing the same recovered hash into two rows of the SAME source would
    // raise ER_DUP_ENTRY on the second, which the caller's duplicate-key
    // handler would then record as a file collision of this source with
    // itself - a fabricated finding that needlessly blocks the hash.
    const plans = planStaleReferenceMigrations(
      [staleRow(1), staleRow(2), staleRow(3)],
      { fileHash: FILE_HASH },
      ALIAS
    );
    expect(plans[0].patch.fileHash).toBe(FILE_HASH);
    expect(plans[1].patch).not.toHaveProperty("fileHash");
    expect(plans[2].patch).not.toHaveProperty("fileHash");
  });

  it("a row that ALREADY owns the recovered fileHash consumes it - no later row may rewrite it", () => {
    const plans = planStaleReferenceMigrations(
      [staleRow(1, { fileHash: FILE_HASH }), staleRow(2)],
      { fileHash: FILE_HASH },
      ALIAS
    );
    expect(plans[0].patch).not.toHaveProperty("fileHash");
    expect(plans[1].patch).not.toHaveProperty("fileHash");
  });

  it("a row holding a DIFFERENT fileHash does not consume the recovered one - the next empty slot takes it", () => {
    const plans = planStaleReferenceMigrations(
      [staleRow(1, { fileHash: OTHER_FILE_HASH }), staleRow(2)],
      { fileHash: FILE_HASH },
      ALIAS
    );
    expect(plans[0].patch).not.toHaveProperty("fileHash");
    expect(plans[1].patch.fileHash).toBe(FILE_HASH);
  });

  it("every patch still clears referenceHash when no fileHash was recovered at all", () => {
    const plans = planStaleReferenceMigrations([staleRow(1), staleRow(2)], {}, ALIAS);
    expect(plans.every((p: { patch: { referenceHash: unknown } }) => p.patch.referenceHash === null)).toBe(true);
    expect(plans.every((p: { patch: Record<string, unknown> }) => !("fileHash" in p.patch))).toBe(true);
  });

  it("nothing stale -> no plans (and tolerates an absent list)", () => {
    expect(planStaleReferenceMigrations([], { fileHash: FILE_HASH }, ALIAS)).toEqual([]);
    expect(planStaleReferenceMigrations(undefined as never, {}, ALIAS)).toEqual([]);
  });
});

describe("evaluateStaleRepairOutcome - the post-repair proof (IPE-004-C08 acceptance H)", () => {
  const READ_LIMIT = 10;
  const evaluate = (
    afterClaims: unknown[],
    failedClaimIds: number[] = [],
    readLimit = READ_LIMIT
  ) =>
    evaluateStaleRepairOutcome({
      afterClaims,
      expectedAlias: ALIAS,
      failedClaimIds: new Set(failedClaimIds),
      readLimit,
    });

  it("H. a re-read showing no obsolete referenceHash anywhere is clean", () => {
    const outcome = evaluate([residualRow(1), aliasOnlyRow(2)]);
    expect(outcome.uncovered).toBe(0);
    expect(outcome.error).toBeUndefined();
  });

  it("F/H. a residual row listed FIRST cannot make a still-stale sibling read as clean", () => {
    const outcome = evaluate([residualRow(1), staleRow(2)]);
    expect(outcome.uncovered).toBe(1);
    expect(outcome.error).toMatch(/still hold the obsolete lossy referenceHash/);
  });

  it("G/H. every still-stale row is counted, not just one", () => {
    const outcome = evaluate([residualRow(1), staleRow(2), aliasOnlyRow(3), staleRow(4)]);
    expect(outcome.uncovered).toBe(2);
  });

  it("H. a row the per-claim repair already counted uncovered is NOT counted twice", () => {
    // The repair failed on claim 2 and already bumped staleClaimsUncovered +
    // pushed a failure. Counting it again here would inflate the report while
    // saying nothing new - the gate is already blocked either way.
    const outcome = evaluate([staleRow(2)], [2]);
    expect(outcome.uncovered).toBe(0);
  });

  it("H. a row the repair reported OK but that is STILL stale on re-read is reported", () => {
    // Contradiction between "update verified" and "source re-read" - the
    // re-read wins, because it is the state a later run and the live approval
    // path will actually see.
    const outcome = evaluate([staleRow(2)], [99]);
    expect(outcome.uncovered).toBe(1);
  });

  it("H. a SATURATED read is unproven, never clean - even when every returned row looks fine", () => {
    const saturated = Array.from({ length: READ_LIMIT }, (_, i) => residualRow(i + 1));
    const outcome = evaluate(saturated);
    expect(outcome.uncovered).toBe(1);
    expect(outcome.error).toMatch(/stale ownership unproven/);
  });

  it("H. saturation is judged against the bound the caller actually read with", () => {
    const rows = [residualRow(1), residualRow(2), residualRow(3)];
    expect(evaluate(rows, [], 10).uncovered).toBe(0);
    expect(evaluate(rows, [], 3).uncovered).toBe(1);
  });

  it("rerun idempotency: an already-repaired source re-reads clean and stays clean", () => {
    // Second run: nothing is detected as stale in the first place, and if the
    // verification does run its answer is 0 - no churn, no new failure.
    const repaired = [
      { id: 1, referenceHash: null, legacyReferenceUpperHash: ALIAS, fileHash: FILE_HASH },
      residualRow(2),
    ];
    expect(detectStaleReferenceClaims(repaired, ALIAS)).toEqual([]);
    expect(evaluate(repaired).uncovered).toBe(0);
  });

  it("a missing or non-array re-read result is treated as an empty read, never as proof of extra rows", () => {
    expect(evaluate(undefined as never).uncovered).toBe(0);
    expect(
      evaluateStaleRepairOutcome({
        afterClaims: [staleRow(1)],
        expectedAlias: undefined,
        failedClaimIds: undefined,
        readLimit: READ_LIMIT,
      }).uncovered
    ).toBe(0);
  });
});

describe("the backfill script wires stale-claim migration in for legacy_uppercase rows", () => {
  const script = readCode("scripts/backfill-slip-claims.mjs");

  it("imports the pure detection, patch-planning and verification functions", () => {
    expect(script).toMatch(
      /import \{\s*detectStaleReferenceClaims,\s*planStaleReferenceMigrations,\s*evaluateStaleRepairOutcome,?\s*\} from "\.\/lib\/backfillStaleReferenceMigration\.mjs"/
    );
  });

  it("E. looks the claims up by SOURCE, never by the (now-stripped) hash value, and never with .limit(1)", () => {
    const start = script.indexOf("async function findAllSameSourceClaims(current) {");
    expect(start).toBeGreaterThan(-1);
    const body = script.slice(start, start + 600);
    expect(body).toMatch(/eq\(schema\.paymentSlipClaims\.sourceType, current\.sourceType\)/);
    expect(body).toMatch(/eq\(schema\.paymentSlipClaims\.sourceId, current\.sourceId\)/);
    expect(body).not.toMatch(/referenceHash/);
    expect(body).not.toMatch(/\.limit\(1\)/);
    // Deterministic: which rows come back, and in what order they are
    // repaired, must never be the database's choice.
    expect(body).toMatch(/\.orderBy\(asc\(schema\.paymentSlipClaims\.id\)\)/);
    expect(body).toMatch(/\.limit\(SAME_SOURCE_CLAIM_READ_LIMIT\)/);
  });

  it("E. the single-row same-source lookup is gone entirely", () => {
    expect(script).not.toMatch(/findSameSourceClaim\b/);
  });

  it("6/7/E. detection is gated on expectedAlias (legacy_uppercase only) and runs over ALL same-source rows", () => {
    const start = script.indexOf("let staleClaims = [];");
    expect(start).toBeGreaterThan(-1);
    const body = script.slice(start, start + 300);
    expect(body).toMatch(/if \(expectedAlias\) \{/);
    expect(body).toMatch(/const sameSource = await findAllSameSourceClaims\(current\)/);
    expect(body).toMatch(/staleClaims = detectStaleReferenceClaims\(sameSource, expectedAlias\)/);
  });

  it("a migrated claim is UPDATEd in place - never a second INSERT for the source", () => {
    const start = script.indexOf("async function migrateOneStaleReferenceClaim(");
    const end = script.indexOf("async function migrateStaleReferenceClaims(");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = script.slice(start, end);
    expect(body).toMatch(/\.update\(schema\.paymentSlipClaims\)/);
    expect(body).toMatch(/\.set\(patch\)/);
    expect(body).not.toMatch(/\.insert\(schema\.paymentSlipClaims\)/);
  });

  it("G. the orchestrator repairs EVERY planned row, not just the first", () => {
    const start = script.indexOf("async function migrateStaleReferenceClaims(");
    const end = script.indexOf("async function processRows(");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = script.slice(start, end);
    expect(body).toMatch(
      /for \(const \{ claim, patch \} of planStaleReferenceMigrations\(staleClaims, ids, expectedAlias\)\)/
    );
    expect(body).toMatch(/await migrateOneStaleReferenceClaim\(/);
  });

  it("H. after repairing, it RE-READS every same-source claim and fails closed if any is still stale", () => {
    const start = script.indexOf("async function migrateStaleReferenceClaims(");
    const end = script.indexOf("async function processRows(");
    const body = script.slice(start, end);
    expect(body).toMatch(/after = await findAllSameSourceClaims\(current\)/);
    expect(body).toMatch(/const outcome = evaluateStaleRepairOutcome\(\{/);
    expect(body).toMatch(/afterClaims: after,/);
    expect(body).toMatch(/stats\.staleClaimsUncovered \+= outcome\.uncovered/);
    expect(body).toMatch(/stage: "stale claim verification"/);
    // A failed re-read is not proof of anything either.
    expect(body).toMatch(/catch \(error\) \{/);
  });

  it("H. a row the per-claim repair already counted uncovered is not double-counted", () => {
    const start = script.indexOf("async function migrateStaleReferenceClaims(");
    const end = script.indexOf("async function processRows(");
    const body = script.slice(start, end);
    expect(body).toMatch(/const failedClaimIds = new Set\(\)/);
    expect(body).toMatch(/if \(!repaired\) failedClaimIds\.add\(claim\.id\)/);
    // ...and they are handed to the pure evaluator, which is what excludes
    // them (behaviour covered directly in "evaluateStaleRepairOutcome").
    expect(body).toMatch(/failedClaimIds,/);
  });

  it("H. the read bound the verification is judged against is the one the read actually used", () => {
    const start = script.indexOf("async function migrateStaleReferenceClaims(");
    const end = script.indexOf("async function processRows(");
    const body = script.slice(start, end);
    expect(body).toMatch(/readLimit: SAME_SOURCE_CLAIM_READ_LIMIT,/);
  });

  it("the dry run proves nothing about a post-state it never wrote", () => {
    const start = script.indexOf("async function migrateStaleReferenceClaims(");
    const end = script.indexOf("async function processRows(");
    const body = script.slice(start, end);
    expect(body).toMatch(/if \(!isLive\) return;/);
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
    // shared `if (staleClaims.length > 0)` migrate below rather than
    // `continue`, so its known identifiers still get claimed.
    const calls = body.match(/await migrateStaleReferenceClaims\(/g);
    expect(calls?.length).toBe(3);
    // Every call site passes `current`, so the post-repair proof re-reads the
    // same source it just repaired.
    const withCurrent = body.match(
      /await migrateStaleReferenceClaims\(staleClaims, ids, expectedAlias, sourceType, row\.id, current\)/g
    );
    expect(withCurrent?.length).toBe(3);
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
    const start = script.indexOf("async function migrateOneStaleReferenceClaim(");
    const end = script.indexOf("async function migrateStaleReferenceClaims(");
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
    const start = script.indexOf("async function migrateOneStaleReferenceClaim(");
    const end = script.indexOf("async function migrateStaleReferenceClaims(");
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

  it("the per-claim worker reports success, so the orchestrator can tell a counted failure from a new one", () => {
    const start = script.indexOf("async function migrateOneStaleReferenceClaim(");
    const end = script.indexOf("async function migrateStaleReferenceClaims(");
    const body = script.slice(start, end);
    expect(body).toMatch(/return true;/);
    expect(body).toMatch(/return false;/);
  });
});
