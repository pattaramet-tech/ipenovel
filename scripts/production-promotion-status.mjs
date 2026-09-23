import process from "node:process";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const CONTEXTS = {
  authorization: "production/promotion-authorization",
  verification: "production/deployment-verification",
};

function fail(message) {
  console.error(`[production-status] FAIL: ${message}`);
  process.exit(1);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`Missing ${name}.`);
  return value;
}

function targetUrl() {
  const server = process.env.GITHUB_SERVER_URL?.trim() || "https://github.com";
  return `${server}/${required("GITHUB_REPOSITORY")}/actions/runs/${required("GITHUB_RUN_ID")}`;
}

async function postStatus({ sha, context, state, description }) {
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
        context,
        description,
        target_url: targetUrl(),
      }),
    }
  );
  if (!response.ok) {
    fail(
      `GitHub status update failed HTTP ${response.status}: ${await response.text()}`
    );
  }
  console.log(
    `[production-status] context=${context} sha=${sha} state=${state}`
  );
}

async function main() {
  const kind = process.argv[2]?.trim().toLowerCase();
  const phase = process.argv[3]?.trim().toLowerCase();
  if (!CONTEXTS[kind] || !["pending", "final"].includes(phase)) {
    fail(
      "Usage: node scripts/production-promotion-status.mjs <authorization|verification> <pending|final>"
    );
  }

  const sha = required("PRODUCTION_CANDIDATE_SHA").toLowerCase();
  if (!SHA_PATTERN.test(sha))
    fail("PRODUCTION_CANDIDATE_SHA must be a full Git SHA.");

  const result = process.env.PRODUCTION_RESULT?.trim().toLowerCase() || "";
  if (phase === "pending") {
    await postStatus({
      sha,
      context: CONTEXTS[kind],
      state: "pending",
      description:
        kind === "authorization"
          ? "Production promotion preflight is running"
          : "Production post-deploy verification is running",
    });
    return;
  }

  const success = result === "success";
  await postStatus({
    sha,
    context: CONTEXTS[kind],
    state: success ? "success" : "failure",
    description:
      kind === "authorization"
        ? success
          ? "Production promotion preflight authorized"
          : `Production promotion preflight ${result || "failed"}`
        : success
          ? "Production deployed revision verified"
          : `Production deployment verification ${result || "failed"}`,
  });
}

main().catch(error => fail(error?.message || String(error)));
