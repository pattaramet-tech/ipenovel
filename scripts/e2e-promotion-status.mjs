import process from "node:process";

const CONTEXT = "preview/promotion-eligibility";
const DEFAULT_REQUIRED_BRANCH = "fix/m12d8-reconcile-056-ui";
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function fail(message) {
  console.error(`[promotion-status] FAIL: ${message}`);
  process.exit(1);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`Missing ${name}.`);
  return value;
}

function targetUrl() {
  const server = process.env.GITHUB_SERVER_URL?.trim() || "https://github.com";
  const repository = required("GITHUB_REPOSITORY");
  const runId = required("GITHUB_RUN_ID");
  return `${server}/${repository}/actions/runs/${runId}`;
}

function determineFinalStatus({ gateResult, profile, branch, requiredBranch }) {
  if (
    gateResult === "success" &&
    profile === "full" &&
    branch === requiredBranch
  ) {
    return {
      state: "success",
      description: "Preview revision matched and Full Gate passed",
    };
  }
  if (profile !== "full") {
    return {
      state: "failure",
      description: `Not eligible: profile=${profile || "missing"} is not full`,
    };
  }
  if (branch !== requiredBranch) {
    return {
      state: "failure",
      description: `Not eligible: unexpected Preview branch`,
    };
  }
  return {
    state: "failure",
    description: `Not eligible: Preview Full Gate ${gateResult || "unknown"}`,
  };
}

async function postStatus({ sha, state, description }) {
  const repository = required("GITHUB_REPOSITORY");
  const token = required("GITHUB_TOKEN");
  const apiBase =
    process.env.GITHUB_API_URL?.trim() || "https://api.github.com";

  const response = await fetch(
    `${apiBase}/repos/${repository}/statuses/${sha}`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state,
        context: CONTEXT,
        description,
        target_url: targetUrl(),
      }),
    }
  );

  if (!response.ok) {
    const detail = await response.text();
    fail(`GitHub status update failed HTTP ${response.status}: ${detail}`);
  }

  console.log(
    `[promotion-status] context=${CONTEXT} sha=${sha} state=${state} description="${description}"`
  );
}

async function main() {
  const mode = process.argv[2]?.trim().toLowerCase();
  if (!["pending", "final"].includes(mode)) {
    fail("Usage: node scripts/e2e-promotion-status.mjs <pending|final>");
  }

  const sha = required("PROMOTION_SHA").toLowerCase();
  if (!GIT_SHA.test(sha)) fail("PROMOTION_SHA must be a full Git SHA.");

  const profile = process.env.PROMOTION_PROFILE?.trim().toLowerCase() || "";
  const branch = process.env.PROMOTION_BRANCH?.trim() || "";
  const requiredBranch =
    process.env.PROMOTION_REQUIRED_BRANCH?.trim() || DEFAULT_REQUIRED_BRANCH;

  if (mode === "pending") {
    await postStatus({
      sha,
      state: "pending",
      description:
        profile === "full" && branch === requiredBranch
          ? "Preview Full Gate is running"
          : "Preview gate running; eligibility constraints pending",
    });
    return;
  }

  const gateResult =
    process.env.PROMOTION_GATE_RESULT?.trim().toLowerCase() || "";
  await postStatus({
    sha,
    ...determineFinalStatus({ gateResult, profile, branch, requiredBranch }),
  });
}

main().catch(error => fail(error?.stack || error?.message || String(error)));
