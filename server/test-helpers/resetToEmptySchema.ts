// A single, reusable, EXPLICITLY DESTRUCTIVE test-only helper that drops
// every view and every base table in the currently-connected schema,
// leaving __drizzle_migrations (and everything else) gone too - the
// "completely empty database" starting point a migration-chain integration
// test needs, and the ONLY thing that can genuinely recover a shared test
// database that has been left in a dirty/partial state.
//
// Why this exists: server/migration-0024-episode-schema-repair.integration
// .test.ts's scenario 1 ("a completely empty database migrates 0000
// through the newest migration successfully") used to enumerate
// information_schema.tables and issue `DROP TABLE IF EXISTS` for every row,
// with FOREIGN_KEY_CHECKS left at its default (1) and no distinction
// between base tables and views. Observed against a real MariaDB instance:
// that loop did not actually reach an empty schema (a DROP TABLE against an
// object still referenced by a live foreign key, or against a VIEW - which
// `DROP TABLE` cannot remove even with IF EXISTS, since the object exists
// but is the wrong type - throws and can leave later objects in iteration
// order, including `users`, untouched) even though no exception escaped the
// scenario itself. `runFullChain()` then failed immediately on migration
// 0000's `CREATE TABLE users` with ER_TABLE_EXISTS_ERROR. Worse, the
// scenario's own `finally` cleanup (restoreToFullyMigratedWithRetry) and
// even its "emergency" retry on a brand-new connection both called the
// exact same runFullChainAndVerify() - which only ever RUNS the migration
// chain, never resets anything - so both cleanup attempts failed
// identically against the same still-dirty schema.
//
// This file is the fix: a single function that actually guarantees zero
// base tables and zero views afterward, or throws - never a silent partial
// reset - reusable both at the START of scenario 1 (replacing its old
// ad-hoc loop) and as the FIRST step of the emergency-retry cleanup path
// (see restoreWithEmergencyRetry.ts's `runCleanup`), so the emergency path
// is a genuine reset, not the same failing "just run the chain again"
// operation repeated on still-dirty state.
import { assertSafeTestDatabaseUrl, EXPECTED_TEST_DATABASE_NAME } from "./testDatabaseGuard";

/**
 * Minimal structural shape this needs from a connection - just enough to
 * run raw SQL and read back rows, matching mysql2's `.query()` promise API
 * (`[rows, fields]`) closely enough that a real `mysql2.Connection` (used
 * throughout server/migration-0024-episode-schema-repair.integration.test.ts)
 * satisfies it directly, while still being trivially fakeable in a unit
 * test without a real database (see resetToEmptySchema.test.ts) - the same
 * "structural, not the concrete driver type" choice liveTestDatabaseCheck
 * .ts's `ExecutableDb` already makes for the identical reason.
 */
export interface QueryableConnection {
  query(sql: string): Promise<any>;
}

/**
 * MySQL/MariaDB identifiers in THIS repository are always plain
 * ASCII-alphanumeric-plus-underscore camelCase (every real table name in
 * drizzle/schema.ts matches `/^[A-Za-z0-9_]+$/` - confirmed by inspection,
 * and this is standard, unremarkable SQL identifier practice, not a
 * project-specific quirk). An object name read back from
 * information_schema that does NOT match this shape is refused outright
 * rather than backtick-escaped and interpolated anyway - "escape it
 * correctly" is a much larger, easier-to-get-wrong surface (embedded
 * backticks, NUL bytes, non-ASCII homoglyphs) than "refuse anything that
 * isn't a plain identifier in the first place", and every legitimate
 * object this function will ever actually encounter already satisfies the
 * simpler check. This is what "never interpolate an unvalidated
 * [identifier]" means in practice here - the SCHEMA name itself is never
 * interpolated at all (every query below uses the `DATABASE()` SQL
 * function, never a string-built schema-qualified name).
 */
function quoteSafeIdentifier(name: unknown, kind: "table" | "view"): string {
  if (typeof name !== "string" || name.length === 0 || name.length > 64 || !/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(
      `resetToEmptySchema: refusing to drop a ${kind} with an unsafe/unexpected identifier (${JSON.stringify(
        name
      )}) - this is never expected for a real object in this schema.`
    );
  }
  return `\`${name}\``;
}

/** mysql2 `.query()` resolves to a `[rows, fields]` tuple - unwrap defensively, matching the pattern already used throughout this test file/suite (see server/db.ts's own raw-execute unwraps). */
function unwrapRows(result: any): any[] {
  const rows = Array.isArray(result?.[0]) ? result[0] : result;
  return rows ?? [];
}

/**
 * Drops every view, then every base table, in the CURRENTLY CONNECTED
 * schema - and verifies afterward that both counts are genuinely zero.
 * Throws (never silently returns having done a partial reset) on any
 * safety-check failure, query failure, or post-reset verification failure.
 *
 * Safety gates, in order, before a single DROP statement runs:
 *  1. `testDatabaseUrl` (the caller's own `process.env.TEST_DATABASE_URL` -
 *     NEVER `process.env.DATABASE_URL`; this function has no fallback
 *     branch to any other environment variable, by construction - it
 *     doesn't read process.env itself at all) is parsed and validated via
 *     the shared assertSafeTestDatabaseUrl() - throws unless the parsed
 *     database name is exactly "ipenovel_test".
 *  2. A LIVE `SELECT DATABASE()` against `conn` itself is re-checked
 *     against the same exact name - the URL string alone is never trusted
 *     (see liveTestDatabaseCheck.ts's docstring for why a connection can
 *     resolve to a different live database than its URL claims).
 *
 * Never drops the database/schema itself - only objects INSIDE it - and
 * never issues `DROP DATABASE` anywhere in this file.
 */
export async function resetToEmptySchema(conn: QueryableConnection, testDatabaseUrl: string | undefined): Promise<void> {
  // Gate 1: the connection-string check. Deliberately takes the URL as an
  // explicit parameter (never reads process.env.TEST_DATABASE_URL or
  // process.env.DATABASE_URL itself) - the caller must pass
  // process.env.TEST_DATABASE_URL verbatim, making "no DATABASE_URL
  // fallback" true by construction rather than by convention.
  assertSafeTestDatabaseUrl(testDatabaseUrl);

  // Gate 2: the live check - re-verified against the ACTUAL connection
  // this function is about to run destructive DDL on, not just the string
  // that was used to open it.
  const liveNameRows = unwrapRows(await conn.query("SELECT DATABASE() AS name"));
  const liveName = liveNameRows[0]?.name;
  if (liveName !== EXPECTED_TEST_DATABASE_NAME) {
    throw new Error(
      `resetToEmptySchema: refusing to reset - a live "SELECT DATABASE()" query returned "${
        liveName ?? "(none)"
      }", not the required "${EXPECTED_TEST_DATABASE_NAME}". No DROP statement was issued.`
    );
  }

  await conn.query("SET FOREIGN_KEY_CHECKS = 0");
  try {
    // Views enumerated and dropped FIRST, via DROP VIEW (never DROP
    // TABLE - MySQL/MariaDB refuse to DROP TABLE an object that is
    // actually a view, even with IF EXISTS, since the object exists but
    // is the wrong type; this is the exact failure mode this file's
    // top-of-file docstring attributes the original bug to).
    // `information_schema.views` never lists base tables - no TABLE_TYPE
    // filter is needed on this query specifically.
    const viewRows = unwrapRows(
      await conn.query("SELECT TABLE_NAME AS name FROM information_schema.views WHERE TABLE_SCHEMA = DATABASE()")
    );
    for (const row of viewRows) {
      const identifier = quoteSafeIdentifier(row.name, "view");
      await conn.query(`DROP VIEW IF EXISTS ${identifier}`);
    }

    // THEN base tables - explicitly TABLE_TYPE = 'BASE TABLE' (never
    // relying on information_schema.tables also happening to exclude
    // views, and never re-attempting anything already handled above).
    // FOREIGN_KEY_CHECKS = 0 (set above) means drop ORDER among tables no
    // longer matters, regardless of any live foreign key between them
    // (e.g. authIdentities.userId -> users.id) - this is the actual fix
    // for the observed ER_TABLE_EXISTS_ERROR root cause.
    const tableRows = unwrapRows(
      await conn.query(
        "SELECT TABLE_NAME AS name FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'"
      )
    );
    for (const row of tableRows) {
      const identifier = quoteSafeIdentifier(row.name, "table");
      await conn.query(`DROP TABLE IF EXISTS ${identifier}`);
    }
  } finally {
    // Always restored, even if a DROP above threw - a half-reset schema
    // must never be left with foreign-key checks silently disabled for
    // whatever runs against this connection next.
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
  }

  // Post-reset verification: the reset is only ever reported as having
  // succeeded when information_schema itself confirms zero base tables
  // AND zero views remain - never inferred from "no DROP statement
  // threw", which is exactly the class of assumption the original bug
  // silently violated.
  const remainingTables = unwrapRows(
    await conn.query(
      "SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'"
    )
  );
  const remainingViews = unwrapRows(
    await conn.query("SELECT COUNT(*) AS cnt FROM information_schema.views WHERE TABLE_SCHEMA = DATABASE()")
  );
  const remainingTableCount = Number(remainingTables[0]?.cnt ?? -1);
  const remainingViewCount = Number(remainingViews[0]?.cnt ?? -1);
  if (remainingTableCount !== 0 || remainingViewCount !== 0) {
    throw new Error(
      `resetToEmptySchema: reset did not fully empty the schema - ${remainingTableCount} base table(s) and ` +
        `${remainingViewCount} view(s) remain after the drop pass. Never treated as a successful reset.`
    );
  }
}
