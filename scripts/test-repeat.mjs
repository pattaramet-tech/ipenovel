#!/usr/bin/env node
// Determinism check: runs the full test suite N times (default 3) and
// verifies every run produces IDENTICAL total/passed/failed/skipped counts
// AND an identical set of failing test names. See PART G/L of
// docs/TEST_INFRASTRUCTURE.md ("รัน suite 3 รอบต่อเนื่อง...ผลเหมือนกัน").
//
// Usage: node scripts/test-repeat.mjs [runs] [-- <extra vitest args>]
//   node scripts/test-repeat.mjs 3
//   node scripts/test-repeat.mjs 5 -- -c vitest.integration.config.ts

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const rawArgs = process.argv.slice(2);
const dashIndex = rawArgs.indexOf("--");
const runsArg = dashIndex === -1 ? rawArgs[0] : rawArgs.slice(0, dashIndex)[0];
const extraArgs = dashIndex === -1 ? [] : rawArgs.slice(dashIndex + 1);
const runs = Number.parseInt(runsArg, 10) || 3;

function relFile(absName) {
  const norm = absName.replace(/\\/g, "/");
  const idx = norm.indexOf("/server/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

function summarize(run) {
  const failing = [];
  for (const tr of run.testResults) {
    const file = relFile(tr.name);
    for (const ar of tr.assertionResults) {
      if (ar.status === "failed") failing.push(`${file}::${ar.fullName}`);
    }
  }
  failing.sort();
  return {
    total: run.numTotalTests,
    passed: run.numPassedTests,
    failed: run.numFailedTests,
    pending: run.numPendingTests,
    files: run.testResults.length,
    failingKeys: failing,
  };
}

console.log(`[test:repeat] Running the suite ${runs} times to check for determinism...`);

const summaries = [];
for (let i = 1; i <= runs; i++) {
  const outFile = path.join(os.tmpdir(), `test-repeat-run-${i}-${Date.now()}.json`);
  console.log(`\n[test:repeat] === Run ${i}/${runs} ===`);
  const result = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["vitest", "run", "--reporter=json", `--outputFile=${outFile}`, ...extraArgs],
    { cwd: repoRoot, stdio: "inherit", env: process.env, shell: process.platform === "win32" }
  );

  if (result.error) {
    console.error(`[test:repeat] FAIL: run ${i} failed to spawn: ${result.error.message}`);
    process.exit(1);
  }
  if (!fs.existsSync(outFile)) {
    console.error(`[test:repeat] FAIL: run ${i} produced no JSON report (crash?). vitest exit code: ${result.status}`);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(outFile, "utf8"));
  } finally {
    fs.rmSync(outFile, { force: true });
  }
  summaries.push(summarize(parsed));
}

console.log("\n========================================");
console.log("[test:repeat] SUMMARY ACROSS RUNS");
console.log("========================================");
for (let i = 0; i < summaries.length; i++) {
  const s = summaries[i];
  console.log(`Run ${i + 1}: total=${s.total} passed=${s.passed} failed=${s.failed} pending=${s.pending} files=${s.files}`);
}

const first = summaries[0];
const mismatches = [];
for (let i = 1; i < summaries.length; i++) {
  const s = summaries[i];
  if (s.total !== first.total || s.passed !== first.passed || s.failed !== first.failed || s.pending !== first.pending || s.files !== first.files) {
    mismatches.push(`Run ${i + 1} counts differ from run 1 (total/passed/failed/pending/files).`);
  }
  if (JSON.stringify(s.failingKeys) !== JSON.stringify(first.failingKeys)) {
    const onlyInFirst = first.failingKeys.filter((k) => !s.failingKeys.includes(k));
    const onlyInThis = s.failingKeys.filter((k) => !first.failingKeys.includes(k));
    mismatches.push(
      `Run ${i + 1} has a different set of failing tests than run 1. ` +
        `Only in run 1: [${onlyInFirst.join(", ")}]. Only in run ${i + 1}: [${onlyInThis.join(", ")}].`
    );
  }
}

if (mismatches.length > 0) {
  console.error("\n[test:repeat] FAIL: the suite is NOT deterministic across repeated runs:");
  for (const m of mismatches) console.error(`  - ${m}`);
  process.exit(1);
}

console.log(`\n[test:repeat] PASS: identical results across all ${runs} runs (deterministic).`);
process.exit(0);
