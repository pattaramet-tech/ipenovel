const serverUrl = (process.env.NQA_BRIDGE_SERVER_URL || "").replace(/\/$/, "");
const workerToken = process.env.NQA_BRIDGE_WORKER_TOKEN || "";
const pollMs = Math.max(250, Number(process.env.NQA_BRIDGE_POLL_MS || "750"));

if (!/^https:\/\//.test(serverUrl)) {
  throw new Error("NQA_BRIDGE_SERVER_URL must be an HTTPS origin.");
}
if (workerToken.trim().length < 32) {
  throw new Error("NQA_BRIDGE_WORKER_TOKEN must contain at least 32 characters.");
}

const localEndpoints = {
  embed: "http://127.0.0.1:8765/embed",
  rerank: "http://127.0.0.1:8766/rerank",
  adjudicate: "http://127.0.0.1:8767/adjudicate",
  "verify-structure": "http://127.0.0.1:8767/verify-structure",
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function checkedLocalFetch(kind, payload) {
  const endpoint = localEndpoints[kind];
  if (!endpoint) throw new Error("UNSUPPORTED_JOB_KIND");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error("LOCAL_SIDECAR_HTTP_" + response.status);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("LOCAL_SIDECAR_INVALID_JSON");
  }
}

async function bridgeFetch(path, init = {}) {
  return await fetch(serverUrl + path, {
    ...init,
    headers: {
      Authorization: "Bearer " + workerToken,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
    signal: init.signal || AbortSignal.timeout(30_000),
  });
}

async function pull() {
  const response = await bridgeFetch("/api/nqa/bridge/worker/pull", {
    method: "POST",
  });
  if (response.status === 204) return null;
  if (!response.ok) {
    throw new Error("BRIDGE_PULL_HTTP_" + response.status);
  }
  return await response.json();
}

async function complete(job, result, error) {
  const response = await bridgeFetch("/api/nqa/bridge/worker/result", {
    method: "POST",
    body: JSON.stringify({
      jobId: job.jobId,
      ...(error ? { error } : { result }),
    }),
  });
  if (!response.ok && response.status !== 409) {
    throw new Error("BRIDGE_RESULT_HTTP_" + response.status);
  }
}

async function run() {
  console.log("[nqa-bridge-worker] started");
  let consecutiveErrors = 0;

  while (true) {
    try {
      const job = await pull();
      if (!job) {
        consecutiveErrors = 0;
        await sleep(pollMs);
        continue;
      }

      const started = Date.now();
      try {
        const result = await checkedLocalFetch(job.kind, job.payload);
        await complete(job, result, null);
        console.log(
          "[nqa-bridge-worker] completed " +
            job.kind +
            " " +
            job.jobId +
            " in " +
            (Date.now() - started) +
            "ms"
        );
      } catch (error) {
        const code =
          error instanceof Error ? error.message.slice(0, 200) : "WORKER_FAILED";
        await complete(job, null, code).catch(() => {});
        console.error(
          "[nqa-bridge-worker] job failed " + job.kind + " " + job.jobId
        );
      }
      consecutiveErrors = 0;
    } catch {
      consecutiveErrors += 1;
      if (consecutiveErrors === 1 || consecutiveErrors % 20 === 0) {
        console.error("[nqa-bridge-worker] bridge poll unavailable");
      }
      await sleep(Math.min(10_000, pollMs * Math.max(2, consecutiveErrors)));
    }
  }
}

await run();
