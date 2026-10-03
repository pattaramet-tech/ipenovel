import { describe, expect, it } from "vitest";
import { createPluginTokenSweeper } from "./pluginTokenSweeper";

const baseEnv = { PLUGIN_TOKEN_SWEEPER_ENABLED: "true" } as NodeJS.ProcessEnv;

/**
 * Wraps REAL timers (recording every scheduled delay) so the sweeper's
 * self-rescheduling loop actually ticks, exactly like
 * publishUnattendedWorker under production timing.
 */
function makeHarness() {
  const delays: number[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  const setTimer = (fn: () => void, delayMs: number) => {
    delays.push(delayMs);
    const timer = setTimeout(() => {
      void fn();
    }, delayMs);
    timers.push(timer);
    return timer;
  };
  const clearTimer = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer);
  const logs: Array<Record<string, unknown>> = [];
  const drain = () => new Promise<void>(resolve => setTimeout(resolve, 20));
  return { delays, timers, setTimer, clearTimer, logs, drain, log: (record: Record<string, unknown>) => logs.push(record) };
}

describe("createPluginTokenSweeper", () => {
  it("is inert unless PLUGIN_TOKEN_SWEEPER_ENABLED is exactly \"true\"", () => {
    for (const raw of [undefined, "", "TRUE", " true", "1", "false"]) {
      const sweeper = createPluginTokenSweeper(
        { ...baseEnv, PLUGIN_TOKEN_SWEEPER_ENABLED: raw } as NodeJS.ProcessEnv,
        {}
      );
      expect(sweeper.enabled, `raw=${String(raw)}`).toBe(false);
      sweeper.start();
      expect(sweeper.isRunning()).toBe(false);
      sweeper.stop();
    }
  });

  it("validates poll ms strictly", () => {
    expect(() =>
      createPluginTokenSweeper({ ...baseEnv, PLUGIN_TOKEN_SWEEPER_POLL_MS: "500" } as NodeJS.ProcessEnv, {})
    ).toThrow(/between 1000 and 3600000/);
    expect(() =>
      createPluginTokenSweeper({ ...baseEnv, PLUGIN_TOKEN_SWEEPER_POLL_MS: "abc" } as NodeJS.ProcessEnv, {})
    ).toThrow();
  });

  it("runs the sweep immediately on start and reschedules on the poll interval", async () => {
    const harness = makeHarness();
    const swept: Date[] = [];
    const sweeper = createPluginTokenSweeper(baseEnv, {
      runOnce: async now => {
        swept.push(now);
        return { expiredCodes: 1, expiredConsentAttempts: 0, expiredAccessTokens: 2, expiredRefreshTokens: 0 };
      },
      setTimer: harness.setTimer,
      clearTimer: harness.clearTimer,
      log: harness.log,
    });

    expect(sweeper.enabled).toBe(true);
    expect(sweeper.pollMs).toBe(60_000);
    sweeper.start();
    expect(sweeper.isRunning()).toBe(true);
    await harness.drain();
    expect(swept.length).toBe(1);
    expect(harness.delays[0]).toBe(0);
    expect(harness.delays).toContain(60_000);
    expect(harness.logs.some(record => record.event === "cycle_complete")).toBe(true);

    sweeper.stop();
    expect(sweeper.isRunning()).toBe(false);
    const scheduledBefore = harness.delays.length;
    await harness.drain();
    expect(harness.delays.length).toBe(scheduledBefore);
  });

  it("backs off on sweep failure and never throws out of the loop", async () => {
    const harness = makeHarness();
    let attempts = 0;
    const sweeper = createPluginTokenSweeper(baseEnv, {
      runOnce: async () => {
        attempts += 1;
        throw new Error("simulated sweep failure");
      },
      setTimer: harness.setTimer,
      clearTimer: harness.clearTimer,
      log: harness.log,
    });
    sweeper.start();
    await harness.drain();
    expect(attempts).toBe(1);
    expect(harness.logs.some(record => record.event === "cycle_failed")).toBe(true);
    sweeper.stop();
  });
});
