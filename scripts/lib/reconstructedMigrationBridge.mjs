import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export const RECONSTRUCTED_SELECTED_MIGRATION = {
  tag: "0037_reconstruct_pr45_selected_features",
  createdAt: 1788715650510,
  file: "0037_reconstruct_pr45_selected_features.sql",
};

export const LEGACY_ACCOUNT_SPORTS_MIGRATION_CREATED_AT = [
  1787919487827, // 0040 account-merge foundation
  1787939153092, // 0041 account-merge guard concurrency
  1788020144269, // 0042 account-merge financial reconciliation
  1788027469369, // 0043 account-merge data reconciliation
  1788182918549, // 0044 sports vote catalog / points rewards
];

export const LEGACY_WORKSPACE_MIGRATION_CREATED_AT = [
  1788561151155, // 0050 workspace foundation
  1788699548518, // 0051 Google Docs connection / snapshot foundation
  1788701924728, // 0052 Google Docs hardening schema
];

export const LEGACY_SELECTED_MIGRATION_CREATED_AT = [
  ...LEGACY_ACCOUNT_SPORTS_MIGRATION_CREATED_AT,
  ...LEGACY_WORKSPACE_MIGRATION_CREATED_AT,
];

export const LEGACY_ACCOUNT_SPORTS_REQUIRED_TABLES = [
  "accountMergeAuditLogs",
  "accountMergeCases",
  "accountMergeDataDedupeRecords",
  "accountMergeDataReconciliations",
  "accountMergeFinancialReconciliations",
  "sportsCompetitionTeams",
  "sportsCompetitions",
  "sportsTeams",
];

export const LEGACY_WORKSPACE_REQUIRED_TABLES = [
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

export const LEGACY_SELECTED_REQUIRED_TABLES = [
  ...LEGACY_ACCOUNT_SPORTS_REQUIRED_TABLES,
  ...LEGACY_WORKSPACE_REQUIRED_TABLES,
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

export const LEGACY_WORKSPACE_REQUIRED_INDEXES = [
  { table: "workspaceAuditEvents", index: "wae_workspace_created_idx" },
  { table: "workspaceAuditEvents", index: "wae_entity_created_idx" },
  { table: "workspaceAuditEvents", index: "wae_correlation_idx" },
  { table: "workspaceDocumentBindings", index: "wdb_document_status_idx" },
  { table: "workspaceDocumentSnapshots", index: "wds_document_observed_idx" },
  { table: "workspaceDocuments", index: "wd_connection_status_idx" },
  { table: "workspaceGoogleConnections", index: "wgc_status_expiry_idx" },
  { table: "workspaceGoogleConsentAttempts", index: "wgca_user_expiry_idx" },
  { table: "workspaceMembers", index: "workspaceMembers_user_status_idx" },
  { table: "workspaceMigrationRegistry", index: "workspaceMigrationRegistry_owner_capability_idx" },
  { table: "workspaceNovels", index: "workspaceNovels_novel_status_idx" },
  { table: "workspaceWorkspaces", index: "workspaceWorkspaces_owner_status_idx" },
];

export const LEGACY_WORKSPACE_REQUIRED_FOREIGN_KEYS = [
  { table: "workspaceAuditEvents", column: "workspaceId", referencedTable: "workspaceWorkspaces", referencedColumn: "id" },
  { table: "workspaceAuditEvents", column: "actorUserId", referencedTable: "users", referencedColumn: "id" },
  { table: "workspaceDocumentBindings", column: "workspaceNovelId", referencedTable: "workspaceNovels", referencedColumn: "id" },
  { table: "workspaceDocumentBindings", column: "documentId", referencedTable: "workspaceDocuments", referencedColumn: "id" },
  { table: "workspaceDocumentSnapshots", column: "documentId", referencedTable: "workspaceDocuments", referencedColumn: "id" },
  { table: "workspaceDocuments", column: "connectionId", referencedTable: "workspaceGoogleConnections", referencedColumn: "id" },
  { table: "workspaceGoogleConnections", column: "userId", referencedTable: "users", referencedColumn: "id" },
  { table: "workspaceGoogleConsentAttempts", column: "userId", referencedTable: "users", referencedColumn: "id" },
  { table: "workspaceMembers", column: "workspaceId", referencedTable: "workspaceWorkspaces", referencedColumn: "id" },
  { table: "workspaceMembers", column: "userId", referencedTable: "users", referencedColumn: "id" },
  { table: "workspaceMigrationRegistry", column: "workspaceNovelId", referencedTable: "workspaceNovels", referencedColumn: "id" },
  { table: "workspaceMigrationRegistry", column: "changedBy", referencedTable: "users", referencedColumn: "id" },
  { table: "workspaceNovels", column: "workspaceId", referencedTable: "workspaceWorkspaces", referencedColumn: "id" },
  { table: "workspaceNovels", column: "novelId", referencedTable: "novels", referencedColumn: "id" },
  { table: "workspaceReadOnlyBindings", column: "workspaceNovelId", referencedTable: "workspaceNovels", referencedColumn: "id" },
  { table: "workspaceWorkspaces", column: "ownerUserId", referencedTable: "users", referencedColumn: "id" },
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

async function findMissingTables(conn, requiredTables) {
  const rows = unwrapRows(
    await conn.query(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name IN (${requiredTables.map(() => "?").join(",")})`,
      requiredTables
    )
  );
  const present = new Set(rows.map((row) => String(row.name).toLowerCase()));
  return requiredTables.filter((table) => !present.has(table.toLowerCase()));
}

async function findPresentTables(conn, tables) {
  const rows = unwrapRows(
    await conn.query(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name IN (${tables.map(() => "?").join(",")})`,
      tables
    )
  );
  return rows.map((row) => String(row.name));
}

async function findAccountSportsSchemaMismatches(conn) {
  const mismatches = (await findMissingTables(conn, LEGACY_ACCOUNT_SPORTS_REQUIRED_TABLES)).map(
    (table) => `table ${table}`
  );

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
    if (actualNullable !== nullable) mismatches.push(`column ${table}.${column} nullability`);
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

async function findWorkspaceSchemaMismatches(conn) {
  const mismatches = (await findMissingTables(conn, LEGACY_WORKSPACE_REQUIRED_TABLES)).map((table) => `table ${table}`);

  for (const { table, index } of LEGACY_WORKSPACE_REQUIRED_INDEXES) {
    const rows = unwrapRows(
      await conn.query(
        `SELECT DISTINCT index_name AS name FROM information_schema.statistics
         WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
        [table, index]
      )
    );
    if (rows.length === 0) mismatches.push(`index ${table}.${index}`);
  }

  for (const { table, column, referencedTable, referencedColumn } of LEGACY_WORKSPACE_REQUIRED_FOREIGN_KEYS) {
    const rows = unwrapRows(
      await conn.query(
        `SELECT constraint_name AS name FROM information_schema.key_column_usage
         WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?
           AND referenced_table_name = ? AND referenced_column_name = ?`,
        [table, column, referencedTable, referencedColumn]
      )
    );
    if (rows.length === 0) {
      mismatches.push(`foreign key ${table}.${column}->${referencedTable}.${referencedColumn}`);
    }
  }

  return mismatches;
}

export async function findLegacySelectedSchemaMismatches(conn) {
  return [...(await findAccountSportsSchemaMismatches(conn)), ...(await findWorkspaceSchemaMismatches(conn))];
}

function sameMarkerSet(actual, expected) {
  return actual.size === expected.length && expected.every((createdAt) => actual.has(createdAt));
}

function extractWorkspaceStatements(migrationSql) {
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .filter(
      (statement) =>
        /^CREATE TABLE `workspace/i.test(statement) ||
        /^ALTER TABLE `workspace/i.test(statement) ||
        /^CREATE (?:UNIQUE )?INDEX `[^`]+` ON `workspace/i.test(statement)
    );

  const createdTables = new Set(
    statements
      .map((statement) => statement.match(/^CREATE TABLE `([^`]+)`/i)?.[1])
      .filter(Boolean)
      .map((table) => table.toLowerCase())
  );
  const missingCreateStatements = LEGACY_WORKSPACE_REQUIRED_TABLES.filter(
    (table) => !createdTables.has(table.toLowerCase())
  );
  if (missingCreateStatements.length > 0) {
    throw new Error(
      `Reconstructed migration is missing Workspace CREATE TABLE statements for: ${missingCreateStatements.join(", ")}. Refusing partial reconciliation.`
    );
  }

  return statements;
}

async function applyMissingWorkspaceSchema(conn, migrationsFolder) {
  const presentWorkspaceTables = await findPresentTables(conn, LEGACY_WORKSPACE_REQUIRED_TABLES);
  if (presentWorkspaceTables.length > 0) {
    throw new Error(
      `Known 5/8 legacy lineage has pre-existing Workspace schema objects (${presentWorkspaceTables.join(", ")}); refusing partial reconciliation.`
    );
  }

  const migrationSql = readFileSync(path.join(migrationsFolder, RECONSTRUCTED_SELECTED_MIGRATION.file), "utf8");
  const statements = extractWorkspaceStatements(migrationSql);
  for (const statement of statements) await conn.query(statement);

  const workspaceMismatches = await findWorkspaceSchemaMismatches(conn);
  if (workspaceMismatches.length > 0) {
    throw new Error(
      `Workspace reconciliation did not produce the reconstruction contract: ${workspaceMismatches.join(", ")}. Refusing to alter migration history.`
    );
  }
}

async function recordReconstructedMarker(conn, migrationsFolder) {
  const migrationSql = readFileSync(path.join(migrationsFolder, RECONSTRUCTED_SELECTED_MIGRATION.file), "utf8");
  const hash = createHash("sha256").update(migrationSql).digest("hex");
  await conn.query("INSERT INTO `__drizzle_migrations` (hash, created_at) VALUES (?, ?)", [
    hash,
    RECONSTRUCTED_SELECTED_MIGRATION.createdAt,
  ]);
}

/**
 * Bridges historical selected-feature lineages to the single clean
 * reconstructed 0037 migration without replaying DDL over production data.
 *
 * Accepted legacy states are intentionally narrow:
 * - all 8 selected markers + matching physical schema: record 0037 only;
 * - exact 0040-0044 marker set + matching Account Merge/Sports schema and no
 *   Workspace tables: create only Workspace/Google Docs objects from 0037,
 *   verify the final contract, then record 0037.
 * Any other partial lineage or pre-existing partial Workspace schema fails
 * closed. Unrelated legacy Payment/OCR/evidence tables are never inspected or
 * changed by this bridge.
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

  if (sameMarkerSet(presentMarkers, LEGACY_ACCOUNT_SPORTS_MIGRATION_CREATED_AT)) {
    const existingMismatches = await findAccountSportsSchemaMismatches(conn);
    if (existingMismatches.length > 0) {
      throw new Error(
        `Known 5/8 legacy lineage does not match the Account Merge/Sports reconstruction contract: ${existingMismatches.join(", ")}. Refusing partial reconciliation.`
      );
    }

    await applyMissingWorkspaceSchema(conn, migrationsFolder);
    const finalMismatches = await findLegacySelectedSchemaMismatches(conn);
    if (finalMismatches.length > 0) {
      throw new Error(
        `Reconciled selected-feature schema does not match the reconstruction contract: ${finalMismatches.join(", ")}. Refusing to alter migration history.`
      );
    }

    await recordReconstructedMarker(conn, migrationsFolder);
    return { bridged: true, reason: "legacy-account-sports-with-workspace-reconciled" };
  }

  if (!sameMarkerSet(presentMarkers, LEGACY_SELECTED_MIGRATION_CREATED_AT)) {
    throw new Error(
      `Legacy selected-feature migration lineage is partial (${presentMarkers.size}/${LEGACY_SELECTED_MIGRATION_CREATED_AT.length} markers present) and is not the supported 0040-0044-only state; refusing reconstruction bridge.`
    );
  }

  const mismatches = await findLegacySelectedSchemaMismatches(conn);
  if (mismatches.length > 0) {
    throw new Error(
      `Legacy selected-feature schema does not match the reconstruction contract: ${mismatches.join(", ")}. Refusing to alter migration history.`
    );
  }

  await recordReconstructedMarker(conn, migrationsFolder);
  return { bridged: true, reason: "legacy-selected-lineage-verified" };
}
