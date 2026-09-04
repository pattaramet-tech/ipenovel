// Safe production migration runner. Always invoked as `node scripts/migrate.mjs`
// (package.json's db:migrate, server/_core/startupMigrations.ts's spawn) or
// imported directly for unit-testing findMissingSchemaObjects - never
// executed as a standalone `./scripts/migrate.mjs`, so no shebang is needed.
//
// Why this exists (see docs/DAILY_CHECKIN_DEPLOYMENT_FIX.md): the Phase 5
// deploy shipped code that queries the `dailyCheckins` table and
// `coupons.maxDiscountAmount` column, but nothing in the deploy pipeline
// ever ran `drizzle-kit migrate` (or equivalent) against the production
// database - `pnpm start` boots the server directly, and `db:push`
// (`drizzle-kit generate && drizzle-kit migrate`) is a manual,
// developer-invoked command that was never wired into deployment. This
// script is the fix: it runs ONLY already-committed migrations (never
// `generate` - generating a new migration during a deploy would be
// non-deterministic and is explicitly out of scope for a startup script),
// and is meant to run to completion BEFORE the server starts accepting
// traffic (see the `start` script in package.json: `node scripts/migrate.mjs
// && node dist/index.js` - the `&&` means a failed migration here stops the
// deploy instead of silently booting against a stale/partial schema).
//
// Deliberately implemented with drizzle-orm's programmatic migrator
// (`drizzle-orm/mysql2/migrator`) instead of shelling out to the
// `drizzle-kit` CLI: `drizzle-kit` is a devDependency (verified via
// package.json), so it is not guaranteed to be present wherever this runs
// in production, while `drizzle-orm` and `mysql2` are regular dependencies.
//
// Concurrency: if Manus (or any future host) starts multiple instances of
// this app at the same time, every instance's `pnpm start` would otherwise
// run this migration step concurrently. A MySQL named lock
// (GET_LOCK/RELEASE_LOCK, session-scoped to this script's single dedicated
// connection - never a pool) serializes that: only one instance actually
// executes the migration statements at a time, and every other instance
// waits for the lock, then finds nothing pending and returns immediately.
// A failure to acquire the lock within the timeout is treated as a hard
// failure (exit 1), not a silent skip - this script has no way to tell
// "another instance is legitimately migrating right now" apart from
// "something is stuck", so it fails loudly rather than guessing.

import mysql from "mysql2";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Single shared sanitizer - see scripts/lib/safeErrorSummary.mjs for why
// drizzle's own error messages must never be logged verbatim (they embed
// the failing SQL and its bound parameters).
import { safeErrorSummary } from "./lib/safeErrorSummary.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "..", "drizzle");

const LOCK_NAME = "ipenovel_schema_migrations";
const LOCK_TIMEOUT_SECONDS = 60;

// Schema objects the running application hard-depends on. Verified
// read-only (information_schema, SELECT only - never user rows) after
// migrate() reports success, so a migration run that "succeeded" but left
// the schema incomplete still fails the deploy instead of letting the
// server boot and serve errors. See docs/DAILY_CHECKIN_DEPLOYMENT_FIX.md.
export const REQUIRED_TABLES = [
  // Migration 0036. Admin role-set locking uses WHERE role='admin'
  // ORDER BY id FOR UPDATE. Without users_role_id_idx MariaDB/MySQL may scan
  // and lock unrelated user rows, which can block authentication and other
  // per-user writes. Listing users here also makes the REQUIRED_INDEXES loop
  // actually verify the index instead of skipping a table absent from this
  // presence set.
  "users",
  // Google login cannot resolve an external subject without migration 0033.
  "authIdentities",
  "dailyCheckins",
  "dailyCheckinCampaigns",
  "dailyCheckinCouponTemplates",
  "dailyCheckinRewardRules",
  "dailyCheckinRewardGrants",
  // `coupons` has existed since migration 0000 - listed here (not because it
  // could ever be missing) purely so the REQUIRED_INDEXES loop's
  // "don't double-report an index on an already-reported-missing table"
  // presence check below has an entry for it and actually runs the
  // coupons_ownerUserId_idx check instead of silently skipping it.
  "coupons",
  // Migrations 0037/0038. Both order and wallet approval depend on the
  // global claim registry, while explicit legacy-case adjudication depends
  // on the resolution table. A migration journal alone is not proof these
  // objects still exist, so verify them before the server accepts traffic.
  "paymentSlipClaims",
  "paymentSlipReviewResolutions",
  // Migration 0039 (IPE-004). The legacy anti-replay registry: every
  // approval that reaches the strong-identifier gate reads
  // paymentSlipLegacyCollisions to decide `known_collision`, and the
  // backfill's completion gate reads paymentSlipLegacyUnknown to decide
  // whether a historical row is permanently unresolvable. A database whose
  // migration journal claims 0039 ran but whose tables are absent would let
  // the server boot and then fail EVERY payment approval at query time -
  // exactly the production incident this task exists to prevent - or, worse,
  // let a collision lookup error be mistaken for "no collision". Verified at
  // boot so an incomplete 0039 stops the deploy instead.
  "paymentSlipLegacyCollisions",
  "paymentSlipLegacyUnknown",
  // IPE-021-D / IPE-022-C02. These tables and the legacy ledger participate
  // in the rolling-deploy bridge, so absence must stop startup before the
  // application can mistake a missing mutex/mirror for an empty account.
  "accountMutationGuards",
  "pointsAccounts",
  "pointsTransactions",
  // IPE-009 Sports Vote catalog/reward runtime dependencies. The match list,
  // admin catalog, and points settlement read these tables unconditionally.
  "sportsCompetitions",
  "sportsTeams",
  "sportsCompetitionTeams",
  "sportsMatches",
  "sportsMatchRewards",
];
export const REQUIRED_COLUMNS = [
  { table: "accountMutationGuards", column: "userId" },
  { table: "accountMutationGuards", column: "generation" },
  { table: "accountMutationGuards", column: "mergeState" },
  { table: "accountMutationGuards", column: "activeMergeCaseId" },
  { table: "accountMutationGuards", column: "updatedAt" },
  { table: "pointsAccounts", column: "userId" },
  { table: "pointsAccounts", column: "balance" },
  { table: "pointsAccounts", column: "version" },
  { table: "pointsAccounts", column: "updatedAt" },
  { table: "pointsTransactions", column: "effectKey" },
  { table: "paymentSlipClaims", column: "legacyReferenceUpperHash" },
  { table: "coupons", column: "maxDiscountAmount" },
  // Coupon ownership scope (migration 0032, fix/coupon-owner-enforcement).
  // server/db.ts's createCoupon/updateCoupon/validateAndApplyCoupon read and
  // write these unconditionally - a database still at 0031 would fail every
  // coupon create/update/validate at query time rather than at boot.
  { table: "coupons", column: "scope" },
  { table: "coupons", column: "ownerUserId" },
  { table: "dailyCheckins", column: "couponId" },
  // Written on every point-reward claim. streakCountAtGrant in particular is
  // NOT NULL with no database default, so a build that reaches the claim path
  // without it present fails at INSERT time rather than at boot - verify it
  // here instead.
  { table: "dailyCheckinRewardGrants", column: "pointsTransactionId" },
  { table: "dailyCheckinRewardGrants", column: "streakCountAtGrant" },
  { table: "sportsMatches", column: "competitionId" },
  { table: "sportsMatches", column: "homeTeamId" },
  { table: "sportsMatches", column: "awayTeamId" },
  { table: "sportsMatches", column: "rewardKind" },
  { table: "sportsMatches", column: "rewardPointsAmount" },
  { table: "sportsMatchRewards", column: "rewardKind" },
  { table: "sportsMatchRewards", column: "pointsAmount" },
  { table: "sportsMatchRewards", column: "pointsTransactionId" },
];

/**
 * Columns that MUST be nullable for the running application to work.
 *
 * dailyCheckins.couponId was NOT NULL until migration 0031. A point-reward
 * check-in mints no coupon, so on a database still stuck at 0030 every point
 * claim would fail at INSERT time with "Column 'couponId' cannot be null".
 * Verifying nullability at boot turns that into a fail-closed deploy error
 * instead of a runtime error for every user who taps "check in".
 */
export const REQUIRED_NULLABLE_COLUMNS = [
  { table: "dailyCheckins", column: "couponId" },
  { table: "sportsMatches", column: "rewardDiscountType" },
  { table: "sportsMatches", column: "rewardDiscountValue" },
  { table: "sportsMatchRewards", column: "couponId" },
];

export const REQUIRED_INDEXES = [
  { table: "accountMutationGuards", index: "PRIMARY", unique: true },
  { table: "accountMutationGuards", index: "accountMutationGuards_activeMergeCaseId_unique", unique: true },
  { table: "pointsAccounts", index: "PRIMARY", unique: true },
  { table: "pointsTransactions", index: "pointsTransactions_userId_effectKey_unique", unique: true },
  { table: "users", index: "users_role_id_idx" },
  { table: "users", index: "users_email_idx" },
  { table: "authIdentities", index: "PRIMARY" },
  { table: "authIdentities", index: "authIdentities_provider_providerSubject_unique" },
  { table: "authIdentities", index: "authIdentities_userId_provider_unique" },
  { table: "authIdentities", index: "authIdentities_userId_idx" },
  { table: "coupons", index: "coupons_ownerUserId_idx" },
  { table: "paymentSlipClaims", index: "PRIMARY" },
  { table: "paymentSlipClaims", index: "paymentSlipClaims_referenceHash_unique" },
  { table: "paymentSlipClaims", index: "paymentSlipClaims_fileHash_unique" },
  { table: "paymentSlipClaims", index: "paymentSlipClaims_qrPayloadHash_unique" },
  { table: "paymentSlipClaims", index: "paymentSlipClaims_legacyReferenceUpperHash_idx" },
  { table: "paymentSlipClaims", index: "paymentSlipClaims_semanticFingerprint_idx" },
  { table: "paymentSlipClaims", index: "paymentSlipClaims_source_idx" },
  { table: "paymentSlipClaims", index: "paymentSlipClaims_userId_idx" },
  { table: "paymentSlipReviewResolutions", index: "PRIMARY" },
  { table: "paymentSlipReviewResolutions", index: "paymentSlipReviewResolutions_subject_unique" },
  { table: "paymentSlipReviewResolutions", index: "paymentSlipReviewResolutions_adminUserId_idx" },
  { table: "paymentSlipReviewResolutions", index: "paymentSlipReviewResolutions_createdAt_idx" },
  { table: "dailyCheckins", index: "PRIMARY" },
  { table: "dailyCheckins", index: "unique_daily_checkin_user_date_campaign" },
  { table: "dailyCheckins", index: "unique_daily_checkins_coupon" },
  { table: "dailyCheckins", index: "dailyCheckins_userId_idx" },
  // Reward-grant idempotency guards: one grant per (check-in, rule), and one
  // grant per points transaction. These are what make a retried or racing
  // claim structurally unable to credit twice.
  { table: "dailyCheckinRewardGrants", index: "dailyCheckinRewardGrants_checkin_rule_unique" },
  { table: "dailyCheckinRewardGrants", index: "dailyCheckinRewardGrants_pointsTransactionId_unique" },
  { table: "dailyCheckinRewardRules", index: "dailyCheckinRewardRules_campaign_dedupe_unique" },
  { table: "dailyCheckinCampaigns", index: "dailyCheckinCampaigns_campaignKey_unique" },
  // Migration 0039 (IPE-004). Each of these is application-critical, not
  // merely a performance hint:
  //  - PRIMARY: the autoincrement identity every insert depends on.
  //  - paymentSlipLegacyCollisions_member_unique: what makes recording a
  //    collision member idempotent. Without it a rerun of the backfill
  //    silently duplicates members instead of hitting ER_DUP_ENTRY, and the
  //    duplicate-key paths that prove a collision is durably recorded stop
  //    firing.
  //  - paymentSlipLegacyCollisions_identifierHash_idx: the (kind,
  //    identifierHash) lookup the live approval path uses. Missing, the
  //    bounded per-approval check degrades to a full table scan - the O(N)
  //    approval cost this hotfix removed.
  //  - paymentSlipLegacyUnknown_source_unique: one unknown row per source.
  //    Without it the unknown registry can hold contradictory duplicate rows
  //    for one source and clearing a stale unknown stops being decisive.
  //  - paymentSlipLegacyUnknown_sourceType_idx: the per-source-type read the
  //    completion gate uses.
  { table: "paymentSlipLegacyCollisions", index: "PRIMARY" },
  { table: "paymentSlipLegacyCollisions", index: "paymentSlipLegacyCollisions_member_unique" },
  { table: "paymentSlipLegacyCollisions", index: "paymentSlipLegacyCollisions_identifierHash_idx" },
  { table: "paymentSlipLegacyUnknown", index: "PRIMARY" },
  { table: "paymentSlipLegacyUnknown", index: "paymentSlipLegacyUnknown_source_unique" },
  { table: "paymentSlipLegacyUnknown", index: "paymentSlipLegacyUnknown_sourceType_idx" },
  // IPE-009 catalog identity/membership and settlement idempotency guards.
  { table: "sportsCompetitions", index: "sportsCompetitions_code_unique" },
  { table: "sportsTeams", index: "sportsTeams_code_unique" },
  { table: "sportsCompetitionTeams", index: "sportsCompetitionTeams_competition_team_unique" },
  { table: "sportsMatches", index: "sportsMatches_competitionId_idx" },
  { table: "sportsMatchRewards", index: "unique_sports_match_rewards_vote" },
  { table: "sportsMatchRewards", index: "unique_sports_match_rewards_points_tx" },
];

export const REQUIRED_FOREIGN_KEYS = [
  {
    table: "accountMutationGuards",
    constraint: "accountMutationGuards_userId_fk",
    column: "userId",
    referencedTable: "users",
    referencedColumn: "id",
    deleteRule: "CASCADE",
  },
  {
    table: "pointsAccounts",
    constraint: "pointsAccounts_userId_fk",
    column: "userId",
    referencedTable: "users",
    referencedColumn: "id",
    deleteRule: "CASCADE",
  },
];

/**
 * Read-only post-migration schema verification. Returns the names of any
 * missing objects (empty array = everything present).
 *
 * Every query is a plain information_schema SELECT scoped to DATABASE(),
 * with explicit column aliases so the result keys are stable across
 * MySQL 8 and TiDB (which differ in information_schema column casing).
 * No user table is read.
 */
export async function findMissingSchemaObjects(conn) {
  const missing = [];

  const [tableRows] = await conn.query(
    `SELECT table_name AS name FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name IN (${REQUIRED_TABLES.map(() => "?").join(",")})`,
    REQUIRED_TABLES
  );
  // Compared case-insensitively: MySQL on a case-sensitive filesystem
  // (the typical production/TiDB setup) preserves table names exactly as
  // declared, but MariaDB/MySQL with lower_case_table_names=1 or 2 (the
  // default on Windows and macOS installs) stores and returns them
  // lowercased - information_schema.tables.table_name would come back as
  // "dailycheckins", not "dailyCheckins". The WHERE clause above already
  // matches case-insensitively at the SQL level (that part was never the
  // problem); a plain Set built from the exact declared casing would
  // still reject that lowercased row with a case-sensitive Set.has(),
  // reporting every table "missing" even though the query found them all -
  // exactly what a real disposable-database run against local MariaDB
  // caught. This has no bearing on column/index checks below, which do
  // their table-name comparison in SQL (via WHERE), never in JS.
  const presentTables = new Set((tableRows ?? []).map((row) => String(row.name).toLowerCase()));
  for (const table of REQUIRED_TABLES) {
    if (!presentTables.has(table.toLowerCase())) missing.push(`table ${table}`);
  }

  for (const { table, column } of REQUIRED_COLUMNS) {
    const [columnRows] = await conn.query(
      `SELECT column_name AS name FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [table, column]
    );
    if (!columnRows || columnRows.length === 0) missing.push(`column ${table}.${column}`);
  }

  for (const { table, column } of REQUIRED_NULLABLE_COLUMNS) {
    const [nullableRows] = await conn.query(
      `SELECT is_nullable AS nullable FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [table, column]
    );
    // A missing column is already reported by REQUIRED_COLUMNS above - only
    // report the distinct "present but still NOT NULL" failure here.
    if (nullableRows && nullableRows.length > 0) {
      if (String(nullableRows[0].nullable).toUpperCase() !== "YES") {
        missing.push(`column ${table}.${column} must be nullable (migration 0031 not applied)`);
      }
    }
  }

  for (const { table, index, unique } of REQUIRED_INDEXES) {
    // An index on a missing table is already reported as a missing table -
    // don't report the same root cause twice. Same case-insensitive
    // comparison as the table check above, for the same reason.
    if (!presentTables.has(table.toLowerCase())) continue;
    const [indexRows] = await conn.query(
      `SELECT DISTINCT index_name AS name FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?${unique ? " AND non_unique = 0" : ""}`,
      [table, index]
    );
    if (!indexRows || indexRows.length === 0) missing.push(`index ${table}.${index}`);
  }

  for (const foreignKey of REQUIRED_FOREIGN_KEYS) {
    if (!presentTables.has(foreignKey.table.toLowerCase())) continue;
    const [foreignKeyRows] = await conn.query(
      `SELECT kcu.constraint_name AS name
       FROM information_schema.key_column_usage kcu
       INNER JOIN information_schema.referential_constraints rc
         ON rc.constraint_schema = kcu.constraint_schema
        AND rc.table_name = kcu.table_name
        AND rc.constraint_name = kcu.constraint_name
       WHERE kcu.table_schema = DATABASE()
         AND kcu.table_name = ?
         AND kcu.constraint_name = ?
         AND kcu.column_name = ?
         AND kcu.referenced_table_name = ?
         AND kcu.referenced_column_name = ?
         AND rc.delete_rule = ?`,
      [
        foreignKey.table,
        foreignKey.constraint,
        foreignKey.column,
        foreignKey.referencedTable,
        foreignKey.referencedColumn,
        foreignKey.deleteRule,
      ]
    );
    if (!foreignKeyRows || foreignKeyRows.length === 0) {
      missing.push(`foreign key ${foreignKey.table}.${foreignKey.constraint}`);
    }
  }

  return missing;
}

/**
 * Converge the two additive IPE-021-D mirrors after migrations and before the
 * process listens. Every statement is safe to repeat. Existing guards are
 * deliberately not rewritten (generation/binding is lifecycle state), while
 * pointsAccounts is reconciled from the latest immutable compatibility-ledger
 * row using the same `(createdAt DESC, id DESC)` ordering as the legacy app.
 */
export async function reconcilePaymentV2FoundationData(conn) {
  await conn.query("START TRANSACTION");
  try {
    // Briefly quiesce legacy writers. Every legacy classified/points mutation
    // rendezvous on users, while new points writers acquire users before
    // pointsAccounts. Taking the same order prevents a stale snapshot from
    // overwriting a balance that another live instance just committed.
    await conn.query("SELECT id FROM users ORDER BY id FOR UPDATE");

    await conn.query(
      `INSERT IGNORE INTO accountMutationGuards (userId, generation, mergeState, activeMergeCaseId)
       SELECT u.id,
              CASE WHEN amc.id IS NULL THEN 0 ELSE 1 END,
              CASE WHEN amc.id IS NULL THEN 'open' ELSE 'merge_guarded' END,
              amc.id
       FROM users u
       LEFT JOIN accountMutationGuards g ON g.userId = u.id
       LEFT JOIN accountMergeCases amc
         ON amc.sourceUserId = u.id AND amc.status <> 'cancelled'
       WHERE g.userId IS NULL`
    );

    await conn.query(
      `INSERT IGNORE INTO pointsAccounts (userId, balance, version)
       SELECT u.id,
              COALESCE((
                SELECT pt.balanceAfter
                FROM pointsTransactions pt
                WHERE pt.userId = u.id
                ORDER BY pt.createdAt DESC, pt.id DESC
                LIMIT 1
              ), '0.00'),
              0
       FROM users u
       LEFT JOIN pointsAccounts pa ON pa.userId = u.id
       WHERE pa.userId IS NULL`
    );

    await conn.query("SELECT userId FROM pointsAccounts ORDER BY userId FOR UPDATE");
    await conn.query(
      `UPDATE pointsAccounts pa
       SET pa.balance = COALESCE((
         SELECT pt.balanceAfter
         FROM pointsTransactions pt
         WHERE pt.userId = pa.userId
         ORDER BY pt.createdAt DESC, pt.id DESC
         LIMIT 1
       ), '0.00'),
           pa.version = pa.version + 1
       WHERE NOT (pa.balance <=> COALESCE((
         SELECT pt.balanceAfter
         FROM pointsTransactions pt
         WHERE pt.userId = pa.userId
         ORDER BY pt.createdAt DESC, pt.id DESC
         LIMIT 1
       ), '0.00'))`
    );
    await conn.query("COMMIT");
  } catch (error) {
    await conn.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

function readMismatchCount(rows) {
  return Number(rows?.[0]?.mismatchCount ?? 0);
}

/**
 * Read-only authority-switch readiness check. A non-empty result is precise
 * proof that the additive foundation is not ready: every user must have one
 * guard and one points row, guard state must match the canonical active merge
 * case, and the points mirror must equal the deterministic latest ledger row.
 */
export async function findPaymentV2FoundationDataMismatches(conn) {
  const findings = [];

  const [missingGuardRows] = await conn.query(
    `SELECT COUNT(*) AS mismatchCount
     FROM users u
     LEFT JOIN accountMutationGuards g ON g.userId = u.id
     WHERE g.userId IS NULL`
  );
  const missingGuards = readMismatchCount(missingGuardRows);
  if (missingGuards > 0) findings.push(`accountMutationGuards missing rows=${missingGuards}`);

  const [guardStateRows] = await conn.query(
    `SELECT COUNT(*) AS mismatchCount
     FROM users u
     INNER JOIN accountMutationGuards g ON g.userId = u.id
     LEFT JOIN accountMergeCases amc
       ON amc.sourceUserId = u.id AND amc.status <> 'cancelled'
     WHERE (amc.id IS NULL AND (g.mergeState <> 'open' OR g.activeMergeCaseId IS NOT NULL))
        OR (amc.id IS NOT NULL AND
            (g.mergeState <> 'merge_guarded' OR NOT (g.activeMergeCaseId <=> amc.id)))`
  );
  const guardStateMismatches = readMismatchCount(guardStateRows);
  if (guardStateMismatches > 0) {
    findings.push(`accountMutationGuards state mismatches=${guardStateMismatches}`);
  }

  const [missingPointsRows] = await conn.query(
    `SELECT COUNT(*) AS mismatchCount
     FROM users u
     LEFT JOIN pointsAccounts pa ON pa.userId = u.id
     WHERE pa.userId IS NULL`
  );
  const missingPoints = readMismatchCount(missingPointsRows);
  if (missingPoints > 0) findings.push(`pointsAccounts missing rows=${missingPoints}`);

  const [pointsBalanceRows] = await conn.query(
    `SELECT COUNT(*) AS mismatchCount
     FROM users u
     INNER JOIN pointsAccounts pa ON pa.userId = u.id
     WHERE NOT (pa.balance <=> COALESCE((
       SELECT pt.balanceAfter
       FROM pointsTransactions pt
       WHERE pt.userId = u.id
       ORDER BY pt.createdAt DESC, pt.id DESC
       LIMIT 1
     ), '0.00'))`
  );
  const pointsBalanceMismatches = readMismatchCount(pointsBalanceRows);
  if (pointsBalanceMismatches > 0) {
    findings.push(`pointsAccounts latest-ledger balance mismatches=${pointsBalanceMismatches}`);
  }

  return findings;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("[migrate] DATABASE_URL is not set - refusing to start without a known database to migrate.");
    process.exitCode = 1;
    return;
  }

  let connection;
  try {
    connection = mysql.createConnection(databaseUrl);
  } catch (error) {
    console.error("[migrate] Failed to create a database connection:", safeErrorSummary(error));
    process.exitCode = 1;
    return;
  }
  const conn = connection.promise();

  let lockAcquired = false;
  try {
    console.log(
      `[migrate] Acquiring migration lock "${LOCK_NAME}" (timeout ${LOCK_TIMEOUT_SECONDS}s) - ` +
        "safe if multiple instances start at the same time, only one will actually migrate..."
    );
    const [lockRows] = await conn.query("SELECT GET_LOCK(?, ?) AS acquired", [LOCK_NAME, LOCK_TIMEOUT_SECONDS]);
    const acquired = lockRows?.[0]?.acquired;
    if (acquired !== 1) {
      // 0 = timed out waiting for another holder, NULL = error acquiring.
      // Either way: never proceed without the lock - two concurrent
      // migration runs against DDL is exactly the race this exists to
      // prevent.
      throw new Error(
        `Could not acquire the migration lock within ${LOCK_TIMEOUT_SECONDS}s (GET_LOCK returned ${acquired}). ` +
          "Another instance may be migrating or stuck."
      );
    }
    lockAcquired = true;
    console.log("[migrate] Lock acquired. Running pending migrations (existing, committed migration files only)...");

    const db = drizzle({ client: connection });
    await migrate(db, { migrationsFolder });

    // migrate() returning is not sufficient proof the schema is usable -
    // verify the objects the application actually queries really exist
    // before reporting success (and therefore before the server is allowed
    // to open a port).
    console.log("[migrate] Verifying required schema objects (read-only)...");
    const missing = await findMissingSchemaObjects(conn);
    if (missing.length > 0) {
      // Only the object names - never the query, the schema name, or any row.
      console.error(`[migrate] Migration failed: schema verification found missing object(s): ${missing.join(", ")}`);
      process.exitCode = 1;
      return;
    }

    console.log("[migrate] Reconciling Payment V2 foundation mirrors (restart-safe)...");
    await reconcilePaymentV2FoundationData(conn);

    console.log("[migrate] Verifying Payment V2 foundation readiness (read-only)...");
    const dataMismatches = await findPaymentV2FoundationDataMismatches(conn);
    if (dataMismatches.length > 0) {
      console.error(
        `[migrate] Migration failed: Payment V2 foundation readiness found mismatch(es): ${dataMismatches.join(", ")}`
      );
      process.exitCode = 1;
      return;
    }

    console.log("[migrate] Done - schema is up to date.");
  } catch (error) {
    // Never swallow this - a failed migration must stop the deploy, not
    // let the app boot against a stale/partial schema.
    console.error("[migrate] Migration failed:", safeErrorSummary(error));
    process.exitCode = 1;
  } finally {
    if (lockAcquired) {
      try {
        await conn.query("SELECT RELEASE_LOCK(?)", [LOCK_NAME]);
      } catch (releaseError) {
        console.warn("[migrate] Failed to release the migration lock (non-fatal):", safeErrorSummary(releaseError));
      }
    }
    await conn.end().catch(() => {});
  }
}

// Guarded so this module can be imported (e.g. to unit-test
// findMissingSchemaObjects with a fake connection, no real database
// involved) without main() firing and attempting a real DB connection.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(() => {
    process.exit(process.exitCode ?? 0);
  });
}
