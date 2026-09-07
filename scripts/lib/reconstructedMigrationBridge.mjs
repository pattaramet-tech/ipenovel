import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export const RECONSTRUCTED_SELECTED_MIGRATION = {
  tag: "0037_reconstruct_pr45_selected_features",
  createdAt: 1788715650510,
  file: "0037_reconstruct_pr45_selected_features.sql",
};

// Exact created_at values from the last legacy migration lineage that built
// the selected post-PR45 features before they were consolidated into the
// reconstruction migration. We intentionally require every selected marker;
// Payment V2 / evidence migrations are neither required nor inspected here.
export const LEGACY_SELECTED_MIGRATION_CREATED_AT = [
  1787919487827, // 0040 account-merge foundation
  1787939153092, // 0041 account-merge guard concurrency
  1788020144269, // 0042 account-merge financial reconciliation
  1788027469369, // 0043 account-merge data reconciliation
  1788182918549, // 0044 sports vote catalog / points rewards
  1788561151155, // 0050 workspace foundation
  1788699548518, // 0051 Google Docs connection / snapshot foundation
  1788701924728, // 0052 Google Docs hardening schema
];

export const LEGACY_SELECTED_REQUIRED_TABLES = [
  "accountMergeAuditLogs",
  "accountMergeCases",
  "accountMergeDataDedupeRecords",
  "accountMergeDataReconciliations",
  "accountMergeFinancialReconciliations",
  "sportsCompetitionTeams",
  "sportsCompetitions",
  "sportsTeams",
  "workspaceAuditEvents",
  "workspaceDocumentBindings",
  "workspaceDocumentSnapshots",
  "workspaceDocuments",
  "workspaceGoogleConnections",
  "workspaceGoogleConsentAttempts",
  "workspaceMembers",
  "workspaceMigrationRegistry",
  "workspaceNovels",
  "workspaceReadOnlyBindings",
  "workspaceWorkspaces",
];

export const LEGACY_SELECTED_REQUIRED_COLUMNS = [
  { table: "sportsMatchRewards", column: "rewardKind", nullable: false },
  { table: "sportsMatchRewards", column: "couponId", nullable: true },
  { table: "sportsMatchRewards", column: "pointsAmount", nullable: true },
  { table: "sportsMatchRewards", column: "pointsTransactionId", nullable: true },
  { table: "sportsMatches", column: "competitionId", nullable: true },
  { table: "sportsMatches", column: "homeTeamId", nullable: true },
  { table: "sportsMatches", column: "awayTeamId", nullable: true },
  { table: "sportsMatches", column: "rewardKind", nullable: false },
  { table: "sportsMatches", column: "rewardPointsAmount", nullable: true },
  { table: "sportsMatches", column: "rewardDiscountType", nullable: true },
  { table: "sportsMatches", column: "rewardDiscountValue", nullable: true },
];

export const LEGACY_SELECTED_REQUIRED_INDEXES = [
  { table: "sportsMatchRewards", index: "unique_sports_match_rewards_points_tx" },
  { table: "sportsMatches", index: "sportsMatches_competitionId_idx" },
  { table: "sportsMatches", index: "sportsMatches_homeTeamId_idx" },
  { table: "sportsMatches", index: "sportsMatches_awayTeamId_idx" },
];

function unwrapRows(result) {
  return Array.isArray(result) ? (result[0] ?? []) : [];
}

async function hasMigrationTable(conn) {
  const rows = unwrapRows(
    await conn.query(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = '__drizzle_migrations'`
    )
  );
  return rows.length > 0;
}

export async function findLegacySelectedSchemaMismatches(conn) {
  const mismatches = [];

  const tableRows = unwrapRows(
    await conn.query(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name IN (${LEGACY_SELECTED_REQUIRED_TABLES.map(() => "?").join(",")})`,
      LEGACY_SELECTED_REQUIRED_TABLES
    )
  );
  const presentTables = new Set(tableRows.map((row) => String(row.name).toLowerCase()));
  for (const table of LEGACY_SELECTED_REQUIRED_TABLES) {
    if (!presentTables.has(table.toLowerCase())) mismatches.push(`table ${table}`);
  }

  for (const { table, column, nullable } of LEGACY_SELECTED_REQUIRED_COLUMNS) {
    const rows = unwrapRows(
      await conn.query(
        `SELECT column_name AS name, is_nullable AS nullable
         FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
        [table, column]
      )
    );
    if (rows.length === 0) {
      mismatches.push(`column ${table}.${column}`);
      continue;
    }
    const actualNullable = String(rows[0].nullable).toUpperCase() === "YES";
    if (actualNullable !== nullable) {
      mismatches.push(`column ${table}.${column} nullability`);
    }
  }

  for (const { table, index } of LEGACY_SELECTED_REQUIRED_INDEXES) {
    const rows = unwrapRows(
      await conn.query(
        `SELECT DISTINCT index_name AS name FROM information_schema.statistics
         WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
        [table, index]
      )
    );
    if (rows.length === 0) mismatches.push(`index ${table}.${index}`);
  }

  return mismatches;
}

/**
 * Bridges the historical post-PR45 migration lineage to the single clean
 * reconstruction migration without replaying DDL over tables that already
 * contain production data.
 *
 * The bridge is deliberately fail-closed:
 * - fresh / pre-legacy databases are left untouched and use normal migrate();
 * - a partial legacy selected-feature lineage throws instead of guessing;
 * - a complete legacy lineage is accepted only when key physical schema
 *   objects match the reconstruction target;
 * - the only write is one row in __drizzle_migrations. Application/user rows
 *   and unrelated legacy tables are never modified.
 */
export async function bridgeLegacySelectedFeatureMigration(conn, migrationsFolder) {
  if (!(await hasMigrationTable(conn))) return { bridged: false, reason: "no-migration-table" };

  const currentRows = unwrapRows(
    await conn.query("SELECT created_at AS createdAt FROM `__drizzle_migrations` WHERE created_at = ? LIMIT 1", [
      RECONSTRUCTED_SELECTED_MIGRATION.createdAt,
    ])
  );
  if (currentRows.length > 0) return { bridged: false, reason: "already-recorded" };

  const markerRows = unwrapRows(
    await conn.query(
      `SELECT created_at AS createdAt FROM \`__drizzle_migrations\`
       WHERE created_at IN (${LEGACY_SELECTED_MIGRATION_CREATED_AT.map(() => "?").join(",")})`,
      LEGACY_SELECTED_MIGRATION_CREATED_AT
    )
  );
  const presentMarkers = new Set(markerRows.map((row) => Number(row.createdAt)));
  if (presentMarkers.size === 0) return { bridged: false, reason: "no-legacy-selected-lineage" };

  const missingMarkers = LEGACY_SELECTED_MIGRATION_CREATED_AT.filter((createdAt) => !presentMarkers.has(createdAt));
  if (missingMarkers.length > 0) {
    throw new Error(
      `Legacy selected-feature migration lineage is partial (${presentMarkers.size}/${LEGACY_SELECTED_MIGRATION_CREATED_AT.length} markers present); refusing reconstruction bridge.`
    );
  }

  const mismatches = await findLegacySelectedSchemaMismatches(conn);
  if (mismatches.length > 0) {
    throw new Error(
      `Legacy selected-feature schema does not match the reconstruction contract: ${mismatches.join(", ")}. Refusing to alter migration history.`
    );
  }

  const migrationSql = readFileSync(path.join(migrationsFolder, RECONSTRUCTED_SELECTED_MIGRATION.file), "utf8");
  const hash = createHash("sha256").update(migrationSql).digest("hex");
  await conn.query("INSERT INTO `__drizzle_migrations` (hash, created_at) VALUES (?, ?)", [
    hash,
    RECONSTRUCTED_SELECTED_MIGRATION.createdAt,
  ]);

  return { bridged: true, reason: "legacy-selected-lineage-verified" };
}
