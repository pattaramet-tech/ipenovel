import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";

const BRIDGE_ENABLED_ENV = "NQA_PRIVATE_INFERENCE_BRIDGE_ENABLED";
const BRIDGE_WORKER_TOKEN_ENV = "NQA_PRIVATE_BRIDGE_WORKER_TOKEN";
const JOB_TIMEOUT_MS = 300_000;
const WORKER_FRESHNESS_MS = 20_000;
const MAX_PAYLOAD_CHARS = 5_000_000;

type BridgeKind = "embed" | "rerank" | "adjudicate" | "verify-structure";

type PendingJob = {
  id: string;
  kind: BridgeKind;
  payload: unknown;
  createdAt: number;
  claimed: boolean;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function bridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[BRIDGE_ENABLED_ENV] === "true";
}

function configuredToken(env: NodeJS.ProcessEnv = process.env): string {
  return env[BRIDGE_WORKER_TOKEN_ENV]?.trim() ?? "";
}

function safeTokenEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && a.length >= 32 && timingSafeEqual(a, b);
}

function workerAuthorized(req: Request): boolean {
  const expected = configuredToken();
  const header = req.get("authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return safeTokenEqual(expected, supplied);
}

function isLoopbackSocket(req: Request): boolean {
  const address = req.socket.remoteAddress ?? "";
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function payloadWithinBound(value: unknown): boolean {
  try {
    return JSON.stringify(value).length <= MAX_PAYLOAD_CHARS;
  } catch {
    return false;
  }
}

export class NqaPrivateInferenceBroker {
  private readonly queue: string[] = [];
  private readonly jobs = new Map<string, PendingJob>();
  private workerLastSeenAt = 0;

  status(now = Date.now()) {
    return {
      enabled: bridgeEnabled(),
      workerReady:
        bridgeEnabled() &&
        configuredToken().length >= 32 &&
        now - this.workerLastSeenAt <= WORKER_FRESHNESS_MS,
      queuedJobs: this.queue.length,
      inFlightJobs: Array.from(this.jobs.values()).filter(job => job.claimed)
        .length,
    };
  }

  touchWorker(now = Date.now()) {
    this.workerLastSeenAt = now;
  }

  async submit(kind: BridgeKind, payload: unknown): Promise<unknown> {
    if (!bridgeEnabled()) {
      throw new Error("NQA_PRIVATE_BRIDGE_DISABLED");
    }
    if (configuredToken().length < 32) {
      throw new Error("NQA_PRIVATE_BRIDGE_TOKEN_NOT_CONFIGURED");
    }
    if (!payloadWithinBound(payload)) {
      throw new Error("NQA_PRIVATE_BRIDGE_PAYLOAD_TOO_LARGE");
    }

    const id = randomUUID();
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.jobs.delete(id);
        const index = this.queue.indexOf(id);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new Error("NQA_PRIVATE_BRIDGE_TIMEOUT"));
      }, JOB_TIMEOUT_MS);

      this.jobs.set(id, {
        id,
        kind,
        payload,
        createdAt: Date.now(),
        claimed: false,
        resolve,
        reject,
        timer,
      });
      this.queue.push(id);
    });
  }

  pull() {
    this.touchWorker();
    while (this.queue.length > 0) {
      const id = this.queue.shift()!;
      const job = this.jobs.get(id);
      if (!job || job.claimed) continue;
      job.claimed = true;
      return {
        jobId: job.id,
        kind: job.kind,
        payload: job.payload,
        createdAt: new Date(job.createdAt).toISOString(),
      };
    }
    return null;
  }

  complete(input: {
    jobId: string;
    result?: unknown;
    error?: string | null;
  }): boolean {
    this.touchWorker();
    const job = this.jobs.get(input.jobId);
    if (!job) return false;
    this.jobs.delete(input.jobId);
    clearTimeout(job.timer);

    if (input.error) {
      job.reject(new Error("NQA_PRIVATE_BRIDGE_WORKER_ERROR"));
    } else if (!payloadWithinBound(input.result)) {
      job.reject(new Error("NQA_PRIVATE_BRIDGE_RESULT_TOO_LARGE"));
    } else {
      job.resolve(input.result);
    }
    return true;
  }
}

const broker = new NqaPrivateInferenceBroker();

function internalKind(path: string): BridgeKind | null {
  if (path.endsWith("/embed")) return "embed";
  if (path.endsWith("/rerank")) return "rerank";
  if (path.endsWith("/adjudicate")) return "adjudicate";
  if (path.endsWith("/verify-structure")) return "verify-structure";
  return null;
}

function failClosed(res: Response, status: number, code: string) {
  res.status(status).json({ error: code });
}

export function registerNqaPrivateInferenceBridgeRoutes(app: Express) {
  app.get("/api/nqa/bridge/health", (req, res) => {
    if (!isLoopbackSocket(req)) {
      failClosed(res, 403, "NQA_PRIVATE_BRIDGE_LOOPBACK_ONLY");
      return;
    }
    const status = broker.status();
    res.status(status.workerReady ? 200 : 503).json({
      status: status.workerReady ? "ready" : "blocked",
      workerReady: status.workerReady,
    });
  });

  for (const path of [
    "/api/nqa/bridge/embed",
    "/api/nqa/bridge/rerank",
    "/api/nqa/bridge/adjudicate",
    "/api/nqa/bridge/verify-structure",
  ]) {
    app.post(path, async (req, res) => {
      if (!isLoopbackSocket(req)) {
        failClosed(res, 403, "NQA_PRIVATE_BRIDGE_LOOPBACK_ONLY");
        return;
      }
      const kind = internalKind(path);
      if (!kind) {
        failClosed(res, 404, "NQA_PRIVATE_BRIDGE_ROUTE_INVALID");
        return;
      }
      try {
        const result = await broker.submit(kind, req.body);
        res.status(200).json(result);
      } catch (error) {
        const code = error instanceof Error ? error.message : "NQA_PRIVATE_BRIDGE_FAILED";
        failClosed(res, 503, code);
      }
    });
  }

  app.post("/api/nqa/bridge/worker/pull", (req, res) => {
    if (!bridgeEnabled()) {
      failClosed(res, 503, "NQA_PRIVATE_BRIDGE_DISABLED");
      return;
    }
    if (!workerAuthorized(req)) {
      failClosed(res, 401, "NQA_PRIVATE_BRIDGE_UNAUTHORIZED");
      return;
    }
    const job = broker.pull();
    if (!job) {
      res.status(204).end();
      return;
    }
    res.status(200).json(job);
  });

  app.post("/api/nqa/bridge/worker/result", (req, res) => {
    if (!bridgeEnabled()) {
      failClosed(res, 503, "NQA_PRIVATE_BRIDGE_DISABLED");
      return;
    }
    if (!workerAuthorized(req)) {
      failClosed(res, 401, "NQA_PRIVATE_BRIDGE_UNAUTHORIZED");
      return;
    }

    const jobId =
      typeof req.body?.jobId === "string" ? req.body.jobId.trim() : "";
    const error =
      typeof req.body?.error === "string" ? req.body.error.slice(0, 500) : null;
    if (!jobId) {
      failClosed(res, 400, "NQA_PRIVATE_BRIDGE_JOB_ID_REQUIRED");
      return;
    }

    const accepted = broker.complete({
      jobId,
      result: req.body?.result,
      error,
    });
    if (!accepted) {
      failClosed(res, 409, "NQA_PRIVATE_BRIDGE_JOB_STALE");
      return;
    }
    res.status(204).end();
  });
}

export function getNqaPrivateInferenceBrokerForTests() {
  return broker;
}
