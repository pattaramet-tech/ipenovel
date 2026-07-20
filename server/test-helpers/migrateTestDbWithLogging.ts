// A logged, test-only reimplementation of drizzle-orm's migration resume
// loop - NOT used by production (scripts/migrate.mjs still calls
// drizzle-orm's own `migrate()` unchanged).
//
// Why this exists: drizzle-orm's `migrate()` (drizzle-orm/mysql2/migrator.js
// + mysql-core/dialect.js) is a single opaque call with no hook for
// per-migration progress - it silently loops over every pending journal
// entry inside one wrapping transaction (which, for MySQL, does not
// actually make DDL atomic - MySQL implicitly commits at each DDL
// statement regardless of any surrounding transaction; this is exactly why
// a failed migration N can leave migrations 0..N-1 permanently recorded
// even though the call that ran them "threw" - see
// docs/INCIDENT_MIGRATION_0024_EPISODES_CONTENT.md). To report which
// migration tag is being attempted, which completed, and which failed
// (sanitized, never raw SQL or credentials), this file re-reads the same
// journal and replicates the exact same resume/skip semantics, verified by
// reading drizzle-orm's installed source directly:
//
//   const dbMigrations = await session.all(
//     sql`select id, hash, created_at from ${migrationsTable} order by created_at desc limit 1`
//   );
//   const lastDbMigration = dbMigrations[0];
//   for (const migration of migrations) {
//     if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) { ... }
//   }
//
// Resume is decided ONLY by comparing each journal entry's `when` against
// the single latest recorded `created_at` - never by hash, never by tag
// name, never by file content. This module matches that exactly.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface MigrationJournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

/**
 * Reads drizzle/meta/_journal.json - the single source of truth for which
 * migrations exist and in what order, exactly as drizzle-orm's own
 * readMigrationFiles() does. A .sql file with no journal entry is invisible
 * here too, by design (matching production behavior precisely - this is
 * the exact mechanism the incident this module exists for was caused by).
 */
export function readMigrationJournal(migrationsFolder: string): MigrationJournalEntry[] {
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  return journal.entries;
}

export interface QueryableConnection {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface MigrationLogger {
  /** Called with only the migration tag (e.g. "0024_widen_episode_content_mediumtext") - never SQL, never credentials. */
  onAttempt(tag: string): void;
  onComplete(tag: string): void;
  /** `sanitizedReason` must already be redacted (see safeErrorSummary in scripts/migrate-test-db.ts) - never the raw error object. */
  onFailure(tag: string, sanitizedReason: string): void;
}

const MIGRATIONS_TABLE = "__drizzle_migrations";

/**
 * Applies every pending migration from `migrationsFolder`'s journal against
 * `conn`, in journal order, logging each attempt/completion/failure via
 * `logger`. Stops and rethrows on the first failure (matching drizzle's own
 * fail-fast behavior) - it does not attempt to continue past a broken
 * migration.
 */
export async function runMigrationsWithLogging(
  conn: QueryableConnection,
  migrationsFolder: string,
  logger: MigrationLogger
): Promise<void> {
  await conn.query(
    `create table if not exists \`${MIGRATIONS_TABLE}\` (id serial primary key, hash text not null, created_at bigint)`
  );

  const rows: any = await conn.query(
    `select id, hash, created_at from \`${MIGRATIONS_TABLE}\` order by created_at desc limit 1`
  );
  const resultRows = rows?.[0] ?? rows;
  const lastMigration = resultRows?.[0];

  const entries = readMigrationJournal(migrationsFolder);

  for (const entry of entries) {
    const isPending = !lastMigration || Number(lastMigration.created_at) < entry.when;
    if (!isPending) continue;

    logger.onAttempt(entry.tag);
    try {
      const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`);
      const rawSql = fs.readFileSync(sqlPath, "utf8");
      const statements = rawSql.split("--> statement-breakpoint");
      for (const statement of statements) {
        await conn.query(statement);
      }

      const hash = crypto.createHash("sha256").update(rawSql).digest("hex");
      await conn.query(`insert into \`${MIGRATIONS_TABLE}\` (\`hash\`, \`created_at\`) values (?, ?)`, [hash, entry.when]);
      logger.onComplete(entry.tag);
    } catch (error: any) {
      logger.onFailure(entry.tag, sanitizeMigrationError(error));
      throw error;
    }
  }
}

/**
 * Same shape as scripts/migrate.mjs's/scripts/migrate-test-db.ts's own
 * safeErrorSummary(): only the small set of fields mysql2 populates for
 * diagnosing a DDL failure (code/errno/sqlState/message, message capped and
 * never the full raw error object) - migration SQL never contains
 * connection strings or credentials in the first place (it's schema DDL
 * only), but this still avoids ever echoing a raw error object that could
 * carry driver-internal config data.
 */
export function sanitizeMigrationError(error: any): string {
  if (!error) return "unknown error";
  const parts: string[] = [];
  if (error.code) parts.push(`code=${error.code}`);
  if (error.errno) parts.push(`errno=${error.errno}`);
  if (error.sqlState) parts.push(`sqlState=${error.sqlState}`);
  if (error.message) parts.push(`message=${String(error.message).slice(0, 300)}`);
  return parts.length > 0 ? parts.join(" ") : "unknown error";
}

export function consoleMigrationLogger(prefix: string): MigrationLogger {
  return {
    onAttempt: (tag) => console.log(`${prefix} Attempting migration: ${tag}`),
    onComplete: (tag) => console.log(`${prefix} Completed migration: ${tag}`),
    onFailure: (tag, reason) => console.error(`${prefix} Migration failed: ${tag} (${reason})`),
  };
}
