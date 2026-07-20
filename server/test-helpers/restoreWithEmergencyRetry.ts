// Pure control-flow for the "restore to a known-good state, and if that
// fails, retry once through a freshly live-verified connection" pattern
// used by integration test files' cleanup helpers (e.g.
// server/migration-0024-episode-schema-repair.integration.test.ts's
// restoreToFullyMigrated()). Extracted so the retry/throw semantics can be
// unit-tested with injected fakes - see restoreWithEmergencyRetry.test.ts -
// without a real database, and reused by any other integration test file
// that needs the same guarantee later.
//
// The property this exists to guarantee: a cleanup failure must never be
// silently swallowed, and the ORIGINAL ("primary") failure must never be
// discarded, even when a second, different failure happens during the
// retry - see docs/TEST_INFRASTRUCTURE.md's "no test/reset/seed/cleanup/
// migration command may silently ignore a failure" requirement.
import { sanitizeMigrationError } from "./migrateTestDbWithLogging";

export interface EmergencyRetryDeps<TConn> {
  /** Opens a brand-new connection for the retry attempt, or null if none is configured (e.g. no TEST_DATABASE_URL). Never a pooled/shared connection - the primary attempt already used one and may have left it in a bad state. */
  connect: () => Promise<TConn | null>;
  /** Runs a live "SELECT DATABASE()"-equivalent check and returns the actual database name (or null if it can't be determined). */
  queryLiveDatabaseName: (conn: TConn) => Promise<string | null>;
  /** Performs the actual restore/cleanup work against `conn`. */
  runCleanup: (conn: TConn) => Promise<void>;
  /** Closes `conn`, regardless of whether the retry succeeded or failed. */
  closeConnection: (conn: TConn) => Promise<void>;
  /** The exact database name the live check must match before any destructive retry runs - e.g. EXPECTED_TEST_DATABASE_NAME ("ipenovel_test"). */
  expectedDatabaseName: string;
}

/** Marks a thrown error as "the live database-name guard refused to proceed" - kept distinct from a genuine cleanup failure so callers can tell the two apart (see restoreToFullyMigratedWithRetry's case-4-vs-case-5 split). */
class EmergencyResetGuardError extends Error {}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Behavior:
 * 1. Primary cleanup succeeds -> returns normally.
 * 2. Primary cleanup fails -> logs a sanitized message, opens a new
 *    connection via `deps.connect`, verifies its live database name via
 *    `deps.queryLiveDatabaseName`, and retries cleanup via `deps.runCleanup`.
 * 3. No emergency connection can be created -> throws (does not return
 *    successfully); the primary failure is preserved in the thrown message.
 * 4. The live database-name check fails (doesn't match
 *    `deps.expectedDatabaseName`) -> throws immediately, without attempting
 *    `deps.runCleanup`; the primary failure is preserved in the thrown
 *    message.
 * 5. The emergency cleanup itself fails -> closes the emergency connection,
 *    then throws an AggregateError containing both the primary and the
 *    emergency failure.
 * 6. The emergency cleanup succeeds -> closes the emergency connection and
 *    returns normally.
 *
 * Never logs a URL, credentials, or raw connection configuration - only
 * `sanitizeMigrationError()`'s bounded code/errno/sqlState/message summary.
 */
export async function restoreToFullyMigratedWithRetry<TConn>(
  primaryCleanup: () => Promise<void>,
  deps: EmergencyRetryDeps<TConn>
): Promise<void> {
  let primaryError: unknown;
  try {
    await primaryCleanup();
    return; // case 1
  } catch (error) {
    primaryError = error;
  }

  console.error(
    "[restoreToFullyMigratedWithRetry] primary cleanup failed, attempting a verified emergency reset:",
    sanitizeMigrationError(primaryError)
  );

  const emergencyConn = await deps.connect();
  if (!emergencyConn) {
    // case 3: no connection available at all - throw, never return successfully.
    throw new Error(
      "restoreToFullyMigratedWithRetry: emergency reset unavailable - no connection could be created. " +
        `Primary cleanup failure: ${sanitizeMigrationError(primaryError)}`
    );
  }

  try {
    const liveName = await deps.queryLiveDatabaseName(emergencyConn);
    if (liveName !== deps.expectedDatabaseName) {
      // case 4: guard failure - throw immediately, not combined into an AggregateError.
      throw new EmergencyResetGuardError(
        `restoreToFullyMigratedWithRetry: refusing emergency reset - live database check returned "${liveName ?? "(none)"}", ` +
          `not "${deps.expectedDatabaseName}". Primary cleanup failure: ${sanitizeMigrationError(primaryError)}`
      );
    }

    await deps.runCleanup(emergencyConn);
    // case 6: falls through - closed and returned normally below.
  } catch (emergencyError) {
    if (emergencyError instanceof EmergencyResetGuardError) {
      throw emergencyError; // case 4, unwrapped
    }
    // case 5: genuine emergency cleanup failure - preserve BOTH failures.
    throw new AggregateError(
      [toError(primaryError), toError(emergencyError)],
      "restoreToFullyMigratedWithRetry: both the primary cleanup and the emergency reset failed - the database may be left in a dirty state."
    );
  } finally {
    await deps.closeConnection(emergencyConn);
  }
}
