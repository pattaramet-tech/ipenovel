import process from "node:process";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const CONTEXT = "production/promotion-authorization";

function fail(message) {
  throw new Error(message);
}

async function main() {
  const sha = (process.argv[2] || process.env.PRODUCTION_CANDIDATE_SHA || "")
    .trim()
    .toLowerCase();
  if (!SHA_PATTERN.test(sha)) fail("Provide a full candidate Git SHA.");

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
  if (!response.ok)
    fail(`GitHub status lookup failed HTTP ${response.status}.`);

  const statuses = await response.json();
  const status = statuses.find(item => item?.context === CONTEXT);
  const state = status?.state || "missing";
  const authorized = state === "success";

  console.log(`SHA=${sha}`);
  console.log(`CONTEXT=${CONTEXT}`);
  console.log(`STATE=${state}`);
  console.log(`AUTHORIZED=${authorized ? "yes" : "no"}`);
  if (status?.target_url) console.log(`TARGET_URL=${status.target_url}`);

  if (!authorized) process.exitCode = 1;
}

main().catch(error => {
  console.error(
    `[production-authorization-check] FAIL: ${error?.message || String(error)}`
  );
  process.exitCode = 1;
});
