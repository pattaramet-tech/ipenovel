import { redactSensitiveText, safeErrorSummary } from "../../scripts/lib/safeErrorSummary.mjs";
import { getDb } from "../db";
import { ensureVerifiedTestDb } from "../test-helpers/testDb";
import {
  assertProductionStagingDatabaseIsolation,
  PRODUCTION_STAGING_ENVIRONMENT,
} from "../_core/productionStagingSafety";
import {
  createControlledNotificationRuntime,
} from "./controlledRuntime";
import {
  DEFAULT_DELIVERY_LIMITS,
  type DeliveryLimits,
} from "./deliveryPolicy";
import {
  readNotificationRuntimeFlags,
  type NotificationTickOutcome,
  type NotificationRuntimeFlags,
} from "./runtimeGate";

/**
 * R40R66 — external one-shot scheduler CLI core (testable).
 *
 * Contract (docs/IPE-NOTIFICATIONS-SCHEDULER.md, R40R59 recommendation):
 *   - the process performs EXACTLY ONE delivery tick and then exits;
 *   - the master + delivery gates are evaluated from a FIXED environment
 *     snapshot BEFORE any database access — a disabled environment exits
 *     successfully without touching the database;
 *   - the production clock is the real clock; there is no timer, interval,
 *     HTTP endpoint or background work of any kind;
 *   - idempotency, concurrency (SKIP LOCKED claim + lease fencing), retry,
 *     dead-letter and limits are provided entirely by the already-qualified
 *     delivery store and runner — this module only wires and invokes them;
 *   - graceful shutdown: SIGTERM/SIGINT while a tick is in flight let the
 *     tick finish (the DB lease protects correctness; an abandoned lease is
 *     reclaimed after expiry) and the process then exits 130.
 */

export interface TickCliIo {
  log: (message: string) => void;
  error: (message: string) => void;
  /** Exits the process. Real implementation wraps process.exit. */
  exit: (code: number) => never;
  /** Registers a signal handler; returns an unregister function. */
  onSignal: (handler: () => void) => () => void;
}

export interface TickCliOptions {
  env: NodeJS.ProcessEnv;
  io: TickCliIo;
  clock?: () => Date;
  limits?: DeliveryLimits;
}

/** Exit codes (documented for operators/cron). */
export const TICK_EXIT_CODES = {
  /** Disabled by gate, busy (another tick in process), or completed. */
  OK: 0,
  /** Unexpected failure — operator should inspect logs; the outbox lease
   *  protects correctness and the next successful tick resumes work. */
  FAILURE: 1,
  /** Terminated by SIGTERM/SIGINT while a tick was in flight. */
  TERMINATED: 130,
} as const;

/**
 * R40R66R2: deployment-identity gate for the ENABLED scheduler channel -
 * runs AFTER the kill switch but BEFORE any database access.
 *
 *   - local-test        : disposable channel - TEST_DATABASE_URL required;
 *                         the wrapper's loadDatabase routes to
 *                         ensureVerifiedTestDb() which live-verifies
 *                         DATABASE() = ipenovel_test.
 *   - production-staging: the repo's own staging-isolation gate
 *                         (assertProductionStagingDatabaseIsolation) -
 *                         DATABASE_URL must resolve to the APPROVED staging
 *                         identity, fingerprints must exist and differ from
 *                         Production.
 *   - missing / unknown : FAIL - a missing deployment context must not skip
 *                         the check.
 *
 * (A production channel is a future Owner decision; it is deliberately not
 * reachable today.)
 */
export const SCHEDULER_DEPLOYMENT_ENVIRONMENTS = {
  staging: PRODUCTION_STAGING_ENVIRONMENT,
  localTest: "local-test",
} as const;

export function assertSchedulerDeliveryEnvironment(env: NodeJS.ProcessEnv): "production-staging" | "local-test" {
  const environment = env.DEPLOYMENT_ENVIRONMENT?.trim().toLowerCase();
  if (!environment) {
    throw new Error(
      "[scheduler-env] DEPLOYMENT_ENVIRONMENT is required when delivery is enabled (production-staging | local-test); refusing to run without an explicit deployment context"
    );
  }
  if (environment === SCHEDULER_DEPLOYMENT_ENVIRONMENTS.staging) {
    // Repo-owned staging-isolation gate (fingerprints, collision, identity).
    assertProductionStagingDatabaseIsolation(env);
    if (!env.DATABASE_URL?.trim()) {
      throw new Error("[scheduler-env] DATABASE_URL is required for the production-staging channel");
    }
    return SCHEDULER_DEPLOYMENT_ENVIRONMENTS.staging;
  }
  if (environment === SCHEDULER_DEPLOYMENT_ENVIRONMENTS.localTest) {
    if (!env.TEST_DATABASE_URL?.trim()) {
      throw new Error("[scheduler-env] TEST_DATABASE_URL is required for the local-test channel");
    }
    return SCHEDULER_DEPLOYMENT_ENVIRONMENTS.localTest;
  }
  throw new Error(
    `[scheduler-env] unknown DEPLOYMENT_ENVIRONMENT "${environment}" - allowed: production-staging | local-test`
  );
}

/**
 * R40R66R3: database routing per deployment channel.
 *
 *   - local-test  -> ensureVerifiedTestDb(): the ONLY path for the
 *     disposable channel; live-verifies DATABASE() = ipenovel_test before
 *     any write, and NEVER falls back to DATABASE_URL (a Production-shaped
 *     DATABASE_URL is ignored on this channel).
 *   - production-staging -> getDb(): the repo staging-isolation gate
 *     (assertProductionStagingDatabaseIsolation) has already proven the
 *     DATABASE_URL resolves to the approved staging identity.
 *
 * Single contact point per external writer; no lock-order interaction with
 * the delivery transaction's own locks.
 */
export async function openSchedulerDatabase(env: NodeJS.ProcessEnv): Promise<unknown> {
  const channel = assertSchedulerDeliveryEnvironment(env);
  if (channel === SCHEDULER_DEPLOYMENT_ENVIRONMENTS.localTest) {
    return ensureVerifiedTestDb();
  }
  return getDb();
}

export async function runNotificationsTickCli(options: TickCliOptions): Promise<void> {
  const { env, io } = options;
  const clock = options.clock ?? (() => new Date());
  const limits: DeliveryLimits = options.limits ?? DEFAULT_DELIVERY_LIMITS;

  let terminated = false;
  const onSignal = () => {
    if (terminated) return;
    terminated = true;
    io.log("[notifications-tick] signal received - finishing in-flight tick before exit (lease fencing protects correctness)");
  };
  const unregisterSignal = io.onSignal(onSignal);

  try {
    // FIXED environment snapshot - gates are decided here, before any
    // database access, and cannot change mid-run.
    const flags: NotificationRuntimeFlags = readNotificationRuntimeFlags(env);

    // Kill switch FIRST: a disabled environment exits 0 without touching
    // the database - the deployment-identity gate below is skipped because
    // there is nothing to authenticate.
    if (!flags.notificationsEnabled || !flags.deliveryEnabled) {
      io.log(JSON.stringify({
        status: "disabled",
        note: "NOTIFICATIONS_ENABLED and NOTIFICATIONS_DELIVERY_ENABLED must both be \"true\" to deliver",
      }));
      io.exit(TICK_EXIT_CODES.OK);
    }

    // R40R66R2: deployment-identity gate - AFTER the kill switch, BEFORE
    // the first database access through loadDatabase.
    assertSchedulerDeliveryEnvironment(env);

    // R40R66R3: channel routing lives HERE - the loadDatabase handed to the
    // runtime is the channel-aware opener, so a local-test run can never
    // fall through to DATABASE_URL.
    const runtime = createControlledNotificationRuntime({
      flags,
      loadDatabase: () => openSchedulerDatabase(env),
      clock,
      limits,
    });


    const outcome: NotificationTickOutcome = await runtime.tick();

    if (terminated) {
      io.log(JSON.stringify({ status: "terminated", signal: "SIGTERM/SIGINT", note: "in-flight tick state is lease-protected" }));
      io.exit(TICK_EXIT_CODES.TERMINATED);
    }

    switch (outcome.status) {
      case "disabled":
        io.log(JSON.stringify({
          status: "disabled",
          note: "NOTIFICATIONS_ENABLED and NOTIFICATIONS_DELIVERY_ENABLED must both be \"true\" to deliver",
        }));
        io.exit(TICK_EXIT_CODES.OK);
        break;
      case "busy":
        // Single-shot processes cannot overlap; reported for completeness.
        io.log(JSON.stringify({ status: "busy" }));
        io.exit(TICK_EXIT_CODES.OK);
        break;
      case "completed": {
        const r = outcome.result;
        io.log(JSON.stringify({
          status: "completed",
          claimed: r.claimed,
          recipientsCreated: r.created,
          alreadyExists: r.alreadyExists,
          dismissed: r.dismissed,
          ineligible: r.ineligible,
          completed: r.completed,
          partial: r.partial,
          retried: r.retried,
          deadLettered: r.deadLettered,
        }));
        io.exit(TICK_EXIT_CODES.OK);
        break;
      }
    }
  } catch (error) {
    // A deliberate exit (disabled/completed/busy/terminated) re-throws its
    // sentinel through here - only UNEXPECTED failures map to exit 1.
    if ((error as any)?.isExitCall) throw error;
    io.error(JSON.stringify({
      status: "failed",
      error: redactSensitiveText(safeErrorSummary(error)).replace(
        /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
        "[redacted-token]"
      ),
      note: "check notificationOutbox leases - abandoned leases are reclaimed after expiry (deliveryPolicy lease window)",
    }));
    io.exit(TICK_EXIT_CODES.FAILURE);
  } finally {
    unregisterSignal();
  }
}
