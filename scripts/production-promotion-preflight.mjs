import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const MAIN_BOUND_CONTEXT = "production-staging/main-bound-rc";
const STAGING_STATUS_CONTEXT = "production-staging/release-candidate";
const STAGING_ENVIRONMENT = "production-staging";
const STAGING_HOST = "production-staging.ipenovel.com";
const PRODUCTION_HOST = "ipenovel.com";
const DEFAULT_LEGACY_PROD_BRANCH = "fix/ipe045-account-recovery-survivor-donor";
const CONFIRMATION = "AUTHORIZE_PRODUCTION_PROMOTION";

function fail(message) {
  throw new Error(message);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`Missing ${name}.`);
  return value;
}

function truthy(value) {
  return /^(1|true|yes)$/i.test(String(value ?? "").trim());
}

function fullSha(name) {
  const value = required(name).toLowerCase();
  if (!SHA_PATTERN.test(value)) {
    fail(`${name} must be a full 40-character Git SHA.`);
  }
  return value;
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function gitExists(sha) {
  try {
    git(["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
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

function remoteBranchHead(branch) {
  const ref = `refs/remotes/origin/${branch}`;
  try {
    return git(["rev-parse", "--verify", ref]).toLowerCase();
  } catch {
    fail(`Missing fetched remote branch origin/${branch}.`);
  }
}

async function fetchJson(url, token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ipenovel-production-promotion-preflight",
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

function assertHost(urlString, expectedHost, name) {
  const url = new URL(urlString);
  if (url.protocol !== "https:" || url.hostname !== expectedHost) {
    fail(`${name} must be https://${expectedHost}.`);
  }
  return url;
}

function extractRunId(targetUrl, repository, label) {
  if (!targetUrl) fail(`${label} status has no workflow target URL.`);
  const url = new URL(targetUrl);
  const expectedPathPrefix = `/${repository}/actions/runs/`;
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    !url.pathname.startsWith(expectedPathPrefix)
  ) {
    fail(
      `${label} status target URL is not a workflow run for this repository.`
    );
  }

  const runId = url.pathname.slice(expectedPathPrefix.length).split("/")[0];
  if (!/^\d+$/.test(runId)) {
    fail(`${label} workflow run ID is invalid.`);
  }
  return runId;
}

function migrationDelta(rollback, candidate) {
  const output = git([
    "diff",
    "--name-only",
    `${rollback}..${candidate}`,
    "--",
    "drizzle/*.sql",
  ]);
  const files = output ? output.split(/\r?\n/).filter(Boolean) : [];
  const riskyPattern =
    /\b(DROP\s+(?:TABLE|COLUMN|INDEX)|TRUNCATE\b|DELETE\s+FROM\b|RENAME\s+COLUMN\b|MODIFY\s+COLUMN\b|CHANGE\s+COLUMN\b)\s*/gi;
  const risky = [];

  for (const file of files) {
    const text = git(["show", `${candidate}:${file}`]);
    for (const match of text.matchAll(riskyPattern)) {
      const line = text.slice(0, match.index).split(/\r?\n/).length;
      risky.push({
        file,
        line,
        operation: match[0].trim().replace(/\s+/g, " "),
      });
    }
  }
  return { files, risky };
}

async function main() {
  const candidate = fullSha("PRODUCTION_CANDIDATE_SHA");
  const rollback = fullSha("PRODUCTION_ROLLBACK_SHA");
  const repository =
    process.env.GITHUB_REPOSITORY?.trim() || "pattaramet-tech/ipenovel";
  const apiBase =
    process.env.GITHUB_API_URL?.trim() || "https://api.github.com";
  const token = process.env.GITHUB_TOKEN?.trim() || "";
  const legacyProdBranch =
    process.env.PRODUCTION_LEGACY_BRANCH?.trim() || DEFAULT_LEGACY_PROD_BRANCH;
  const stagingBase =
    process.env.PRODUCTION_STAGING_URL?.trim() || `https://${STAGING_HOST}`;
  const productionBase =
    process.env.PRODUCTION_BASE_URL?.trim() || `https://${PRODUCTION_HOST}`;
  const manifestPath = path.resolve(
    process.env.PRODUCTION_PROMOTION_MANIFEST?.trim() ||
      "production-promotion-manifest.json"
  );

  assertHost(stagingBase, STAGING_HOST, "PRODUCTION_STAGING_URL");
  assertHost(productionBase, PRODUCTION_HOST, "PRODUCTION_BASE_URL");

  if (required("PRODUCTION_CONFIRMATION") !== CONFIRMATION) {
    fail(`PRODUCTION_CONFIRMATION must exactly equal ${CONFIRMATION}.`);
  }
  if (!truthy(process.env.PRODUCTION_BACKUP_CONFIRMED)) {
    fail("Production backup confirmation is required.");
  }
  if (!truthy(process.env.PRODUCTION_BASELINE_CONFIRMED)) {
    fail("Production rollback baseline confirmation is required.");
  }

  if (!gitExists(candidate)) {
    fail("Candidate SHA is not present in the fetched repository.");
  }
  if (!gitExists(rollback)) {
    fail("Rollback SHA is not present in the fetched repository.");
  }
  if (!isAncestor(rollback, candidate)) {
    fail(
      "Rollback SHA is not an ancestor of the candidate; refusing non-linear promotion."
    );
  }

  const mainHead = remoteBranchHead("main");
  if (!isAncestor(candidate, mainHead)) {
    fail("Candidate is not contained in current origin/main history.");
  }

  const legacyProdHead = remoteBranchHead(legacyProdBranch);

  const stagingReady = await fetchJson(new URL("/readyz", stagingBase), "");
  if (
    stagingReady?.status !== "ready" ||
    String(stagingReady?.revision || "").toLowerCase() !== candidate ||
    stagingReady?.environment !== STAGING_ENVIRONMENT
  ) {
    fail(
      "Production staging /readyz does not report the exact candidate and production-staging environment."
    );
  }

  const statuses = await fetchJson(
    `${apiBase}/repos/${repository}/commits/${candidate}/statuses?per_page=100`,
    token
  );

  const mainBoundStatus = statuses.find(
    item => item?.context === MAIN_BOUND_CONTEXT
  );
  if (!mainBoundStatus || mainBoundStatus.state !== "success") {
    fail("Candidate does not have production-staging/main-bound-rc=success.");
  }

  const stagingStatus = statuses.find(
    item => item?.context === STAGING_STATUS_CONTEXT
  );
  if (!stagingStatus || stagingStatus.state !== "success") {
    fail(
      "Candidate does not have production-staging/release-candidate=success."
    );
  }

  const releaseBaselineContext = `production-staging/release-baseline/${rollback}`;
  const releaseBaselineStatus = statuses.find(
    item => item?.context === releaseBaselineContext
  );
  if (!releaseBaselineStatus || releaseBaselineStatus.state !== "success") {
    fail(
      "Candidate staging evidence is not bound to the requested Production rollback baseline."
    );
  }

  const mainBoundRunId = extractRunId(
    mainBoundStatus.target_url,
    repository,
    "Main-bound RC"
  );
  const mainBoundRun = await fetchJson(
    `${apiBase}/repos/${repository}/actions/runs/${mainBoundRunId}`,
    token
  );
  if (
    mainBoundRun?.event !== "workflow_dispatch" ||
    mainBoundRun?.conclusion !== "success" ||
    mainBoundRun?.name !== "Main Production Release Candidate"
  ) {
    fail(
      "Main-bound RC status does not point to a successful Main Production Release Candidate workflow run."
    );
  }

  const stagingRunId = extractRunId(
    stagingStatus.target_url,
    repository,
    "Production staging"
  );
  const stagingRun = await fetchJson(
    `${apiBase}/repos/${repository}/actions/runs/${stagingRunId}`,
    token
  );
  if (
    stagingRun?.event !== "repository_dispatch" ||
    stagingRun?.conclusion !== "success" ||
    stagingRun?.name !== "Production Staging Regression Gate"
  ) {
    fail(
      "Production staging status does not point to a successful repository_dispatch regression run."
    );
  }

  const prodReady = await fetchJson(new URL("/readyz", productionBase), "");
  const observedProdRevision = String(prodReady?.revision || "")
    .trim()
    .toLowerCase();

  let baselineMode = "revision-aware";
  if (observedProdRevision) {
    if (
      !SHA_PATTERN.test(observedProdRevision) ||
      observedProdRevision !== rollback
    ) {
      fail(
        `Production /readyz revision does not match rollback SHA ${rollback}.`
      );
    }
  } else {
    baselineMode = "legacy-branch-confirmed";
    if (legacyProdHead !== rollback) {
      fail(
        `Legacy Production has no runtime revision and origin/${legacyProdBranch} HEAD does not match rollback SHA.`
      );
    }
  }

  const migrations = migrationDelta(rollback, candidate);
  if (
    migrations.risky.length > 0 &&
    !truthy(process.env.PRODUCTION_MIGRATION_REVIEW_CONFIRMED)
  ) {
    fail(
      `Migration delta contains ${migrations.risky.length} destructive-looking operation(s); explicit migration review confirmation is required.`
    );
  }

  const manifest = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    repository,
    candidateSha: candidate,
    rollbackSha: rollback,
    main: {
      currentHead: mainHead,
      candidateContainedInMain: true,
      mainBoundContext: MAIN_BOUND_CONTEXT,
      mainBoundWorkflowRunId: Number(mainBoundRunId),
      mainBoundWorkflowRunUrl: mainBoundStatus.target_url,
    },
    productionStaging: {
      environment: STAGING_ENVIRONMENT,
      url: stagingBase,
      revision: candidate,
      eligibilityContext: STAGING_STATUS_CONTEXT,
      workflowRunId: Number(stagingRunId),
      workflowRunUrl: stagingStatus.target_url,
      releaseBaselineContext,
    },
    productionBaseline: {
      mode: baselineMode,
      legacyBranch: legacyProdBranch,
      legacyBranchHead: legacyProdHead,
      observedRuntimeRevision: observedProdRevision || null,
    },
    delta: {
      commitsAhead: Number(
        git(["rev-list", "--count", `${rollback}..${candidate}`])
      ),
      shortStat: git(["diff", "--shortstat", `${rollback}..${candidate}`]),
      migrationFiles: migrations.files,
      riskyMigrationOperations: migrations.risky,
    },
    attestations: {
      backupConfirmed: true,
      baselineConfirmed: true,
      migrationReviewConfirmed:
        migrations.risky.length === 0 ||
        truthy(process.env.PRODUCTION_MIGRATION_REVIEW_CONFIRMED),
      confirmation: CONFIRMATION,
    },
  };

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", {
    mode: 0o600,
  });

  console.log(`[production-preflight] candidate=${candidate}`);
  console.log(`[production-preflight] rollback=${rollback}`);
  console.log(`[production-preflight] mainBound=success run=${mainBoundRunId}`);
  console.log(
    `[production-preflight] productionStaging=success run=${stagingRunId}`
  );
  console.log(`[production-preflight] baselineMode=${baselineMode}`);
  console.log(
    `[production-preflight] commitsAhead=${manifest.delta.commitsAhead}`
  );
  console.log(
    `[production-preflight] migrations=${migrations.files.length} riskyOperations=${migrations.risky.length}`
  );
  for (const item of migrations.risky) {
    console.log(
      `[production-preflight] migration-review ${item.file}:${item.line} ${item.operation}`
    );
  }
  console.log(`[production-preflight] manifest=${manifestPath}`);
  console.log(
    "[production-preflight] PASS: main-bound candidate passed isolated Production staging and is authorized for explicit Production activation."
  );
}

main().catch(error => {
  console.error(
    `[production-preflight] FAIL: ${error?.message || String(error)}`
  );
  process.exitCode = 1;
});
