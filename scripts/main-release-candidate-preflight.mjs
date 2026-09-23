import fs from "node:fs";
import process from "node:process";
import { execFileSync } from "node:child_process";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const CONFIRMATION = "CREATE_MAIN_RELEASE_CANDIDATE";

function fail(message) {
  throw new Error(message);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`Missing ${name}.`);
  return value;
}

function fullSha(name) {
  const value = required(name).toLowerCase();
  if (!SHA_PATTERN.test(value))
    fail(`${name} must be a full 40-character Git SHA.`);
  return value;
}

function git(args) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function isAncestor(older, newer) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", older, newer], {
      cwd: process.cwd(),
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const candidate = fullSha("PRODUCTION_CANDIDATE_SHA");
  const baseline = fullSha("PRODUCTION_BASELINE_SHA");
  if (required("PRODUCTION_RC_CONFIRMATION") !== CONFIRMATION) {
    fail(`PRODUCTION_RC_CONFIRMATION must exactly equal ${CONFIRMATION}.`);
  }

  const mainHead = git(["rev-parse", "origin/main"]).toLowerCase();
  if (candidate !== mainHead) {
    fail(
      `Candidate must equal origin/main HEAD at RC creation (current ${mainHead}).`
    );
  }
  if (!isAncestor(baseline, candidate)) {
    fail("Production baseline SHA is not an ancestor of the main candidate.");
  }

  const commitsAhead = Number(
    git(["rev-list", "--count", `${baseline}..${candidate}`])
  );
  const migrationFilesRaw = git([
    "diff",
    "--name-only",
    `${baseline}..${candidate}`,
    "--",
    "drizzle/*.sql",
  ]);
  const migrationFiles = migrationFilesRaw
    ? migrationFilesRaw.split(/\r?\n/).filter(Boolean)
    : [];

  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    candidateSha: candidate,
    mainHeadAtCreation: mainHead,
    productionBaselineSha: baseline,
    commitsAhead,
    migrationFiles,
  };

  const output =
    process.env.PRODUCTION_RC_MANIFEST?.trim() ||
    "main-release-candidate-manifest.json";
  fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n", {
    mode: 0o600,
  });

  console.log(`[main-rc] candidate=${candidate}`);
  console.log(`[main-rc] baseline=${baseline}`);
  console.log(`[main-rc] commitsAhead=${commitsAhead}`);
  console.log(`[main-rc] migrations=${migrationFiles.length}`);
  console.log(
    "[main-rc] PASS: exact main HEAD is bound as a Production release candidate."
  );
}

main().catch(error => {
  console.error(`[main-rc] FAIL: ${error?.message || String(error)}`);
  process.exitCode = 1;
});
