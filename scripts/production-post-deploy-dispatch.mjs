import process from "node:process";
import { pathToFileURL } from "node:url";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const PROD_ENVIRONMENT = "production";
const PROD_REPOSITORY = "pattaramet-tech/ipenovel";
const GITHUB_API_ORIGIN = "https://api.github.com";
const EVENT_TYPE = "production-deployed";
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 15_000;
const RETRYABLE_STATUS = new Set([408, 425, 429]);

function fail(message) {
  throw new Error(message);
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) fail(`Missing ${name}.`);
  return value;
}

export function resolveProductionDispatchConfig(env = process.env) {
  const environment = required(env, "DEPLOYMENT_ENVIRONMENT");
  if (environment !== PROD_ENVIRONMENT) {
    fail(
      `DEPLOYMENT_ENVIRONMENT must exactly equal ${PROD_ENVIRONMENT}; got ${environment}.`
    );
  }

  const deployedSha = required(env, "SOURCE_COMMIT").toLowerCase();
  if (!SHA_PATTERN.test(deployedSha)) {
    fail("SOURCE_COMMIT must be a full 40-character Git SHA.");
  }

  const token = required(env, "GITHUB_PRODUCTION_DISPATCH_TOKEN");
  const repository = (env.GITHUB_REPOSITORY || PROD_REPOSITORY).trim();
  if (repository !== PROD_REPOSITORY) {
    fail(`GITHUB_REPOSITORY must exactly equal ${PROD_REPOSITORY}.`);
  }

  return {
    deployedSha,
    environment,
    repository,
    token,
  };
}

export function buildProductionDispatchPayload(deployedSha) {
  if (!SHA_PATTERN.test(String(deployedSha || ""))) {
    fail("deployedSha must be a full 40-character Git SHA.");
  }

  return {
    event_type: EVENT_TYPE,
    client_payload: {
      deployed_sha: deployedSha.toLowerCase(),
      environment: PROD_ENVIRONMENT,
    },
  };
}

function isRetryableStatus(status) {
  return RETRYABLE_STATUS.has(status) || status >= 500;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function dispatchProductionDeployed({
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
  sleepImpl = sleep,
  attempts = DEFAULT_ATTEMPTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") {
    fail("fetch implementation is unavailable.");
  }
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) {
    fail("attempts must be an integer between 1 and 5.");
  }

  const config = resolveProductionDispatchConfig(env);
  const payload = buildProductionDispatchPayload(config.deployedSha);
  const endpoint = new URL(
    `/repos/${config.repository}/dispatches`,
    GITHUB_API_ORIGIN
  );

  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${config.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) break;
      logger.warn(
        `[production-dispatch] transient network failure; retrying attempt ${attempt + 1}/${attempts}`
      );
      await sleepImpl(Math.min(1000 * attempt, 3000));
      continue;
    }

    if (response.status === 204) {
      logger.log(
        `[production-dispatch] dispatched ${EVENT_TYPE} sha=${config.deployedSha} environment=${config.environment}`
      );
      return {
        ok: true,
        status: response.status,
        deployedSha: config.deployedSha,
      };
    }

    const responseText = await response.text().catch(() => "");
    const message = `GitHub repository dispatch failed HTTP ${response.status}${
      responseText ? `: ${responseText.slice(0, 300)}` : ""
    }`;

    if (!isRetryableStatus(response.status) || attempt >= attempts) {
      fail(message);
    }

    logger.warn(
      `[production-dispatch] GitHub HTTP ${response.status}; retrying attempt ${attempt + 1}/${attempts}`
    );
    await sleepImpl(Math.min(1000 * attempt, 3000));
  }

  fail(
    `GitHub repository dispatch failed after ${attempts} attempt(s): ${
      lastError?.message || String(lastError || "network failure")
    }`
  );
}

export async function main() {
  await dispatchProductionDeployed();
}

const invokedAsScript =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsScript) {
  main().catch(error => {
    console.error(
      `[production-dispatch] FAIL: ${error?.message || String(error)}`
    );
    process.exitCode = 1;
  });
}
