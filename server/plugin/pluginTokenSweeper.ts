import { deleteExpiredPluginAuthArtifacts, type PluginSweepResult } from "./store";

// IPE-PLUGIN-001B expired-artifact sweeper - factory pattern copied from
// server/workspace/publishUnattendedWorker.ts: a self-rescheduling
// setTimeout loop, inert unless its exact-literal "true" env flag is set,
// injectable clock/timers/worker for tests, and started/stopped alongside
// the HTTP server in server/_core/index.ts.

const DEFAULT_POLL_MS = 60_000;
const MIN_POLL_MS = 1_000;
const MAX_POLL_MS = 3_600_000;
const ERROR_BACKOFF_MS = 60_000;

type SweeperDeps = {
  runOnce?: (now: Date) => Promise<PluginSweepResult>;
  setTimer?: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  log?: (record: Record<string, unknown>) => void;
};

export type PluginTokenSweeper = {
  readonly enabled: boolean;
  readonly pollMs: number;
  start(): void;
  stop(): void;
  isRunning(): boolean;
};

function parsePollMs(raw: string | undefined): number {
  if (!raw?.trim()) return DEFAULT_POLL_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < MIN_POLL_MS || value > MAX_POLL_MS) {
    throw new Error(
      `PLUGIN_TOKEN_SWEEPER_POLL_MS must be an integer between ${MIN_POLL_MS} and ${MAX_POLL_MS}.`
    );
  }
  return value;
}

function defaultLog(record: Record<string, unknown>): void {
  const line = JSON.stringify({ component: "plugin-token-sweeper", ...record });
  if (record.level === "error") console.error(line);
  else console.log(line);
}

export function createPluginTokenSweeper(
  env: NodeJS.ProcessEnv = process.env,
  deps: SweeperDeps = {}
): PluginTokenSweeper {
  const pollMs = parsePollMs(env.PLUGIN_TOKEN_SWEEPER_POLL_MS);
  const enabled = env.PLUGIN_TOKEN_SWEEPER_ENABLED === "true";
  const runOnce = deps.runOnce ?? deleteExpiredPluginAuthArtifacts;
  const setTimer = deps.setTimer ?? ((fn, delayMs) => setTimeout(fn, delayMs));
  const clearTimer = deps.clearTimer ?? (timer => clearTimeout(timer));
  const log = deps.log ?? defaultLog;

  if (!enabled) {
    return {
      enabled: false,
      pollMs,
      start() {},
      stop() {},
      isRunning: () => false,
    };
  }

  let started = false;
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimer(() => {
      void tick();
    }, delayMs);
    (timer as unknown as { unref?: () => void })?.unref?.();
  };

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    let nextDelay = pollMs;
    try {
      const result = await runOnce(new Date());
      log({ level: "info", event: "cycle_complete", ...result });
    } catch (error) {
      nextDelay = Math.max(pollMs, ERROR_BACKOFF_MS);
      const value = error as { name?: unknown };
      log({
        level: "error",
        event: "cycle_failed",
        errorName: typeof value?.name === "string" ? value.name : "Error",
        retryInMs: nextDelay,
      });
    } finally {
      inFlight = false;
      schedule(nextDelay);
    }
  };

  return {
    enabled: true,
    pollMs,
    start() {
      if (started || stopped) return;
      started = true;
      log({ level: "info", event: "started", pollMs });
      schedule(0);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimer(timer);
      log({ level: "info", event: "stopped" });
    },
    isRunning() {
      return started && !stopped;
    },
  };
}
