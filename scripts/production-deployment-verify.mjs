import process from "node:process";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const AUTH_CONTEXT = "production/promotion-authorization";
const PROD_HOST = "ipenovel.com";

function fail(message) {
  throw new Error(message);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`Missing ${name}.`);
  return value;
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {}
  if (!response.ok) fail(`HTTP ${response.status}: ${new URL(url).pathname}`);
  return body;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const sha = required("PRODUCTION_CANDIDATE_SHA").toLowerCase();
  if (!SHA_PATTERN.test(sha))
    fail("PRODUCTION_CANDIDATE_SHA must be a full Git SHA.");

  const repository =
    process.env.GITHUB_REPOSITORY?.trim() || "pattaramet-tech/ipenovel";
  const apiBase =
    process.env.GITHUB_API_URL?.trim() || "https://api.github.com";
  const token = required("GITHUB_TOKEN");
  const base =
    process.env.PRODUCTION_BASE_URL?.trim() || "https://ipenovel.com";
  const parsed = new URL(base);
  if (parsed.protocol !== "https:" || parsed.hostname !== PROD_HOST) {
    fail("PRODUCTION_BASE_URL must be https://ipenovel.com.");
  }

  const statuses = await fetchJson(
    `${apiBase}/repos/${repository}/commits/${sha}/statuses?per_page=100`,
    {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    }
  );
  const authorization = statuses.find(item => item?.context === AUTH_CONTEXT);
  if (!authorization || authorization.state !== "success") {
    fail("Deployed SHA is not production/promotion-authorization=success.");
  }

  const stableRequired = Number(process.env.PRODUCTION_STABLE_CHECKS || 3);
  const intervalMs = Number(process.env.PRODUCTION_READY_INTERVAL_MS || 2_000);
  const timeoutMs = Number(process.env.PRODUCTION_READY_TIMEOUT_MS || 180_000);
  const deadline = Date.now() + timeoutMs;
  let consecutive = 0;
  let lastRevision = "";

  while (Date.now() < deadline) {
    try {
      const [health, ready] = await Promise.all([
        fetchJson(new URL("/healthz", base), { "cache-control": "no-cache" }),
        fetchJson(new URL("/readyz", base), { "cache-control": "no-cache" }),
      ]);
      const revision = String(ready?.revision || "")
        .trim()
        .toLowerCase();
      lastRevision = revision || lastRevision;
      if (
        health?.status === "ok" &&
        ready?.status === "ready" &&
        revision === sha
      ) {
        consecutive += 1;
        console.log(
          `[production-verify] readiness ${consecutive}/${stableRequired} revision=${revision}`
        );
        if (consecutive >= stableRequired) break;
      } else {
        consecutive = 0;
        console.log(
          `[production-verify] waiting health=${health?.status || "?"} ready=${ready?.status || "?"} expected=${sha} actual=${revision || "missing"}`
        );
      }
    } catch (error) {
      consecutive = 0;
      console.log(
        `[production-verify] waiting ${error?.message || String(error)}`
      );
    }
    await sleep(intervalMs);
  }

  if (consecutive < stableRequired) {
    fail(
      `Production revision did not stabilize at ${sha}; last=${lastRevision || "missing"}.`
    );
  }

  const home = await fetch(new URL("/", base), {
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (home.status !== 200)
    fail(`Production root smoke returned HTTP ${home.status}.`);
  const contentType = home.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("text/html")) {
    fail("Production root smoke did not return HTML.");
  }

  console.log(
    "[production-verify] PASS: exact authorized Production revision is healthy and serving HTML."
  );
}

main().catch(error => {
  console.error(`[production-verify] FAIL: ${error?.message || String(error)}`);
  process.exitCode = 1;
});
