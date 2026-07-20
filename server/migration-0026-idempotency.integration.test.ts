import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import { buildTestDbConnectionOptions } from "./test-helpers/testDbConnectionOptions";
import { runMigrationsWithLogging, consoleMigrationLogger, readMigrationJournal } from "./test-helpers/migrateTestDbWithLogging";

/**
 * Real-database coverage for the migration 0026 repair. See
 * drizzle/0026_add_homepage_performance_indexes.sql's header comment: the
 * three CREATE INDEX statements it originally shipped with were unguarded,
 * so any database whose __drizzle_migrations high-water mark gets rewound
 * to before 0026 while the indexes it created are still physically present
 * (exactly what the migration-0024 repair's integration tests do to other
 * migrations, to reproduce "history says earlier, schema says later"
 * states) hit a duplicate-key-name error the moment 0026 was attempted
 * again.
 *
 * Follows the same conventions as server/migration-0027-idempotency.
 * integration.test.ts and server/migration-0024-episode-schema-repair.
 * integration.test.ts: a single dedicated mysql2 connection (never a pool,
 * since 0026's guarded statements use session-scoped @variables across
 * SET/PREPARE/EXECUTE), self-guarded per test (`if (!process.env.
 * TEST_DATABASE_URL) return`), relying on the integration project's own
 * globalSetup for the live "SELECT DATABASE()" == "ipenovel_test" check
 * before any test file in this project loads.
 */

const migrationsFolder = path.resolve(__dirname, "..", "drizzle");
const migrationSql = fs.readFileSync(path.join(migrationsFolder, "0026_add_homepage_performance_indexes.sql"), "utf8");
const statements = migrationSql
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

const INDEXES: Array<{ table: string; name: string; columns: string[] }> = [
  { table: "episodes", name: "episodes_isPublished_createdAt_idx", columns: ["isPublished", "createdAt"] },
  { table: "novels", name: "novels_publicationStatus_createdAt_idx", columns: ["publicationStatus", "createdAt"] },
  { table: "purchases", name: "purchases_novelId_idx", columns: ["novelId"] },
];

async function connect(): Promise<mysql.Connection | null> {
  if (!process.env.TEST_DATABASE_URL) return null;
  return mysql.createConnection(buildTestDbConnectionOptions(process.env.TEST_DATABASE_URL));
}

async function runMigrationStatements(conn: mysql.Connection): Promise<void> {
  for (const statement of statements) {
    await conn.query(statement);
  }
}

async function indexExists(conn: mysql.Connection, tableName: string, indexName: string): Promise<boolean> {
  const [rows]: any = await conn.query(
    `SELECT COUNT(*) as cnt FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [tableName, indexName]
  );
  return Number(rows[0].cnt) > 0;
}

async function indexColumns(conn: mysql.Connection, tableName: string, indexName: string): Promise<string[]> {
  const [rows]: any = await conn.query(
    `SELECT COLUMN_NAME as columnName FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? ORDER BY SEQ_IN_INDEX`,
    [tableName, indexName]
  );
  return rows.map((r: any) => r.columnName);
}

async function dropIndexIfExists(conn: mysql.Connection, tableName: string, indexName: string): Promise<void> {
  if (await indexExists(conn, tableName, indexName)) {
    await conn.query(`DROP INDEX \`${indexName}\` ON \`${tableName}\``);
  }
}

async function dropAllThreeIndexes(conn: mysql.Connection): Promise<void> {
  for (const idx of INDEXES) {
    await dropIndexIfExists(conn, idx.table, idx.name);
  }
}

async function runFullChain(conn: mysql.Connection) {
  await runMigrationsWithLogging(conn, migrationsFolder, consoleMigrationLogger("[integration-test]"));
}

/** Always run in a finally block: guarantees every test leaves all three indexes present, regardless of what it intentionally dropped. */
async function restoreAllIndexes(conn: mysql.Connection): Promise<void> {
  try {
    await runMigrationStatements(conn);
  } catch (error: any) {
    console.error(
      "[migration-0026 integration test] restoreAllIndexes: cleanup failed - test database may be left dirty:",
      error?.message ?? error
    );
  }
}

const journal = readMigrationJournal(migrationsFolder);
const idx0026When = journal.find((e) => e.tag === "0026_add_homepage_performance_indexes")!.when;

describe("migration 0026 idempotency (real disposable test database)", () => {
  it("1. none of the three performance indexes exist - migration creates all three", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runMigrationStatements(conn); // known-good baseline
      await dropAllThreeIndexes(conn);
      for (const idx of INDEXES) {
        expect(await indexExists(conn, idx.table, idx.name)).toBe(false);
      }

      await expect(runMigrationStatements(conn)).resolves.not.toThrow();

      for (const idx of INDEXES) {
        expect(await indexExists(conn, idx.table, idx.name)).toBe(true);
      }
    } finally {
      await restoreAllIndexes(conn!);
      await conn!.end();
    }
  }, 60000);

  it("2. only one index already exists - migration creates exactly the missing two", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runMigrationStatements(conn);
      await dropAllThreeIndexes(conn);
      await conn.query("CREATE INDEX `episodes_isPublished_createdAt_idx` ON `episodes` (`isPublished`,`createdAt`)");

      expect(await indexExists(conn, "episodes", "episodes_isPublished_createdAt_idx")).toBe(true);
      expect(await indexExists(conn, "novels", "novels_publicationStatus_createdAt_idx")).toBe(false);
      expect(await indexExists(conn, "purchases", "purchases_novelId_idx")).toBe(false);

      await expect(runMigrationStatements(conn)).resolves.not.toThrow();

      for (const idx of INDEXES) {
        expect(await indexExists(conn, idx.table, idx.name)).toBe(true);
      }
    } finally {
      await restoreAllIndexes(conn!);
      await conn!.end();
    }
  }, 60000);

  it("3. two indexes already exist - migration creates exactly the missing one", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runMigrationStatements(conn);
      await dropIndexIfExists(conn, "purchases", "purchases_novelId_idx");

      expect(await indexExists(conn, "episodes", "episodes_isPublished_createdAt_idx")).toBe(true);
      expect(await indexExists(conn, "novels", "novels_publicationStatus_createdAt_idx")).toBe(true);
      expect(await indexExists(conn, "purchases", "purchases_novelId_idx")).toBe(false);

      await expect(runMigrationStatements(conn)).resolves.not.toThrow();

      for (const idx of INDEXES) {
        expect(await indexExists(conn, idx.table, idx.name)).toBe(true);
      }
    } finally {
      await restoreAllIndexes(conn!);
      await conn!.end();
    }
  }, 60000);

  it("4. all three indexes already exist - migration is a guarded no-op", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runMigrationStatements(conn);
      for (const idx of INDEXES) {
        expect(await indexExists(conn, idx.table, idx.name)).toBe(true);
      }

      await expect(runMigrationStatements(conn)).resolves.not.toThrow();

      for (const idx of INDEXES) {
        expect(await indexExists(conn, idx.table, idx.name)).toBe(true);
      }
    } finally {
      await restoreAllIndexes(conn!);
      await conn!.end();
    }
  }, 60000);

  it("5. migration history is rewound to before 0026 while the indexes remain in place - the real duplicate-index failure mode", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runFullChain(conn); // full chain, including 0026, recorded for real
      for (const idx of INDEXES) {
        expect(await indexExists(conn, idx.table, idx.name)).toBe(true);
      }

      // Rewind ONLY the resume high-water mark back to just before 0026 -
      // the indexes themselves are intentionally left in place, reproducing
      // exactly the state the integration test suite's history-rewinding
      // scenarios (e.g. migration-0024's tests) put a shared database in.
      await conn.query(`DELETE FROM \`__drizzle_migrations\` WHERE created_at >= ?`, [idx0026When]);

      // drizzle's migrator will now see 0026 (and everything after it) as
      // pending again - this must not throw a duplicate-key-name error.
      await expect(runFullChain(conn)).resolves.not.toThrow();

      for (const idx of INDEXES) {
        expect(await indexExists(conn, idx.table, idx.name)).toBe(true);
      }
    } finally {
      await restoreAllIndexes(conn!);
      await conn!.end();
    }
  }, 60000);

  it("6. raw 0026 SQL is executed twice directly, bypassing the journal entirely", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runMigrationStatements(conn);
      await expect(runMigrationStatements(conn)).resolves.not.toThrow();

      for (const idx of INDEXES) {
        expect(await indexExists(conn, idx.table, idx.name)).toBe(true);
      }
    } finally {
      await restoreAllIndexes(conn!);
      await conn!.end();
    }
  }, 60000);

  it("7. final index definitions agree with drizzle/schema.ts", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runMigrationStatements(conn);

      for (const idx of INDEXES) {
        expect(await indexExists(conn, idx.table, idx.name)).toBe(true);
        expect(await indexColumns(conn, idx.table, idx.name)).toEqual(idx.columns);
      }
    } finally {
      await restoreAllIndexes(conn!);
      await conn!.end();
    }
  }, 60000);
});
