import { createIpeNovelWorkspacePublishProvider } from "./ipenovelPublish.provider";
import {
  resolveWorkspacePublishExecutionPolicy,
  runScopedPublishWorkerOnce,
} from "./publishExecution.runtime";
import { resolvePendingPublishExecutionScope } from "./publishExecution.service";

const DEFAULT_POLL_MS = 5_000;
const MIN_POLL_MS = 1_000;
const MAX_POLL_MS = 60_000;
const ERROR_BACKOFF_MS = 10_000;

type PublishScope = Awaited<ReturnType<typeof resolvePendingPublishExecutionScope>>;

type UnattendedWorkerDeps = {
  resolveScope?: typeof resolvePendingPublishExecutionScope;
  runOnce?: typeof runScopedPublishWorkerOnce;
  createProvider?: typeof createIpeNovelWorkspacePublishProvider;
  setTimer?: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  log?: (record: Record<string, unknown>) => void;
};

export type UnattendedPublishWorker = {
  readonly enabled: boolean;
  readonly pollMs: number;
  start(): void;
  stop(): void;
  isRunning(): boolean;
};

function parsePollMs(raw: string | undefined) {
  if (!raw?.trim()) return DEFAULT_POLL_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < MIN_POLL_MS || value > MAX_POLL_MS) {
    throw new Error(
      `WORKSPACE_PUBLISH_UNATTENDED_POLL_MS must be an integer between ${MIN_POLL_MS} and ${MAX_POLL_MS}.`
    );
  }
  return value;
}

function defaultLog(record: Record<string, unknown>) {
  const line = JSON.stringify({ component: "workspace-publish-worker", ...record });
  if (record.level === "error") console.error(line);
  else console.log(line);
}

function safeErrorRecord(error: unknown) {
  const value = error as { name?: unknown; code?: unknown };
  return {
    errorName: typeof value?.name === "string" ? value.name : "Error",
    errorCode: typeof value?.code === "string" ? value.code : "UNCLASSIFIED",
  };
}

export function createUnattendedPublishWorker(
  env: NodeJS.ProcessEnv = process.env,
  deps: UnattendedWorkerDeps = {}
): UnattendedPublishWorker {
  const pollMs = parsePollMs(env.WORKSPACE_PUBLISH_UNATTENDED_POLL_MS);
  const explicitlyEnabled = env.WORKSPACE_PUBLISH_UNATTENDED_ENABLED === "true";
  const explicitlyDisabled = env.WORKSPACE_PUBLISH_UNATTENDED_ENABLED === "false";
  const publishPolicy = resolveWorkspacePublishExecutionPolicy(env);
  const { executionEnabled, externalProviderEnabled } = publishPolicy;

  if (
    explicitlyEnabled &&
    (!executionEnabled || !externalProviderEnabled)
  ) {
    throw new Error(
      "Explicit unattended publish requires execution policy and external-provider configuration to be enabled."
    );
  }

  // No new rollout flag is required for Preview: once the two existing
  // execution gates are deliberately enabled, unattended draining is the
  // default. WORKSPACE_PUBLISH_UNATTENDED_ENABLED=false is an emergency kill
  // switch; =true turns missing prerequisite flags into a fail-closed boot.
  const enabled =
    !explicitlyDisabled && executionEnabled && externalProviderEnabled;

  if (!enabled) {
    return {
      enabled: false,
      pollMs,
      start() {},
      stop() {},
      isRunning: () => false,
    };
  }

  const safety = publishPolicy.safety;
  if (!safety) {
    throw new Error("Enabled unattended publish requires resolved environment safety.");
  }
  const resolveScope = deps.resolveScope ?? resolvePendingPublishExecutionScope;
  const runOnce = deps.runOnce ?? runScopedPublishWorkerOnce;
  const createProvider = deps.createProvider ?? createIpeNovelWorkspacePublishProvider;
  const setTimer = deps.setTimer ?? ((fn, delayMs) => setTimeout(fn, delayMs));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  const log = deps.log ?? defaultLog;

  let started = false;
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimer(() => {
      void tick();
    }, delayMs);
    (timer as any)?.unref?.();
  };

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    let nextDelay = pollMs;
    try {
      const scope: PublishScope = await resolveScope();
      if (!scope) return;
      const startedAt = Date.now();
      const result = await runOnce({
        scope,
        leaseOwner: `${publishPolicy.mode}-unattended:${process.pid}`,
        provider: createProvider(),
        executionEnabled: publishPolicy.executionEnabled,
        allowExternalProvider: publishPolicy.externalProviderEnabled,
        observer: event => {
          if (
            event.type === "claim_acquired" ||
            event.type === "execute_result" ||
            event.type === "receipt_persisted" ||
            event.type === "outbox_failed" ||
            event.type === "outbox_dead_letter" ||
            event.type === "finalized"
          ) {
            log({ level: "info", event: event.type, ...event });
          }
        },
      });
      log({
        level: "info",
        event: "cycle_complete",
        workspaceId: scope.workspaceId,
        workspaceNovelId: scope.workspaceNovelId,
        runId: scope.runId,
        claimed: result.claimed,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      nextDelay = Math.max(pollMs, ERROR_BACKOFF_MS);
      log({
        level: "error",
        event: "cycle_failed",
        ...safeErrorRecord(error),
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
      log({
        level: "info",
        event: "started",
        acceptanceTier: safety.tier,
        databaseName: safety.databaseName,
        pollMs,
      });
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
