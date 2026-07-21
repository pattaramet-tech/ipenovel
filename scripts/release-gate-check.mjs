#!/usr/bin/env node
// Release gate: compares the current `vitest run` result against
// docs/test-baseline-snapshot.json (the known, pre-existing failing tests,
// documented in docs/TEST_BASELINE.md) and fails when:
//   1. A failure exists that is NOT in the baseline (a real regression), OR
//   2. The test process crashed / produced no result, OR
//   3. A test file failed to collect at all (config/import error), OR
//   4. Total test count or file count dropped below the recorded floor
//      (tests silently disappeared), OR
//   5. A test that was previously recorded as FAILING is now SKIPPED
//      instead of PASSING or FAILING (converting a failure into a skip to
//      dodge this gate, explicitly forbidden).
//
// This deliberately does NOT make the test suite look green. It is a
// separate, additive check (`pnpm test:gate`) on top of `pnpm test`, which
// keeps reporting its own real exit code and its own real failure count.
// Never wrap this script's exit code with `|| true` and never treat a
// "gate: PASS" message as "the test suite passed" - read the printed
// summary, which always states the known-failure count explicitly.
//
// Usage: node scripts/release-gate-check.mjs [-- <extra vitest args>]

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const snapshotPath = path.join(repoRoot, "docs", "test-baseline-snapshot.json");
const tmpOutputFile = path.join(os.tmpdir(), `release-gate-vitest-${Date.now()}.json`);

function fail(message) {
  console.error(`\n[release-gate] FAIL: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(snapshotPath)) {
  fail(`Baseline snapshot not found at ${snapshotPath}. Cannot evaluate the gate without it.`);
}

let snapshot;
try {
  const raw = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  // Backward-compatible with the older bare-array format (no meta block).
  snapshot = Array.isArray(raw) ? { meta: {}, failures: raw } : raw;
} catch (error) {
  fail(`Could not parse ${snapshotPath}: ${error.message}`);
}

const baseline = snapshot.failures;
const meta = snapshot.meta || {};
const baselineKeys = new Set(baseline.map((t) => `${t.file}::${t.name}`));

console.log("[release-gate] Running the test suite (this may take a while)...");
const extraArgs = process.argv.slice(2).filter((a) => a !== "--");
const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["vitest", "run", "--reporter=json", `--outputFile=${tmpOutputFile}`, ...extraArgs],
  { cwd: repoRoot, stdio: "inherit", env: process.env, shell: process.platform === "win32" }
);

if (result.error) {
  fail(`Failed to spawn vitest: ${result.error.message}`);
}

if (result.signal) {
  fail(`vitest was terminated by signal ${result.signal} (process crash, not a normal test failure).`);
}

if (!fs.existsSync(tmpOutputFile)) {
  fail(
    "vitest did not produce a JSON report - it likely crashed before running any tests " +
      "(config error, collection failure, etc). Treating this as a gate failure, not a pass, " +
      `since no result can be evaluated. (vitest exit code: ${result.status})`
  );
}

let run;
try {
  run = JSON.parse(fs.readFileSync(tmpOutputFile, "utf8"));
} catch (error) {
  fail(`vitest's JSON report was not valid JSON (truncated output from a crash?): ${error.message}`);
} finally {
  fs.rmSync(tmpOutputFile, { force: true });
}

function relFile(absName) {
  const norm = absName.replace(/\\/g, "/");
  const idx = norm.indexOf("/server/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

// --- Collection errors: a file that failed with zero assertions never ran
// a single test - vitest counts it as "failed" at the suite level but it
// won't show up in numFailedTests' per-test breakdown the same way a real
// assertion failure does, so this needs its own explicit check.
const collectionErrors = [];
for (const tr of run.testResults) {
  if (tr.status === "failed" && (!tr.assertionResults || tr.assertionResults.length === 0)) {
    collectionErrors.push({ file: relFile(tr.name), message: (tr.message || "").split("\n")[0] });
  }
}

const currentByKey = new Map();
for (const tr of run.testResults) {
  const file = relFile(tr.name);
  for (const ar of tr.assertionResults) {
    currentByKey.set(`${file}::${ar.fullName}`, { file, name: ar.fullName, status: ar.status });
  }
}

const currentFailing = [...currentByKey.values()].filter((t) => t.status === "failed");
const currentKeys = new Set(currentByKey.keys());

const newFailures = currentFailing.filter((t) => !baselineKeys.has(`${t.file}::${t.name}`));
const fixedSinceBaseline = baseline.filter((t) => {
  const current = currentByKey.get(`${t.file}::${t.name}`);
  return current && current.status !== "failed";
});

// --- Anti-gaming check: a baseline-known FAILURE that is now SKIPPED
// (rather than passed or still-failed) is exactly the "convert failed to
// skipped to dodge the gate" pattern this task explicitly forbids.
const failuresTurnedSkipped = baseline.filter((t) => {
  const current = currentByKey.get(`${t.file}::${t.name}`);
  return current && (current.status === "skipped" || current.status === "pending" || current.status === "todo");
});

// --- Test count guards: catch tests silently disappearing (a file that
// used to be collected no longer is, or a test was deleted without
// updating the baseline/meta deliberately).
const countGuardFailures = [];
if (typeof meta.minimumExpectedTotalTests === "number" && run.numTotalTests < meta.minimumExpectedTotalTests) {
  countGuardFailures.push(
    `Total test count dropped: ${run.numTotalTests} < recorded floor ${meta.minimumExpectedTotalTests}. ` +
      "Tests may have been silently deleted, or a file failed to collect."
  );
}
if (typeof meta.minimumExpectedFileCount === "number" && run.testResults.length < meta.minimumExpectedFileCount) {
  countGuardFailures.push(
    `Test file count dropped: ${run.testResults.length} < recorded floor ${meta.minimumExpectedFileCount}. ` +
      "A test file may have been deleted or excluded."
  );
}

console.log("\n========================================");
console.log("[release-gate] SUMMARY");
console.log("========================================");
console.log(`Total tests this run   : ${run.numTotalTests}${meta.minimumExpectedTotalTests ? ` (floor: ${meta.minimumExpectedTotalTests})` : ""}`);
console.log(`Test files this run    : ${run.testResults.length}${meta.minimumExpectedFileCount ? ` (floor: ${meta.minimumExpectedFileCount})` : ""}`);
console.log(`Passed                 : ${run.numPassedTests}`);
console.log(`Failed (raw)           : ${run.numFailedTests}  <- pnpm test will still exit non-zero for this, correctly`);
console.log(`Skipped/pending        : ${run.numPendingTests} (informational only - not gated, varies a lot by environment/DB availability)`);
console.log(`Known baseline failures: ${baseline.length} (see docs/TEST_BASELINE.md)`);
console.log(`New failures (not in baseline): ${newFailures.length}`);
console.log(`Fixed since baseline snapshot : ${fixedSinceBaseline.length}`);
console.log(`Collection errors (file failed to even run): ${collectionErrors.length}`);
console.log(`Baseline failures now suspiciously skipped (not fixed, not failing): ${failuresTurnedSkipped.length}`);

if (fixedSinceBaseline.length > 0) {
  console.log(
    "\n[release-gate] NOTE: some previously-known failures are no longer failing. " +
      "Consider updating docs/test-baseline-snapshot.json to shrink the known-debt list " +
      "ONLY once this has been verified deterministic (see docs/TEST_BASELINE.md):"
  );
  for (const t of fixedSinceBaseline.slice(0, 20)) console.log(`  - [${t.file}] ${t.name}`);
  if (fixedSinceBaseline.length > 20) console.log(`  ... and ${fixedSinceBaseline.length - 20} more`);
}

const gateFailureReasons = [];

if (collectionErrors.length > 0) {
  console.log("\n[release-gate] COLLECTION ERRORS (file(s) failed to run at all):");
  for (const c of collectionErrors) console.log(`  - [${c.file}] ${c.message}`);
  gateFailureReasons.push(`${collectionErrors.length} test file(s) failed to collect/run at all.`);
}

if (failuresTurnedSkipped.length > 0) {
  console.log("\n[release-gate] SUSPICIOUS: previously-failing tests are now skipped (not fixed, not failing):");
  for (const t of failuresTurnedSkipped) console.log(`  - [${t.file}] ${t.name}`);
  gateFailureReasons.push(
    `${failuresTurnedSkipped.length} known-failing test(s) are now skipped instead of passing or failing - ` +
      "this looks like a failure was converted to a skip to dodge the gate, which is explicitly forbidden."
  );
}

if (countGuardFailures.length > 0) {
  console.log("\n[release-gate] TEST COUNT GUARD FAILURES:");
  for (const r of countGuardFailures) console.log(`  - ${r}`);
  gateFailureReasons.push(...countGuardFailures);
}

if (newFailures.length > 0) {
  console.log("\n[release-gate] NEW FAILURES NOT PRESENT IN THE BASELINE:");
  for (const t of newFailures) console.log(`  - [${t.file}] ${t.name}`);
  gateFailureReasons.push(`${newFailures.length} failure(s) not present in the recorded baseline.`);
}

if (gateFailureReasons.length > 0) {
  fail(
    gateFailureReasons.join(" ") +
      " Fix the underlying issue before pushing/deploying. Do not update the baseline snapshot to " +
      "silence this without first confirming each item is a genuine, understood pre-existing/" +
      "environment issue - never to hide a real regression."
  );
}

console.log(
  `\n[release-gate] PASS: no failures beyond the ${baseline.length} known, pre-existing baseline failures, ` +
    "no collection errors, no silently-vanished tests, no failure-to-skip conversions. This does NOT mean " +
    "the test suite is green - see docs/TEST_BASELINE.md for the outstanding test debt."
);
process.exit(0);
