import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const PREVIEW_HOST = "r2-preview.ipenovel.com";
const baseURL = process.env.E2E_BASE_URL?.trim() || `https://${PREVIEW_HOST}`;
const profile = (
  process.env.E2E_GATE_PROFILE?.trim() || "public"
).toLowerCase();
const expectedRevisionRaw = process.env.E2E_EXPECTED_REVISION?.trim() || "";
const requireExpectedRevision = /^(1|true|yes)$/i.test(
  process.env.E2E_REQUIRE_EXPECTED_REVISION?.trim() || ""
);
const deployedBranch = process.env.E2E_DEPLOYED_BRANCH?.trim() || "";
const requiredDeployBranch =
  process.env.E2E_REQUIRED_DEPLOY_BRANCH?.trim() || "fix/m12d8-reconcile-056-ui";
const GIT_REVISION_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const expectedRevision = expectedRevisionRaw.toLowerCase();
const readyTimeoutMs = Number(process.env.E2E_GATE_READY_TIMEOUT_MS || 180_000);
const readyIntervalMs = Number(process.env.E2E_GATE_READY_INTERVAL_MS || 2_000);
const stableRequired = Number(process.env.E2E_GATE_STABLE_CHECKS || 3);
const userStatePath = path.resolve(
  repoRoot,
  process.env.E2E_STORAGE_STATE?.trim() || ".playwright/.auth/user.json"
);
const adminStatePath = path.resolve(
  repoRoot,
  process.env.E2E_ADMIN_STORAGE_STATE?.trim() || ".playwright/.auth/admin.json"
);

function fail(message) {
  console.error(`[preview-gate] FAIL: ${message}`);
  process.exit(1);
}

function assertExpectedRevision() {
  if (requireExpectedRevision && !expectedRevisionRaw) {
    fail(
      "Repository-dispatch gate requires E2E_EXPECTED_REVISION from client_payload.deployed_sha."
    );
  }
  if (expectedRevisionRaw && !GIT_REVISION_PATTERN.test(expectedRevisionRaw)) {
    fail(`Invalid E2E_EXPECTED_REVISION: ${expectedRevisionRaw}`);
  }
  if (requireExpectedRevision && deployedBranch !== requiredDeployBranch) {
    fail(
      `Repository-dispatch gate requires branch "${requiredDeployBranch}", received "${deployedBranch || "missing"}".`
    );
  }
}

function normalizeRevision(value) {
  if (typeof value !== "string") return "";
  const revision = value.trim();
  return GIT_REVISION_PATTERN.test(revision) ? revision.toLowerCase() : "";
}

function assertSafeTarget() {
  let url;
  try {
    url = new URL(baseURL);
  } catch {
    fail(`Invalid E2E_BASE_URL: ${baseURL}`);
  }
  if (url.hostname !== PREVIEW_HOST) {
    fail(
      `Refusing deploy gate target "${url.hostname}". Required host: ${PREVIEW_HOST}.`
    );
  }
  if (url.protocol !== "https:") {
    fail(`Refusing non-HTTPS Preview target: ${url.protocol}`);
  }
}

function decodeStorageState(envName, destination) {
  const encoded = process.env[envName]?.trim();
  if (!encoded) return false;
  let decoded;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    if (!Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) {
      throw new Error("storageState must contain cookies[] and origins[]");
    }
  } catch (error) {
    fail(
      `${envName} is not a valid base64 Playwright storageState: ${error.message}`
    );
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, decoded, { mode: 0o600 });
  return true;
}
async function fetchJson(pathname) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(new URL(pathname, baseURL), {
      signal: controller.signal,
      headers: { "cache-control": "no-cache" },
    });
    let body = null;
    try {
      body = await response.json();
    } catch {}
    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForStablePreview() {
  const deadline = Date.now() + readyTimeoutMs;
  let consecutive = 0;
  let attempt = 0;
  let lastActualRevision = "";

  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const [health, ready] = await Promise.all([
        fetchJson("/healthz"),
        fetchJson("/readyz"),
      ]);
      const actualRevision = normalizeRevision(ready.body?.revision);
      lastActualRevision = actualRevision || lastActualRevision;
      const revisionMatches =
        !expectedRevision || actualRevision === expectedRevision;
      const ok =
        health.status === 200 &&
        health.body?.status === "ok" &&
        ready.status === 200 &&
        ready.body?.status === "ready" &&
        revisionMatches;

      if (ok) {
        consecutive += 1;
        const revisionSuffix = expectedRevision
          ? ` revision=${actualRevision}`
          : actualRevision
            ? ` revision=${actualRevision} (not enforced)`
            : " revision=unavailable (not enforced)";
        console.log(
          `[preview-gate] readiness ${consecutive}/${stableRequired} (attempt ${attempt})${revisionSuffix}`
        );
        if (consecutive >= stableRequired) return;
      } else {
        consecutive = 0;
        const revisionDetail = expectedRevision
          ? ` expectedRevision=${expectedRevision} actualRevision=${actualRevision || "missing"}`
          : "";
        console.log(
          `[preview-gate] waiting: health=${health.status}/${health.body?.status ?? "?"} ready=${ready.status}/${ready.body?.status ?? "?"}${revisionDetail}`
        );
      }
    } catch (error) {
      consecutive = 0;
      console.log(
        `[preview-gate] waiting: ${error.name === "AbortError" ? "probe timeout" : error.message}`
      );
    }
    await sleep(readyIntervalMs);
  }

  if (expectedRevision) {
    fail(
      `Preview revision did not stabilize at ${expectedRevision} within ${readyTimeoutMs}ms; last observed revision=${lastActualRevision || "missing"}.`
    );
  }
  fail(`Preview did not become stable within ${readyTimeoutMs}ms.`);
}

function runProject(project, extraEnv = {}) {
  const cli = path.join(
    repoRoot,
    "node_modules",
    "@playwright",
    "test",
    "cli.js"
  );
  if (!fs.existsSync(cli))
    fail(`Playwright CLI not found at ${cli}. Run pnpm install first.`);
  console.log(`\n[preview-gate] === Playwright project: ${project} ===`);
  const result = spawnSync(
    process.execPath,
    [cli, "test", `--project=${project}`],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...process.env, E2E_BASE_URL: baseURL, ...extraEnv },
    }
  );
  if (result.error)
    fail(`Could not start Playwright ${project}: ${result.error.message}`);
  if (result.status !== 0)
    fail(`Playwright project "${project}" exited ${result.status}.`);
}
async function main() {
  assertSafeTarget();
  assertExpectedRevision();
  if (!["public", "auto", "full"].includes(profile)) {
    fail(
      `Unsupported E2E_GATE_PROFILE "${profile}". Use public, auto, or full.`
    );
  }

  decodeStorageState("E2E_USER_STORAGE_STATE_B64", userStatePath);
  decodeStorageState("E2E_ADMIN_STORAGE_STATE_B64", adminStatePath);

  const hasUserState = fs.existsSync(userStatePath);
  const hasAdminState = fs.existsSync(adminStatePath);

  if (profile === "full" && !hasUserState)
    fail(`Full gate requires user storageState at ${userStatePath}.`);
  if (profile === "full" && !hasAdminState)
    fail(`Full gate requires admin storageState at ${adminStatePath}.`);

  console.log(`[preview-gate] target=${baseURL}`);
  console.log(
    `[preview-gate] profile=${profile} userState=${hasUserState ? "present" : "missing"} adminState=${hasAdminState ? "present" : "missing"}`
  );
  console.log(
    `[preview-gate] expectedRevision=${expectedRevision || "not-enforced"} requireExpectedRevision=${requireExpectedRevision}`
  );
  console.log(
    `[preview-gate] deployedBranch=${deployedBranch || "not-enforced"} requiredDeployBranch=${requiredDeployBranch}`
  );
  await waitForStablePreview();

  runProject("public");
  if (profile === "public") {
    console.log(
      "\n[preview-gate] PASS: public Preview regression gate passed."
    );
    return;
  }

  if (hasUserState) runProject("auth");
  else console.log("[preview-gate] auth skipped: no user storageState.");

  if (hasAdminState) runProject("admin");
  else console.log("[preview-gate] admin skipped: no admin storageState.");

  const mutationRequested =
    profile === "full" ||
    /^(1|true|yes)$/i.test(process.env.E2E_ALLOW_MUTATION?.trim() || "");
  if (mutationRequested) {
    if (!hasUserState) fail("Mutation gate requires user storageState.");
    runProject("mutation", { E2E_ALLOW_MUTATION: "1" });
  } else {
    console.log(
      "[preview-gate] mutation skipped: not enabled for auto profile."
    );
  }

  console.log(
    `\n[preview-gate] PASS: ${profile} Preview regression gate passed.`
  );
}

main().catch(error => fail(error?.stack || error?.message || String(error)));
