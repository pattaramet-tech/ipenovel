// A single, reusable, EXPLICITLY DESTRUCTIVE test-only helper that puts a
// disposable test database into the EXACT state "as if only migrations
// 0000 through `cutoffTag` had ever run" - both the physical schema AND
// the __drizzle_migrations bookkeeping - never just the bookkeeping alone.
//
// Why this exists: server/migration-0024-episode-schema-repair.integration
// .test.ts's scenarios simulating an earlier baseline (e.g. "only 0000-0023
// ever ran") used to call rewindMigrationHistoryAfter(), which deletes
// __drizzle_migrations rows recorded after a cutoff timestamp - but does
// NOT touch the physical schema objects any LATER migration already
// created (e.g. migration 0033's `authIdentities` table, 0034's account-
// recovery tables, 0032's `coupons.scope`/`ownerUserId` columns). A
// scenario would then manually drop only the few objects it happened to
// care about (episodes' reader columns, episodePurchases, readingProgress)
// and call runFullChain() - which, with the journal rewound, treats EVERY
// migration after the cutoff as pending again, including ones whose
// physical objects were never dropped. Observed against a real MariaDB
// instance: migration 0033's `CREATE TABLE authIdentities` failed with
// ER_TABLE_EXISTS_ERROR because the table already physically existed,
// even though its journal row had been deleted.
//
// The fix: never rewind bookkeeping in isolation. Reset the schema to
// GENUINELY empty (via resetToEmptySchema(), which already enforces every
// TEST_DATABASE_URL/live-database safety gate and never issues DROP
// DATABASE), then run ONLY migrations 0000 through `cutoffTag` (via
// runMigrationsWithLogging's `untilTag` option) - so the physical schema
// and the migration journal are ALWAYS in the same, real, verified state
// for that exact cutoff. There is no way for a later migration's objects
// to be "left behind", because they were never created in the first
// place.
import { resetToEmptySchema } from "./resetToEmptySchema";
import {
  runMigrationsWithLogging,
  readMigrationJournal,
  consoleMigrationLogger,
  type QueryableConnection as MigrationCutoffConnection,
} from "./migrateTestDbWithLogging";

export type { MigrationCutoffConnection };

/**
 * Resets `conn`'s ENTIRE schema to empty, then runs migrations 0000
 * through (and including) the journal entry tagged `cutoffTag` - never any
 * migration after it - and finally re-verifies, via a direct query against
 * `__drizzle_migrations` itself (never trusting "runMigrationsWithLogging
 * didn't throw" alone), that the live high-water mark equals that exact
 * cutoff entry's `when` timestamp.
 *
 * Throws (never silently proceeds) when:
 *  - `cutoffTag` does not exist anywhere in the journal at `migrationsFolder`;
 *  - `resetToEmptySchema`'s own safety gates refuse (see its own
 *    docstring - wrong/missing TEST_DATABASE_URL, live database mismatch);
 *  - any migration up to the cutoff fails to apply;
 *  - the post-run live high-water mark does not exactly equal the cutoff's
 *    `when` value (would indicate either a migration beyond the cutoff
 *    somehow ran, or the run stopped short).
 *
 * Never issues `DROP DATABASE` (resetToEmptySchema() never does either).
 */
export async function resetToMigrationCutoff(
  conn: MigrationCutoffConnection,
  testDatabaseUrl: string | undefined,
  migrationsFolder: string,
  cutoffTag: string
): Promise<void> {
  const journal = readMigrationJournal(migrationsFolder);
  const cutoffEntry = journal.find((entry) => entry.tag === cutoffTag);
  if (!cutoffEntry) {
    throw new Error(
      `resetToMigrationCutoff: cutoff tag "${cutoffTag}" was not found in the migration journal at "${migrationsFolder}" - refusing to reset to an unknown baseline.`
    );
  }

  // Gate + genuine empty-schema wipe - never DROP DATABASE, always
  // TEST_DATABASE_URL-only with a live "SELECT DATABASE()" re-check (see
  // resetToEmptySchema's own docstring for the full guarantee).
  await resetToEmptySchema(conn, testDatabaseUrl);

  // Run ONLY 0000..cutoffTag - migrations after the cutoff are never even
  // attempted, so their objects can never exist afterward, by
  // construction (never relying on any migration happening to be
  // idempotent).
  await runMigrationsWithLogging(conn, migrationsFolder, consoleMigrationLogger("[resetToMigrationCutoff]"), {
    untilTag: cutoffTag,
  });

  // Re-verify directly against the database - never inferred merely from
  // "runMigrationsWithLogging resolved".
  const rows: any = await conn.query("SELECT MAX(created_at) AS latest FROM `__drizzle_migrations`");
  const resultRows = rows?.[0] ?? rows;
  const liveLatest = Number(resultRows?.[0]?.latest ?? -1);
  if (liveLatest !== cutoffEntry.when) {
    throw new Error(
      `resetToMigrationCutoff: expected the migration journal high-water mark to be exactly ${cutoffEntry.when} ` +
        `(cutoff "${cutoffTag}"), found ${liveLatest} - the database is not at the requested exact-cutoff baseline.`
    );
  }
}
