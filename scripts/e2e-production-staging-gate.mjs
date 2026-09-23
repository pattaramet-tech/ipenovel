import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const STAGING_HOST = "production-staging.ipenovel.com";
const STAGING_ENVIRONMENT = "production-staging";
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const baseURL = process.env.E2E_BASE_URL?.trim() || `https://${STAGING_HOST}`;
const expectedRevision =
  process.env.E2E_EXPECTED_REVISION?.trim().toLowerCase() || "";
const expectedEnvironment =
  process.env.E2E_EXPECTED_ENVIRONMENT?.trim() || STAGING_ENVIRONMENT;
const readyTimeoutMs = Number(process.env.E2E_GATE_READY_TIMEOUT_MS || 180_000);
const readyIntervalMs = Number(process.env.E2E_GATE_READY_INTERVAL_MS || 2_000);
const stableRequired = Number(process.env.E2E_GATE_STABLE_CHECKS || 3);
const userStatePath = path.resolve(
  repoRoot,
  process.env.E2E_STORAGE_STATE?.trim() || ".playwright/.auth/staging-user.json"
);
const adminStatePath = path.resolve(
  repoRoot,
  process.env.E2E_ADMIN_STORAGE_STATE?.trim() ||
    ".playwright/.auth/staging-admin.json"
);

function fail(message) {
  console.error(`[production-staging-gate] FAIL: ${message}`);
  process.exit(1);
}

function assertTarget() {
  let url;
  try {
    url = new URL(baseURL);
  } catch {
    fail(`Invalid E2E_BASE_URL: ${baseURL}`);
  }
  if (url.protocol !== "https:" || url.hostname !== STAGING_HOST) {
    fail(
      `Refusing staging gate target ${url.href}. Required https://${STAGING_HOST}.`
    );
  }
  if (!SHA_PATTERN.test(expectedRevision)) {
    fail("E2E_EXPECTED_REVISION must be a full 40-character Git SHA.");
  }
  if (expectedEnvironment !== STAGING_ENVIRONMENT) {
    fail(`E2E_EXPECTED_ENVIRONMENT must equal ${STAGING_ENVIRONMENT}.`);
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

async function waitForStableStaging() {
  const deadline = Date.now() + readyTimeoutMs;
  let consecutive = 0;
  let lastRevision = "";
  let lastEnvironment = "";

  while (Date.now() < deadline) {
    try {
      const [health, ready] = await Promise.all([
        fetchJson("/healthz"),
        fetchJson("/readyz"),
      ]);
      const revision = String(ready.body?.revision || "")
        .trim()
        .toLowerCase();
      const environment = String(ready.body?.environment || "").trim();
      lastRevision = revision || lastRevision;
      lastEnvironment = environment || lastEnvironment;

      const ok =
        health.status === 200 &&
        health.body?.status === "ok" &&
        ready.status === 200 &&
        ready.body?.status === "ready" &&
        revision === expectedRevision &&
        environment === expectedEnvironment;

      if (ok) {
        consecutive += 1;
        console.log(
          `[production-staging-gate] readiness ${consecutive}/${stableRequired} revision=${revision} environment=${environment}`
        );
        if (consecutive >= stableRequired) return;
      } else {
        consecutive = 0;
        console.log(
          `[production-staging-gate] waiting expectedRevision=${expectedRevision} actualRevision=${revision || "missing"} expectedEnvironment=${expectedEnvironment} actualEnvironment=${environment || "missing"}`
        );
      }
    } catch (error) {
      consecutive = 0;
      console.log(
        `[production-staging-gate] waiting ${error.name === "AbortError" ? "probe timeout" : error.message}`
      );
    }

    await sleep(readyIntervalMs);
  }

  fail(
    `Staging did not stabilize at revision=${expectedRevision} environment=${expectedEnvironment}; lastRevision=${lastRevision || "missing"} lastEnvironment=${lastEnvironment || "missing"}.`
  );
}

function runProject(project, extraEnv = {}) {
  const cli = path.join(
    repoRoot,
    "node_modules",
    "@playwright",
    "test",
    "cli.js"
  );
  if (!fs.existsSync(cli)) {
    fail(`Playwright CLI not found at ${cli}. Run pnpm install first.`);
  }

  console.log(
    `\n[production-staging-gate] === Playwright project: ${project} ===`
  );
  const result = spawnSync(
    process.execPath,
    [cli, "test", `--project=${project}`],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        E2E_BASE_URL: baseURL,
        E2E_STORAGE_STATE: userStatePath,
        E2E_ADMIN_STORAGE_STATE: adminStatePath,
        ...extraEnv,
      },
    }
  );

  if (result.error) {
    fail(`Could not start Playwright ${project}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`Playwright project "${project}" exited ${result.status}.`);
  }
}

async function main() {
  assertTarget();

  decodeStorageState("E2E_STAGING_USER_STORAGE_STATE_B64", userStatePath);
  decodeStorageState("E2E_STAGING_ADMIN_STORAGE_STATE_B64", adminStatePath);

  if (!fs.existsSync(userStatePath)) {
    fail(`Full staging gate requires user storageState at ${userStatePath}.`);
  }
  if (!fs.existsSync(adminStatePath)) {
    fail(`Full staging gate requires admin storageState at ${adminStatePath}.`);
  }

  console.log(`[production-staging-gate] target=${baseURL}`);
  console.log(
    `[production-staging-gate] expectedRevision=${expectedRevision} expectedEnvironment=${expectedEnvironment}`
  );

  await waitForStableStaging();

  runProject("public");
  runProject("auth");
  runProject("admin");
  runProject("mutation", { E2E_ALLOW_MUTATION: "1" });

  console.log(
    "\n[production-staging-gate] PASS: isolated Production staging Full Gate passed."
  );
}

main().catch(error => fail(error?.stack || error?.message || String(error)));
