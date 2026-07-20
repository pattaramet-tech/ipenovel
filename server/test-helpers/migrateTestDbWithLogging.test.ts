import { describe, it, expect } from "vitest";
import path from "node:path";
import { readMigrationJournal, runMigrationsWithLogging, type QueryableConnection } from "./migrateTestDbWithLogging";

const migrationsFolder = path.resolve(__dirname, "..", "..", "drizzle");

/**
 * A fake connection that understands just enough SQL shape to drive the
 * resume/skip loop (create-table-if-not-exists / select-last / insert),
 * and otherwise records every statement it was asked to run without
 * touching a real database - proves runMigrationsWithLogging's control
 * flow (which tags get attempted, in what order, and what happens on
 * failure) using the REAL journal/SQL files in drizzle/, without needing a
 * live TEST_DATABASE_URL.
 */
function fakeConnection(options: { existingMigrations?: Array<{ hash: string; created_at: number }>; failWhenSqlIncludes?: string } = {}) {
  const migrations = [...(options.existingMigrations ?? [])];
  const executedStatements: string[] = [];

  const conn: QueryableConnection = {
    async query(sql: string, params?: unknown[]) {
      const trimmed = sql.trim();
      if (/^create table if not exists `__drizzle_migrations`/i.test(trimmed)) {
        return [[], []];
      }
      if (/^select id, hash, created_at from `__drizzle_migrations`/i.test(trimmed)) {
        const last = [...migrations].sort((a, b) => b.created_at - a.created_at)[0];
        return [last ? [last] : [], []];
      }
      if (/^insert into `__drizzle_migrations`/i.test(trimmed)) {
        const [hash, createdAt] = params as [string, number];
        migrations.push({ hash, created_at: createdAt });
        return [{}, []];
      }
      if (options.failWhenSqlIncludes && sql.includes(options.failWhenSqlIncludes)) {
        const error: any = new Error(`simulated DDL failure containing "${options.failWhenSqlIncludes}"`);
        error.code = "ER_BAD_FIELD_ERROR";
        error.errno = 1054;
        throw error;
      }
      executedStatements.push(sql);
      return [{}, []];
    },
  };

  return { conn, migrations, executedStatements };
}

function recordingLogger() {
  const attempted: string[] = [];
  const completed: string[] = [];
  const failed: Array<{ tag: string; reason: string }> = [];
  return {
    attempted,
    completed,
    failed,
    logger: {
      onAttempt: (tag: string) => attempted.push(tag),
      onComplete: (tag: string) => completed.push(tag),
      onFailure: (tag: string, reason: string) => failed.push({ tag, reason }),
    },
  };
}

describe("readMigrationJournal", () => {
  it("includes the new 0028 repair migration, after 0027, with a strictly later timestamp", () => {
    const entries = readMigrationJournal(migrationsFolder);
    const idx27 = entries.find((e) => e.tag === "0027_add_daily_checkin_and_coupon_cap");
    const idx28 = entries.find((e) => e.tag === "0028_repair_episode_reader_schema");
    expect(idx27).toBeDefined();
    expect(idx28).toBeDefined();
    expect(idx28!.when).toBeGreaterThan(idx27!.when);
    expect(idx28!.idx).toBe(idx27!.idx + 1);
  });

  it("journal entries are in strictly increasing timestamp order (required for the resume-by-timestamp logic to be correct)", () => {
    const entries = readMigrationJournal(migrationsFolder);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].when).toBeGreaterThan(entries[i - 1].when);
    }
  });
});

describe("runMigrationsWithLogging - resume/skip semantics (matches drizzle-orm's own dialect.js exactly)", () => {
  it("attempts every journal entry, in journal order, for a genuinely empty migrations table", async () => {
    const { conn } = fakeConnection();
    const { attempted, completed, logger } = recordingLogger();

    await runMigrationsWithLogging(conn, migrationsFolder, logger);

    const journalTags = readMigrationJournal(migrationsFolder).map((e) => e.tag);
    expect(attempted).toEqual(journalTags);
    expect(completed).toEqual(journalTags);
  });

  it("resumes only migrations newer than the single latest recorded timestamp", async () => {
    const journal = readMigrationJournal(migrationsFolder);
    const idx27When = journal.find((e) => e.tag === "0027_add_daily_checkin_and_coupon_cap")!.when;
    // Computed from the real journal (not hardcoded to a specific later tag)
    // so this assertion doesn't need updating every time a new migration is
    // appended - it always means "everything strictly after 0027", whatever
    // that currently is.
    const expectedTags = journal.filter((e) => e.when > idx27When).map((e) => e.tag);

    const { conn } = fakeConnection({ existingMigrations: [{ hash: "prior", created_at: idx27When }] });
    const { attempted, logger } = recordingLogger();

    await runMigrationsWithLogging(conn, migrationsFolder, logger);

    expect(attempted).toEqual(expectedTags);
  });

  it("is a no-op when the latest recorded timestamp is already newer than every journal entry", async () => {
    const journal = readMigrationJournal(migrationsFolder);
    const newestWhen = journal[journal.length - 1].when;

    const { conn } = fakeConnection({ existingMigrations: [{ hash: "prior", created_at: newestWhen + 1 }] });
    const { attempted, logger } = recordingLogger();

    await runMigrationsWithLogging(conn, migrationsFolder, logger);

    expect(attempted).toEqual([]);
  });
});

describe("runMigrationsWithLogging - failure reporting", () => {
  it("logs the failing tag, does not mark it completed, and never attempts later migrations", async () => {
    // Fails on the first statement containing "ADD" - 0000/0001 contain no
    // ADD statements (pure CREATE TABLE) so they succeed first, and 0002 is
    // where this actually fails - proving real partial progress before a
    // failure, matching the incident's own "24 rows recorded, migration N
    // not recorded" evidence.
    const { conn } = fakeConnection({ failWhenSqlIncludes: "ADD" });
    const journal = readMigrationJournal(migrationsFolder);
    const { attempted, completed, failed, logger } = recordingLogger();

    await expect(runMigrationsWithLogging(conn, migrationsFolder, logger)).rejects.toThrow(/simulated DDL failure/);

    expect(failed.length).toBe(1);
    expect(attempted).toContain(failed[0].tag);
    expect(completed).not.toContain(failed[0].tag);
    // At least one earlier migration genuinely completed first - partial
    // progress before the failure is real, not just theoretical.
    expect(completed.length).toBeGreaterThan(0);
    // Nothing after the failing tag was ever attempted.
    const failedIdx = journal.findIndex((e) => e.tag === failed[0].tag);
    const laterTags = journal.slice(failedIdx + 1).map((e) => e.tag);
    for (const laterTag of laterTags) {
      expect(attempted).not.toContain(laterTag);
    }
  });

  it("the failure reason is a short, sanitized summary - never a raw error object, connection string, or credentials", async () => {
    const { conn } = fakeConnection({ failWhenSqlIncludes: "ADD" });
    const { failed, logger } = recordingLogger();

    await expect(runMigrationsWithLogging(conn, migrationsFolder, logger)).rejects.toThrow();

    expect(failed.length).toBe(1);
    expect(typeof failed[0].reason).toBe("string");
    expect(failed[0].reason.length).toBeLessThan(400);
    expect(failed[0].reason).not.toMatch(/mysql:\/\//);
    expect(failed[0].reason).not.toMatch(/password/i);
  });

  it("onAttempt/onComplete only ever receive the bare migration tag - never SQL text or connection details", async () => {
    const { conn } = fakeConnection();
    const { attempted, completed, logger } = recordingLogger();

    await runMigrationsWithLogging(conn, migrationsFolder, logger);

    for (const tag of [...attempted, ...completed]) {
      expect(tag).not.toMatch(/mysql:\/\//);
      expect(tag).not.toMatch(/CREATE TABLE|ALTER TABLE|SELECT/i);
      expect(tag).toMatch(/^\d{4}_/); // a plain migration tag, e.g. "0024_widen_episode_content_mediumtext"
    }
  });
});
