import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  isDiagnosticsEnabled,
  createDiagnosticLogger,
  getActiveResourceTypeCounts,
  logActiveResourceSnapshot,
  waitOneEventLoopTurn,
  waitForDiagnosticSettlement,
} from "./testDbDiagnostics";

/**
 * DB-independent coverage for the shared test-database diagnostics module
 * used by scripts/test-db-prepare.ts and scripts/migrate-test-db.ts. Never
 * touches a real database or network connection - process.getActiveResourcesInfo()
 * is mocked directly.
 */

const ENV_KEY = "IPENOVEL_TEST_DB_DIAGNOSTICS";
let originalEnvValue: string | undefined;

beforeEach(() => {
  originalEnvValue = process.env[ENV_KEY];
});

afterEach(() => {
  if (originalEnvValue === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = originalEnvValue;
  }
  vi.restoreAllMocks();
});

describe("isDiagnosticsEnabled", () => {
  it("is false when the env var is unset", () => {
    delete process.env[ENV_KEY];
    expect(isDiagnosticsEnabled()).toBe(false);
  });

  it("is false for any value other than the exact string \"1\"", () => {
    process.env[ENV_KEY] = "true";
    expect(isDiagnosticsEnabled()).toBe(false);
    process.env[ENV_KEY] = "yes";
    expect(isDiagnosticsEnabled()).toBe(false);
    process.env[ENV_KEY] = "0";
    expect(isDiagnosticsEnabled()).toBe(false);
  });

  it("is true only for the exact string \"1\"", () => {
    process.env[ENV_KEY] = "1";
    expect(isDiagnosticsEnabled()).toBe(true);
  });
});

describe("createDiagnosticLogger", () => {
  it("does not log anything when diagnostics are disabled", () => {
    delete process.env[ENV_KEY];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logDiagnostic = createDiagnosticLogger("[test-prefix]");

    logDiagnostic("some marker");

    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("logs the marker prefixed with the given prefix when enabled", () => {
    process.env[ENV_KEY] = "1";
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logDiagnostic = createDiagnosticLogger("[test-prefix]");

    logDiagnostic("some marker");

    expect(consoleSpy).toHaveBeenCalledWith("[test-prefix][diagnostics] some marker");
  });
});

describe("getActiveResourceTypeCounts", () => {
  it("tallies resource type strings into counts", () => {
    (process as any).getActiveResourcesInfo = () => ["TCPSOCKETWRAP", "TCPSOCKETWRAP", "PipeWrap", "Immediate"];

    const counts = getActiveResourceTypeCounts();

    expect(counts).toEqual({ TCPSOCKETWRAP: 2, PipeWrap: 1, Immediate: 1 });

    delete (process as any).getActiveResourcesInfo;
  });

  it("returns an empty object when getActiveResourcesInfo is unavailable", () => {
    const original = (process as any).getActiveResourcesInfo;
    delete (process as any).getActiveResourcesInfo;

    expect(getActiveResourceTypeCounts()).toEqual({});

    if (original) (process as any).getActiveResourcesInfo = original;
  });
});

describe("logActiveResourceSnapshot", () => {
  it("does not log anything when diagnostics are disabled, even if a label is supplied", () => {
    delete process.env[ENV_KEY];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logDiagnostic = createDiagnosticLogger("[test-prefix]");

    logActiveResourceSnapshot(logDiagnostic, "some label");

    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("logs the resource counts alongside the fixed label when enabled", () => {
    process.env[ENV_KEY] = "1";
    (process as any).getActiveResourcesInfo = () => ["TCPSOCKETWRAP", "PipeWrap"];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logDiagnostic = createDiagnosticLogger("[test-prefix]");

    logActiveResourceSnapshot(logDiagnostic, "after reset connection close");

    expect(consoleSpy).toHaveBeenCalledWith(
      '[test-prefix][diagnostics] active resource snapshot (after reset connection close): {"TCPSOCKETWRAP":1,"PipeWrap":1}'
    );

    delete (process as any).getActiveResourcesInfo;
  });

  it("logs a fixed failure message (including only the fixed label) when reading the snapshot throws - never the caught error", () => {
    process.env[ENV_KEY] = "1";
    (process as any).getActiveResourcesInfo = () => {
      throw new Error("mysql://root:hunter2@10.0.0.5:3306/ipenovel_test leaked in a hypothetical driver error");
    };
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const logDiagnostic = createDiagnosticLogger("[test-prefix]");

    logActiveResourceSnapshot(logDiagnostic, "after reset connection close");

    expect(consoleSpy).toHaveBeenCalledWith(
      "[test-prefix][diagnostics] failed to read active resource types (after reset connection close)"
    );
    const allLoggedText = consoleSpy.mock.calls.flat().map(String).join("\n");
    expect(allLoggedText).not.toMatch(/hunter2/);
    expect(allLoggedText).not.toMatch(/10\.0\.0\.5/);
    expect(allLoggedText).not.toMatch(/mysql:\/\//);

    delete (process as any).getActiveResourcesInfo;
  });
});

describe("waitOneEventLoopTurn", () => {
  it("resolves (after at least one event-loop turn)", async () => {
    await expect(waitOneEventLoopTurn()).resolves.toBeUndefined();
  });
});

describe("waitForDiagnosticSettlement", () => {
  it("resolves after approximately the requested delay", async () => {
    const start = Date.now();
    await waitForDiagnosticSettlement(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  it("clears its internal timeout after resolving", async () => {
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

    await waitForDiagnosticSettlement(10);

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it("never unrefs its internal timeout - it must remain able to keep the process alive until it fires", async () => {
    const realSetTimeout = global.setTimeout;
    let unrefCallCount = 0;

    const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((fn: any, ms?: number, ...args: any[]) => {
      const handle: any = realSetTimeout(fn, ms, ...args);
      const originalUnref = handle.unref?.bind(handle);
      if (originalUnref) {
        handle.unref = (...unrefArgs: any[]) => {
          unrefCallCount += 1;
          return originalUnref(...unrefArgs);
        };
      }
      return handle;
    }) as any);

    await waitForDiagnosticSettlement(10);

    expect(setTimeoutSpy).toHaveBeenCalled();
    expect(unrefCallCount).toBe(0);

    setTimeoutSpy.mockRestore();
  });
});
