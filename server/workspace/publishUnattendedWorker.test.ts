import { describe, expect, it, vi } from "vitest";
import { databaseIdentityFingerprint } from "../../scripts/lib/databaseIdentity.mjs";
import { createUnattendedPublishWorker } from "./publishUnattendedWorker";

function previewEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    DEPLOYMENT_ENVIRONMENT: "preview",
    WORKSPACE_PUBLISH_EXECUTION_ENABLED: "true",
    WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED: "true",
    WORKSPACE_PUBLISH_ACCEPTANCE_TIER: "preview",
    WORKSPACE_PUBLISH_PREVIEW_DATABASE_NAME: "ipenovel_preview",
    DATABASE_URL: "mysql://user:pass@localhost/ipenovel_preview",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function productionEnv(overrides: Record<string, string | undefined> = {}) {
  const productionUrl = "mysql://user:pass@prod-db.internal/ipenovel_prod";
  const stagingUrl = "mysql://user:pass@staging-db.internal/ipenovel_staging";
  return {
    DEPLOYMENT_ENVIRONMENT: "production",
    DATABASE_URL: productionUrl,
    PRODUCTION_DB_FINGERPRINT: databaseIdentityFingerprint(productionUrl),
    PRODUCTION_STAGING_DB_FINGERPRINT: databaseIdentityFingerprint(stagingUrl),
    WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED: "true",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("M12D.9 unattended publish worker runtime", () => {
  it("is inert when the Preview execution/provider gates are not both enabled", () => {
    const worker = createUnattendedPublishWorker(
      previewEnv({ WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED: "false" })
    );
    expect(worker.enabled).toBe(false);
    worker.start();
    expect(worker.isRunning()).toBe(false);
  });

  it("supports an explicit emergency kill switch even when execution is enabled", () => {
    const worker = createUnattendedPublishWorker(
      previewEnv({ WORKSPACE_PUBLISH_UNATTENDED_ENABLED: "false" })
    );
    expect(worker.enabled).toBe(false);
  });

  it("fails closed when unattended mode is explicitly requested without provider execution", () => {
    expect(() =>
      createUnattendedPublishWorker(
        previewEnv({
          WORKSPACE_PUBLISH_UNATTENDED_ENABLED: "true",
          WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED: "false",
        })
      )
    ).toThrow(/execution policy and external-provider configuration/i);
  });

  it("fails closed when active Preview flags point at a non-Preview database identity", () => {
    expect(() =>
      createUnattendedPublishWorker(
        previewEnv({ DATABASE_URL: "mysql://user:pass@localhost/ipenovel_prod" })
      )
    ).toThrow(/database identity/i);
  });

  it("enables the Production worker without WORKSPACE_PUBLISH_EXECUTION_ENABLED, even when the legacy flag is false", () => {
    const withoutFlag = productionEnv();
    delete withoutFlag.WORKSPACE_PUBLISH_EXECUTION_ENABLED;
    const withFalseFlag = productionEnv({ WORKSPACE_PUBLISH_EXECUTION_ENABLED: "false" });

    expect(createUnattendedPublishWorker(withoutFlag).enabled).toBe(true);
    expect(createUnattendedPublishWorker(withFalseFlag).enabled).toBe(true);
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

    const worker = createUnattendedPublishWorker(previewEnv(), {
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

    const worker = createUnattendedPublishWorker(previewEnv(), {
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
