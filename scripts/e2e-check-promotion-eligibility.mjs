import process from "node:process";

const CONTEXT = "preview/promotion-eligibility";
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function fail(message) {
  throw new Error(message);
}

async function main() {
  const sha = (process.argv[2] || process.env.PROMOTION_SHA || "")
    .trim()
    .toLowerCase();
  if (!GIT_SHA.test(sha)) {
    fail("Provide a full Git SHA as argv[2] or PROMOTION_SHA.");
  }

  const repository =
    process.env.GITHUB_REPOSITORY?.trim() || "pattaramet-tech/ipenovel";
  const apiBase =
    process.env.GITHUB_API_URL?.trim() || "https://api.github.com";
  const token = process.env.GITHUB_TOKEN?.trim();

  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(
    `${apiBase}/repos/${repository}/commits/${sha}/statuses?per_page=100`,
    { headers }
  );

  if (!response.ok) {
    fail(`GitHub status lookup failed HTTP ${response.status}.`);
  }

  const statuses = await response.json();
  const status = statuses.find(item => item?.context === CONTEXT);

  const state = status?.state || "missing";
  const promotable = state === "success";

  console.log(`SHA=${sha}`);
  console.log(`CONTEXT=${CONTEXT}`);
  console.log(`STATE=${state}`);
  console.log(`PROMOTABLE=${promotable ? "yes" : "no"}`);
  if (status?.target_url) console.log(`TARGET_URL=${status.target_url}`);

  if (!promotable) process.exitCode = 1;
}

main().catch(error => {
  console.error(`[promotion-check] FAIL: ${error?.message || String(error)}`);
  process.exitCode = 1;
});
