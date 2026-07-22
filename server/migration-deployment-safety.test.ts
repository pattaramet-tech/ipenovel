import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(__dirname, "..");

/**
 * Production incident: the daily check-in migration (0027) never ran
 * automatically, because nothing in the deploy pipeline ever executed
 * migrations - `pnpm start` booted the server directly against whatever
 * schema production already had. See docs/DAILY_CHECKIN_DEPLOYMENT_FIX.md.
 *
 * These tests are regression tripwires for that specific failure mode:
 * they assert the deploy pipeline actually runs migrations, that it only
 * ever runs (never generates) them, and that the migration itself is safe
 * to re-run in any partial-application state. Most of these are pure
 * file/config assertions - no DB connection is needed to prove "the start
 * script calls a migration step" or "the migration file is idempotent".
 */

describe("Migration journal and schema (no DB required - static file checks)", () => {
  it("journal has an entry for migration 0027 (daily check-in + coupon cap)", () => {
    const journal = JSON.parse(fs.readFileSync(path.join(repoRoot, "drizzle/meta/_journal.json"), "utf8"));
    const entry = journal.entries.find((e: any) => e.tag === "0027_add_daily_checkin_and_coupon_cap");
    expect(entry).toBeDefined();
    expect(entry.idx).toBe(27);
  });

  it("the migration file for 0027 exists and matches the journal tag", () => {
    const journal = JSON.parse(fs.readFileSync(path.join(repoRoot, "drizzle/meta/_journal.json"), "utf8"));
    const entry = journal.entries.find((e: any) => e.tag === "0027_add_daily_checkin_and_coupon_cap");
    const migrationPath = path.join(repoRoot, "drizzle", `${entry.tag}.sql`);
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it("schema.ts defines dailyCheckins with a status column and coupons.maxDiscountAmount", () => {
    const schema = fs.readFileSync(path.join(repoRoot, "drizzle/schema.ts"), "utf8");
    expect(schema).toMatch(/export const dailyCheckins = mysqlTable/);
    expect(schema).toMatch(/status:\s*mysqlEnum\("status",\s*\[.*"issued".*"used".*"void".*\]\)/);
    expect(schema).toMatch(/maxDiscountAmount:\s*decimal\("maxDiscountAmount"/);
  });

  it("migration 0027 is idempotent: uses CREATE TABLE IF NOT EXISTS, not a bare CREATE TABLE", () => {
    const sql = fs.readFileSync(path.join(repoRoot, "drizzle/0027_add_daily_checkin_and_coupon_cap.sql"), "utf8");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS `dailyCheckins`/);
    // No bare, unguarded "CREATE TABLE `dailyCheckins`" without "IF NOT EXISTS" immediately after it.
    expect(sql).not.toMatch(/CREATE TABLE `dailyCheckins` \(/);
  });

  it("migration 0027's ALTER TABLE (coupons.maxDiscountAmount) is guarded by an information_schema check, not run unconditionally", () => {
    const sql = fs.readFileSync(path.join(repoRoot, "drizzle/0027_add_daily_checkin_and_coupon_cap.sql"), "utf8");
    expect(sql).toMatch(/information_schema\.columns/);
    expect(sql).toMatch(/column_name = 'maxDiscountAmount'/);
    expect(sql).toMatch(/PREPARE ipenovel_0027_alter_stmt/);
    expect(sql).toMatch(/DEALLOCATE PREPARE ipenovel_0027_alter_stmt/);
    // The raw ALTER TABLE statement must only appear inside the quoted
    // dynamic-SQL string (single-quoted), never as a directly-executable
    // top-level statement.
    expect(sql).not.toMatch(/^ALTER TABLE `coupons` ADD `maxDiscountAmount`/m);
  });

  it("migration 0027's CREATE INDEX is guarded by an information_schema check, not run unconditionally", () => {
    const sql = fs.readFileSync(path.join(repoRoot, "drizzle/0027_add_daily_checkin_and_coupon_cap.sql"), "utf8");
    expect(sql).toMatch(/information_schema\.statistics/);
    expect(sql).toMatch(/index_name = 'dailyCheckins_userId_idx'/);
    expect(sql).not.toMatch(/^CREATE INDEX `dailyCheckins_userId_idx`/m);
  });
});

describe("Deploy pipeline runs migrations safely (no DB required - static config checks)", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

  // The migration step used to be chained into `start` with `&&`. That was
  // necessary but NOT sufficient: a later production incident proved the
  // hosting platform can start the app with `node dist/index.js` directly,
  // bypassing package.json entirely - so nothing migrated, production stayed
  // at migration 0023, and the app queried a table that did not exist.
  //
  // Enforcement therefore moved INTO the built executable
  // (server/_core/startupMigrations.ts, awaited by server/_core/index.ts
  // before any port is opened). These assertions are strengthened
  // accordingly: they now require the guarantee to hold for a bare
  // `node dist/index.js`, which the old `&&` chain could not provide, and
  // additionally require that migrations are not run twice.
  it("the built server executable enforces migrations itself, before it can listen", () => {
    const bootstrap = fs.readFileSync(path.join(repoRoot, "server/_core/index.ts"), "utf8");
    const helper = fs.readFileSync(path.join(repoRoot, "server/_core/startupMigrations.ts"), "utf8");

    // The bootstrap awaits the migration step before constructing Express
    // or announcing that it is listening.
    const migrateIndex = bootstrap.indexOf("await ensureDatabaseMigrated()");
    const expressIndex = bootstrap.indexOf("const app = express()");
    const runningIndex = bootstrap.indexOf("Server running on");
    expect(migrateIndex).toBeGreaterThanOrEqual(0);
    expect(expressIndex).toBeGreaterThan(migrateIndex);
    expect(runningIndex).toBeGreaterThan(migrateIndex);

    // It delegates to the one migration implementation rather than
    // reimplementing drizzle's migrator inside the server.
    expect(helper).toMatch(/scripts.{0,4}migrate\.mjs/);
    expect(bootstrap).not.toMatch(/drizzle-orm\/mysql2\/migrator/);

    // A failed migration must stop startup with a non-zero exit status.
    expect(bootstrap).toMatch(/process\.exitCode\s*=\s*1/);
  });

  it("start boots the self-migrating executable and does not run the migration a second time", () => {
    expect(pkg.scripts.start).toMatch(/dist\/index\.js/);
    // Exactly one migration path: the executable's own. Chaining
    // scripts/migrate.mjs here as well would run migrations twice per boot.
    expect(pkg.scripts.start).not.toMatch(/scripts\/migrate\.mjs/);
  });

  it("start script never calls drizzle-kit generate (must not generate new migrations during deploy)", () => {
    expect(pkg.scripts.start).not.toMatch(/drizzle-kit generate/);
  });

  it("a dedicated db:migrate script exists and only migrates, never generates", () => {
    expect(pkg.scripts["db:migrate"]).toBeDefined();
    expect(pkg.scripts["db:migrate"]).not.toMatch(/generate/);
  });

  it("db:push (which does call generate) is not referenced by start or db:migrate", () => {
    expect(pkg.scripts.start).not.toMatch(/db:push/);
    expect(pkg.scripts["db:migrate"]).not.toMatch(/db:push/);
  });

  it("drizzle-kit is a devDependency, not a runtime dependency - scripts/migrate.mjs must not import/require its CLI", () => {
    expect(pkg.devDependencies["drizzle-kit"]).toBeDefined();
    expect(pkg.dependencies["drizzle-kit"]).toBeUndefined();
    const migrateScript = fs.readFileSync(path.join(repoRoot, "scripts/migrate.mjs"), "utf8");
    // Only the actual code needs to avoid drizzle-kit - the file's own
    // header comment legitimately explains *why* in prose, which mentions
    // the package by name.
    expect(migrateScript).not.toMatch(/(?:from|require\()\s*["']drizzle-kit/);
    expect(migrateScript).toMatch(/from "drizzle-orm\/mysql2\/migrator"/);
  });
});

describe("scripts/migrate.mjs behavior (runs the real script as a child process)", () => {
  it("fails loudly (non-zero exit) when DATABASE_URL is not set, instead of silently continuing", () => {
    const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts/migrate.mjs")], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: "" },
      encoding: "utf8",
      timeout: 15000,
    });
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
  });

  it("never prints DATABASE_URL's value even when set, in either the failure or success log path", () => {
    const fakeSecretUrl = "mysql://produser:SuperSecretPassword123@db.internal.example.com:3306/ipenovel";
    const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts/migrate.mjs")], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: fakeSecretUrl },
      encoding: "utf8",
      timeout: 15000,
    });
    const combinedOutput = `${result.stdout || ""}${result.stderr || ""}`;
    expect(combinedOutput).not.toContain("SuperSecretPassword123");
    expect(combinedOutput).not.toContain(fakeSecretUrl);
  });
});
