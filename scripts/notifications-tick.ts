// R40R66/R66R1/R66R2/R66R3 — External One-Shot Notification Scheduler
// (candidate CLI).
//
// Operator contract (docs/IPE-NOTIFICATIONS-SCHEDULER.md): perform exactly
// ONE notification delivery tick and exit. Intended to be invoked by an
// external scheduler (host cron / Coolify scheduled task) inside an
// environment where the gates are deliberately enabled.
//
// Required environment:
//   NOTIFICATIONS_ENABLED=true                - master gate (default OFF)
//   NOTIFICATIONS_DELIVERY_ENABLED=true       - delivery gate (default OFF)
//   DEPLOYMENT_ENVIRONMENT                    - deployment-identity gate
//     (R40R66R2): missing/unknown contexts refuse to run - a missing
//     context never skips the check.
//     - "production-staging": the repo staging-isolation gate
//       (assertProductionStagingDatabaseIsolation) requires DATABASE_URL
//       plus PRODUCTION_STAGING_DB_FINGERPRINT / PRODUCTION_DB_FINGERPRINT
//       and refuses on collision or identity mismatch.
//     - "local-test": TEST_DATABASE_URL required; the channel routes to
//       ensureVerifiedTestDb() (live DATABASE() = ipenovel_test check) and
//       NEVER falls back to DATABASE_URL (R40R66R3).
//
// Channel routing itself lives in server/notifications/tickCli.ts
// (openSchedulerDatabase) - this wrapper only adapts io and signals.
//
// Optional environment:
//   NOTIFICATIONS_CATALOG_FANOUT_ENABLED      - default OFF
//   NOTIFICATIONS_CHECKIN_REMINDERS_ENABLED   - default OFF
//
// Exit codes: 0 = disabled/busy/completed, 1 = failed, 130 = terminated by
// SIGTERM/SIGINT (in-flight state is lease-protected; the next successful
// tick resumes).
//
// This command mounts NO HTTP endpoint, NO timer and NO background worker,
// and it is never imported by the application server.
import fs from "node:fs";
import { runNotificationsTickCli } from "../server/notifications/tickCli";

// Synchronous stdout/stderr writes: process.exit() does not flush async
// pipe buffers, so a plain console.log before exit can be truncated. The
// operator summary line MUST reach the log in full.
function writeLine(fd: number, message: string): void {
  fs.writeSync(fd, message + "\n");
}

void runNotificationsTickCli({
  env: process.env,
  io: {
    log: message => writeLine(1, message),
    error: message => writeLine(2, message),
    exit: code => process.exit(code),
    onSignal: handler => {
      const wrapped = () => handler();
      process.on("SIGTERM", wrapped);
      process.on("SIGINT", wrapped);
      return () => {
        process.off("SIGTERM", wrapped);
        process.off("SIGINT", wrapped);
      };
    },
  },
});
