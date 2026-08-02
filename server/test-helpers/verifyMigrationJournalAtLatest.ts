// Shared "is this connection's __drizzle_migrations genuinely at the
// newest journal entry" check - the minimum meaningful proof that a
// migration-integration test file's emergency-reset cleanup path (see
// resetToMigrationCutoff.ts's own docstring, and every
// server/migration-*.integration.test.ts file's emergencyResetAndRestore())
// actually finished, rather than merely "didn't throw". Never inferred
// from "runMigrationsWithLogging resolved" alone - that call resolving
// only means every migration IT attempted succeeded, not that the
// database ended up at the database's own newest migration (a stale
// migrationsFolder reference, a mid-run process crash recovered from
// elsewhere, or any other divergence would still let it resolve).
import { readMigrationJournal } from "./migrateTestDbWithLogging";

export interface QueryableConnection {
  query(sql: string): Promise<any>;
}

/** mysql2 `.query()` resolves to a `[rows, fields]` tuple - unwrap defensively, matching every other raw-query helper in this test suite. */
function unwrapRows(result: any): any[] {
  const rows = Array.isArray(result?.[0]) ? result[0] : result;
  return rows ?? [];
}

/**
 * Throws unless a live query against `conn`'s `__drizzle_migrations` table
 * reports a high-water mark (`MAX(created_at)`) exactly equal to the
 * NEWEST entry in `migrationsFolder`'s own journal - i.e. every migration
 * that exists today has genuinely been recorded as applied, nothing more
 * and nothing less.
 */
export async function verifyMigrationJournalAtLatest(conn: QueryableConnection, migrationsFolder: string): Promise<void> {
  const journal = readMigrationJournal(migrationsFolder);
  const latestWhen = journal[journal.length - 1].when;

  const rows = unwrapRows(await conn.query("SELECT MAX(created_at) AS latest FROM `__drizzle_migrations`"));
  const liveLatest = Number(rows[0]?.latest ?? -1);

  if (liveLatest !== latestWhen) {
    throw new Error(
      `verifyMigrationJournalAtLatest: expected the migration journal high-water mark to be exactly ${latestWhen} ` +
        `(the newest entry in "${migrationsFolder}"), found ${liveLatest} - the database is not at the ` +
        `fully-migrated baseline.`
    );
  }
}
