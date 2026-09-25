import { describe, expect, it, vi } from "vitest";
import { databaseIdentityFingerprint } from "../../scripts/lib/databaseIdentity.mjs";
import { createUnattendedPublishWorker } from "./publishUnattendedWorker";

const PRODUCTION_URL = "mysql://user:pass@prod-db.internal/ipenovel_prod";
const STAGING_URL = "mysql://user:pass@staging-db.internal/ipenovel_staging";
const PRODUCTION_FINGERPRINT = databaseIdentityFingerprint(PRODUCTION_URL);
const STAGING_FINGERPRINT = databaseIdentityFingerprint(STAGING_URL);

function releaseEnv(
  environment: "production" | "production-staging",
  overrides: Record<string, string | undefined> = {}
) {
  return {
    DEPLOYMENT_ENVIRONMENT: environment,
    DATABASE_URL: environment === "production" ? PRODUCTION_URL : STAGING_URL,
    PRODUCTION_DB_FINGERPRINT: PRODUCTION_FINGERPRINT,
    PRODUCTION_STAGING_DB_FINGERPRINT: STAGING_FINGERPRINT,
    WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED: "true",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("M12D.9/M12D.13 unattended publish worker runtime", () => {
  it("stays inert outside Production and production-staging without any legacy rollout flag", () => {
    const worker = createUnattendedPublishWorker({
      DEPLOYMENT_ENVIRONMENT: "preview",
      DATABASE_URL: "mysql://user:pass@preview.internal/ipenovel_preview",
      WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED: "true",
    } as NodeJS.ProcessEnv);

    expect(worker.enabled).toBe(false);
    worker.start();
    expect(worker.isRunning()).toBe(false);
  });

  it("supports the worker-specific emergency stop in a valid release environment", () => {
    const worker = createUnattendedPublishWorker(
      releaseEnv("production-staging", { WORKSPACE_PUBLISH_UNATTENDED_ENABLED: "false" })
    );
    expect(worker.enabled).toBe(false);
  });

  it("fails closed when unattended mode is explicitly requested outside a supported release environment", () => {
    expect(() =>
      createUnattendedPublishWorker({
        DEPLOYMENT_ENVIRONMENT: "preview",
        WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED: "true",
        WORKSPACE_PUBLISH_UNATTENDED_ENABLED: "true",
      } as NodeJS.ProcessEnv)
    ).toThrow(/supported release environment/i);
  });

  it("fails closed when production-staging does not match its approved DB identity", () => {
    expect(() =>
      createUnattendedPublishWorker(
        releaseEnv("production-staging", { DATABASE_URL: PRODUCTION_URL })
      )
    ).toThrow(/production-staging database identity/i);
  });

  it("enables the worker in both release environments when identity and provider config are valid", () => {
    expect(createUnattendedPublishWorker(releaseEnv("production")).enabled).toBe(true);
    expect(createUnattendedPublishWorker(releaseEnv("production-staging")).enabled).toBe(true);
  });

  it("fails closed when the external provider is disabled", () => {
    const worker = createUnattendedPublishWorker(
      releaseEnv("production-staging", { WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED: "false" })
    );
    expect(worker.enabled).toBe(false);
  });

  it("automatically executes one durable queued scope and schedules the next poll", async () => {
    const timers: Array<{ fn: () => void; delayMs: number }> = [];
    const clearTimer = vi.fn();
    const logs: Array<Record<string, unknown>> = [];
    const runOnce = vi.fn(async () => ({ claimed: true, durationMs: 3 } as any));
    const scope = {
      workspaceId: 2,
      workspaceNovelId: 9,
      runId: 8,
      expectedCutoverEpoch: 1,
      expectedOwnershipVersion: 2,
    };
    const resolveScope = vi.fn(async () => scope);

    const worker = createUnattendedPublishWorker(releaseEnv("production-staging"), {
      resolveScope: resolveScope as any,
      runOnce: runOnce as any,
      createProvider: (() => ({
        mode: "external",
        reconcile: async () => undefined,
        execute: async () => ({ status: "published", providerReceipt: "receipt" }),
      })) as any,
      setTimer: ((fn: () => void, delayMs: number) => {
        timers.push({ fn, delayMs });
        return { unref() {} } as any;
      }) as any,
      clearTimer: clearTimer as any,
      log: record => logs.push(record),
    });

    expect(worker.enabled).toBe(true);
    worker.start();
    expect(worker.isRunning()).toBe(true);
    expect(timers[0]?.delayMs).toBe(0);
    expect(logs.some(row => row.event === "started" && row.environment === "production-staging")).toBe(true);

    timers.shift()!.fn();
    await new Promise(resolve => setImmediate(resolve));

    expect(resolveScope).toHaveBeenCalledTimes(1);
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(runOnce.mock.calls[0]?.[0]?.scope).toEqual(scope);
    expect(timers[0]?.delayMs).toBe(worker.pollMs);
    expect(logs.some(row => row.event === "cycle_complete" && row.runId === 8)).toBe(true);

    worker.stop();
    expect(worker.isRunning()).toBe(false);
    expect(clearTimer).toHaveBeenCalledTimes(1);
  });

  it("backs off after a cycle error without leaking the thrown message", async () => {
    const timers: Array<{ fn: () => void; delayMs: number }> = [];
    const logs: Array<Record<string, unknown>> = [];
    const secret = "mysql://secret-user:secret-pass@db/prod";

    const worker = createUnattendedPublishWorker(releaseEnv("production"), {
      resolveScope: (async () => {
        const error = new Error(secret) as Error & { code?: string };
        error.code = "TRANSIENT_DB";
        throw error;
      }) as any,
      setTimer: ((fn: () => void, delayMs: number) => {
        timers.push({ fn, delayMs });
        return { unref() {} } as any;
      }) as any,
      clearTimer: (() => {}) as any,
      log: record => logs.push(record),
    });

    worker.start();
    timers.shift()!.fn();
    await new Promise(resolve => setImmediate(resolve));

    expect(timers[0]?.delayMs).toBeGreaterThanOrEqual(10_000);
    const failure = logs.find(row => row.event === "cycle_failed");
    expect(failure?.errorCode).toBe("TRANSIENT_DB");
    expect(JSON.stringify(failure)).not.toContain(secret);
    worker.stop();
  });
});
