import process from "node:process";
import { execFileSync } from "node:child_process";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const RC_CONTEXT = "production-staging/main-bound-rc";
const STAGING_ENVIRONMENT = "production-staging";
const STAGING_HOST = "production-staging.ipenovel.com";

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

async function fetchJson(url, token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ipenovel-production-staging-preflight",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers["X-GitHub-Api-Version"] = "2022-11-28";
  }
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {}
  if (!response.ok) {
    fail(`Request failed HTTP ${response.status}: ${new URL(url).pathname}`);
  }
  return body;
}

function assertStagingUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.hostname !== STAGING_HOST) {
    fail(`PRODUCTION_STAGING_URL must be https://${STAGING_HOST}.`);
  }
}

async function main() {
  const candidate = fullSha("PRODUCTION_CANDIDATE_SHA");
  const baseline = fullSha("PRODUCTION_BASELINE_SHA");
  const environment = required("PRODUCTION_STAGING_ENVIRONMENT");
  const sourceBranch = required("PRODUCTION_STAGING_SOURCE_BRANCH");
  const repository =
    process.env.GITHUB_REPOSITORY?.trim() || "pattaramet-tech/ipenovel";
  const apiBase =
    process.env.GITHUB_API_URL?.trim() || "https://api.github.com";
  const token = process.env.GITHUB_TOKEN?.trim() || "";
  const stagingUrl =
    process.env.PRODUCTION_STAGING_URL?.trim() || `https://${STAGING_HOST}`;

  assertStagingUrl(stagingUrl);

  if (environment !== STAGING_ENVIRONMENT) {
    fail(`Staging dispatch environment must equal ${STAGING_ENVIRONMENT}.`);
  }
  if (sourceBranch !== "main") {
    fail("Production staging must be sourced from main.");
  }

  const mainHead = git(["rev-parse", "origin/main"]).toLowerCase();
  if (!isAncestor(candidate, mainHead)) {
    fail("Candidate is no longer contained in origin/main history.");
  }
  if (!isAncestor(baseline, candidate)) {
    fail("Staging baseline is not an ancestor of the candidate.");
  }

  const statuses = await fetchJson(
    `${apiBase}/repos/${repository}/commits/${candidate}/statuses?per_page=100`,
    token
  );
  const rc = statuses.find(item => item?.context === RC_CONTEXT);
  if (!rc || rc.state !== "success") {
    fail("Candidate does not have production-staging/main-bound-rc=success.");
  }

  const baselineContext = `production-staging/rc-baseline/${baseline}`;
  const baselineStatus = statuses.find(
    item => item?.context === baselineContext
  );
  if (!baselineStatus || baselineStatus.state !== "success") {
    fail(
      "Candidate is not bound to the supplied Production baseline by the RC workflow."
    );
  }

  const ready = await fetchJson(new URL("/readyz", stagingUrl), "");
  if (
    ready?.status !== "ready" ||
    String(ready?.revision || "").toLowerCase() !== candidate ||
    ready?.environment !== STAGING_ENVIRONMENT
  ) {
    fail(
      "Production staging /readyz does not report the exact candidate and production-staging environment."
    );
  }

  console.log(`[production-staging-preflight] candidate=${candidate}`);
  console.log(`[production-staging-preflight] baseline=${baseline}`);
  console.log(`[production-staging-preflight] mainHead=${mainHead}`);
  console.log(
    "[production-staging-preflight] PASS: exact main-bound candidate is live on isolated Production staging."
  );
}

main().catch(error => {
  console.error(
    `[production-staging-preflight] FAIL: ${error?.message || String(error)}`
  );
  process.exitCode = 1;
});
