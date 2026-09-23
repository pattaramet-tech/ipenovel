import process from "node:process";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const FIXED_CONTEXTS = {
  rc: "production-staging/main-bound-rc",
  gate: "production-staging/release-candidate",
};

function fail(message) {
  console.error(`[production-staging-status] FAIL: ${message}`);
  process.exit(1);
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

function contextFor(kind) {
  if (FIXED_CONTEXTS[kind]) return FIXED_CONTEXTS[kind];
  if (kind === "rc-baseline") {
    return `production-staging/rc-baseline/${fullSha("PRODUCTION_BASELINE_SHA")}`;
  }
  if (kind === "release-baseline") {
    return `production-staging/release-baseline/${fullSha("PRODUCTION_BASELINE_SHA")}`;
  }
  fail("Unknown status kind.");
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
    `[production-staging-status] context=${context} sha=${sha} state=${state}`
  );
}

async function main() {
  const kind = process.argv[2]?.trim().toLowerCase();
  const phase = process.argv[3]?.trim().toLowerCase();
  if (!kind || !["pending", "final"].includes(phase)) {
    fail(
      "Usage: node scripts/production-staging-status.mjs <rc|rc-baseline|gate|release-baseline> <pending|final>"
    );
  }

  const sha = fullSha("PRODUCTION_CANDIDATE_SHA");
  const context = contextFor(kind);
  const result = process.env.PRODUCTION_RESULT?.trim().toLowerCase() || "";

  if (phase === "pending") {
    await postStatus({
      sha,
      context,
      state: "pending",
      description:
        kind === "rc"
          ? "Main-bound release candidate validation is running"
          : kind === "gate"
            ? "Isolated Production staging Full Gate is running"
            : "Production staging baseline binding is pending",
    });
    return;
  }

  const success = result === "success";
  await postStatus({
    sha,
    context,
    state: success ? "success" : "failure",
    description:
      kind === "rc"
        ? success
          ? "Candidate was exact main HEAD when release candidate was created"
          : "Main-bound release candidate validation failed"
        : kind === "gate"
          ? success
            ? "Isolated Production staging revision and Full Gate passed"
            : "Isolated Production staging Full Gate failed"
          : success
            ? `Staging baseline bound to ${fullSha("PRODUCTION_BASELINE_SHA")}`
            : "Production staging baseline binding failed",
  });
}

main().catch(error => fail(error?.message || String(error)));
