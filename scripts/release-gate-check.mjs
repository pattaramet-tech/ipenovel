#!/usr/bin/env node
// Release gate: compares the current `vitest run` result against
// docs/test-baseline-snapshot.json (the known, pre-existing failing tests,
// documented in docs/TEST_BASELINE.md) and fails ONLY when a failure exists
// that is NOT in that baseline - i.e. a real regression.
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

let baseline;
try {
  baseline = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
} catch (error) {
  fail(`Could not parse ${snapshotPath}: ${error.message}`);
}

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
} finally {
  fs.rmSync(tmpOutputFile, { force: true });
}

function relFile(absName) {
  const norm = absName.replace(/\\/g, "/");
  const idx = norm.indexOf("/server/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

const currentFailing = [];
for (const tr of run.testResults) {
  const file = relFile(tr.name);
  for (const ar of tr.assertionResults) {
    if (ar.status === "failed") {
      currentFailing.push({ file, name: ar.fullName });
    }
  }
}
const currentKeys = new Set(currentFailing.map((t) => `${t.file}::${t.name}`));

const newFailures = currentFailing.filter((t) => !baselineKeys.has(`${t.file}::${t.name}`));
const fixedSinceBaseline = baseline.filter((t) => !currentKeys.has(`${t.file}::${t.name}`));

console.log("\n========================================");
console.log("[release-gate] SUMMARY");
console.log("========================================");
console.log(`Total tests this run   : ${run.numTotalTests}`);
console.log(`Passed                 : ${run.numPassedTests}`);
console.log(`Failed (raw)           : ${run.numFailedTests}  <- pnpm test will still exit non-zero for this, correctly`);
console.log(`Known baseline failures: ${baseline.length} (see docs/TEST_BASELINE.md)`);
console.log(`New failures (not in baseline): ${newFailures.length}`);
console.log(`Fixed since baseline snapshot : ${fixedSinceBaseline.length}`);

if (fixedSinceBaseline.length > 0) {
  console.log(
    "\n[release-gate] NOTE: some previously-known failures are no longer failing. " +
      "Consider updating docs/test-baseline-snapshot.json to shrink the known-debt list:"
  );
  for (const t of fixedSinceBaseline.slice(0, 20)) console.log(`  - [${t.file}] ${t.name}`);
  if (fixedSinceBaseline.length > 20) console.log(`  ... and ${fixedSinceBaseline.length - 20} more`);
}

if (newFailures.length > 0) {
  console.log("\n[release-gate] NEW FAILURES NOT PRESENT IN THE BASELINE:");
  for (const t of newFailures) console.log(`  - [${t.file}] ${t.name}`);
  fail(
    `${newFailures.length} failure(s) not present in the recorded baseline. ` +
      "This indicates a real regression - fix it before pushing/deploying. Do not update the " +
      "baseline snapshot to silence this without first confirming the failure is a genuine, " +
      "understood pre-existing/environment issue."
  );
}

console.log(
  `\n[release-gate] PASS: no failures beyond the ${baseline.length} known, pre-existing baseline failures. ` +
    "This does NOT mean the test suite is green - see docs/TEST_BASELINE.md for the outstanding test debt."
);
process.exit(0);
