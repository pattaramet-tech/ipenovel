import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export const CANONICAL_ACCOUNT_MERGE_0039_CREATED_AT = 1789045727790;

export const LEGACY_WORKSPACE_RENUMBER_MIGRATIONS = [
  { createdAt: 1788784900000, tag: "0039_workspace_document_fingerprints" },
  { createdAt: 1788785000000, tag: "0040_workspace_checker_kanban_foundation" },
  { createdAt: 1788846911767, tag: "0041_workspace_ai_queue_foundation" },
  { createdAt: 1788859033810, tag: "0042_workspace_publish_dry_run_foundation" },
  { createdAt: 1788885160116, tag: "0043_workspace_publish_ownership_transition" },
];

export const CURRENT_WORKSPACE_RENUMBER_MIGRATIONS = [
  { createdAt: 1789045827790, tag: "0040_workspace_document_fingerprints", file: "0040_workspace_document_fingerprints.sql" },
  { createdAt: 1789045927790, tag: "0041_workspace_checker_kanban_foundation", file: "0041_workspace_checker_kanban_foundation.sql" },
  { createdAt: 1789046027790, tag: "0042_workspace_ai_queue_foundation", file: "0042_workspace_ai_queue_foundation.sql" },
  { createdAt: 1789046127790, tag: "0043_workspace_publish_dry_run_foundation", file: "0043_workspace_publish_dry_run_foundation.sql" },
  { createdAt: 1789046227790, tag: "0044_workspace_publish_ownership_transition", file: "0044_workspace_publish_ownership_transition.sql" },
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

async function markerSet(conn, createdAts) {
  const rows = unwrapRows(
    await conn.query(
      `SELECT created_at AS createdAt FROM \`__drizzle_migrations\`
       WHERE created_at IN (${createdAts.map(() => "?").join(",")})`,
      createdAts
    )
  );
  return new Set(rows.map((row) => Number(row.createdAt)));
}

function sameMarkerSet(actual, expected) {
  return actual.size === expected.length && expected.every((createdAt) => actual.has(createdAt));
}

function parseExpectedWorkspaceContract(migrationsFolder) {
  const tables = new Set();
  const columns = new Map();
  const indexes = [];
  const foreignKeys = [];

  for (const migration of CURRENT_WORKSPACE_RENUMBER_MIGRATIONS) {
    const sql = readFileSync(path.join(migrationsFolder, migration.file), "utf8");

    for (const match of sql.matchAll(/CREATE TABLE `([^`]+)` \(([\s\S]*?)\n\);/g)) {
      const table = match[1];
      tables.add(table);
      const tableColumns = columns.get(table) ?? new Set();
      for (const line of match[2].split(/\r?\n/)) {
        const columnMatch = line.match(/^\s*`([^`]+)`\s+/);
        if (columnMatch) tableColumns.add(columnMatch[1]);
        const uniqueMatch = line.match(/^\s*CONSTRAINT `([^`]+)` UNIQUE\(/);
        if (uniqueMatch) indexes.push({ table, index: uniqueMatch[1] });
      }
      columns.set(table, tableColumns);
    }

    for (const match of sql.matchAll(/ALTER TABLE `([^`]+)` ADD `([^`]+)`\s+/g)) {
      const table = match[1];
      const tableColumns = columns.get(table) ?? new Set();
      tableColumns.add(match[2]);
      columns.set(table, tableColumns);
    }

    for (const match of sql.matchAll(/CREATE (?:UNIQUE )?INDEX `([^`]+)` ON `([^`]+)`/g)) {
      indexes.push({ table: match[2], index: match[1] });
    }

    for (const match of sql.matchAll(
      /ALTER TABLE `([^`]+)` ADD CONSTRAINT `([^`]+)` FOREIGN KEY \(`([^`]+)`\) REFERENCES `([^`]+)`\(`([^`]+)`\)/g
    )) {
      foreignKeys.push({
        table: match[1],
        constraint: match[2],
        column: match[3],
        referencedTable: match[4],
        referencedColumn: match[5],
      });
    }
  }

  return { tables: [...tables], columns, indexes, foreignKeys };
}

export async function findWorkspaceRenumberSchemaMismatches(conn, migrationsFolder) {
  const contract = parseExpectedWorkspaceContract(migrationsFolder);
  const mismatches = [];

  const tableRows = unwrapRows(
    await conn.query(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name IN (${contract.tables.map(() => "?").join(",")})`,
      contract.tables
    )
  );
  const presentTables = new Set(tableRows.map((row) => String(row.name).toLowerCase()));
  for (const table of contract.tables) {
    if (!presentTables.has(table.toLowerCase())) mismatches.push(`table ${table}`);
  }

  for (const [table, expectedColumns] of contract.columns) {
    const columnRows = unwrapRows(
      await conn.query(
        `SELECT column_name AS name FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ?`,
        [table]
      )
    );
    const presentColumns = new Set(columnRows.map((row) => String(row.name).toLowerCase()));
    for (const column of expectedColumns) {
      if (!presentColumns.has(column.toLowerCase())) mismatches.push(`column ${table}.${column}`);
    }
  }

  for (const { table, index } of contract.indexes) {
    const rows = unwrapRows(
      await conn.query(
        `SELECT DISTINCT index_name AS name FROM information_schema.statistics
         WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
        [table, index]
      )
    );
    if (rows.length === 0) mismatches.push(`index ${table}.${index}`);
  }

  for (const { table, constraint, column, referencedTable, referencedColumn } of contract.foreignKeys) {
    const rows = unwrapRows(
      await conn.query(
        `SELECT constraint_name AS name FROM information_schema.key_column_usage
         WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = ?
           AND column_name = ? AND referenced_table_name = ? AND referenced_column_name = ?`,
        [table, constraint, column, referencedTable, referencedColumn]
      )
    );
    if (rows.length === 0) {
      mismatches.push(`foreign key ${constraint} on ${table}.${column}->${referencedTable}.${referencedColumn}`);
    }
  }

  return mismatches;
}

async function recordCurrentWorkspaceMarkers(conn, migrationsFolder) {
  await conn.beginTransaction();
  try {
    for (const migration of CURRENT_WORKSPACE_RENUMBER_MIGRATIONS) {
      const sql = readFileSync(path.join(migrationsFolder, migration.file), "utf8");
      const hash = createHash("sha256").update(sql).digest("hex");
      await conn.query("INSERT INTO `__drizzle_migrations` (hash, created_at) VALUES (?, ?)", [hash, migration.createdAt]);
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  }
}

/**
 * Reconciles the one historical state created when Workspace migrations were
 * originally numbered 0039-0043, before Account Merge became canonical 0039
 * and the same Workspace DDL was renumbered to 0040-0044.
 *
 * This bridge never executes Workspace DDL. It only records the current
 * migration markers after proving all of the following:
 * - canonical Account Merge 0039 is already recorded;
 * - all five old Workspace markers are present, with no partial lineage;
 * - none of the five current Workspace markers is partially recorded;
 * - every table/column/index/foreign key declared by current 0040-0044 exists.
 *
 * Any ambiguous or partial state fails closed rather than letting Drizzle
 * replay CREATE/ALTER statements over an existing Workspace schema.
 */
export async function bridgeRenumberedWorkspaceMigrations(conn, migrationsFolder) {
  if (!(await hasMigrationTable(conn))) return { bridged: false, reason: "no-migration-table" };

  const currentCreatedAts = CURRENT_WORKSPACE_RENUMBER_MIGRATIONS.map((migration) => migration.createdAt);
  const currentMarkers = await markerSet(conn, currentCreatedAts);
  if (sameMarkerSet(currentMarkers, currentCreatedAts)) return { bridged: false, reason: "already-current" };
  if (currentMarkers.size > 0) {
    throw new Error(
      `Current Workspace migration lineage is partial (${currentMarkers.size}/${currentCreatedAts.length} markers present); refusing renumber reconciliation.`
    );
  }

  const legacyCreatedAts = LEGACY_WORKSPACE_RENUMBER_MIGRATIONS.map((migration) => migration.createdAt);
  const legacyMarkers = await markerSet(conn, legacyCreatedAts);

  const contract = parseExpectedWorkspaceContract(migrationsFolder);
  const presentWorkspaceRows = unwrapRows(
    await conn.query(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name IN (${contract.tables.map(() => "?").join(",")})`,
      contract.tables
    )
  );

  if (legacyMarkers.size === 0) {
    if (presentWorkspaceRows.length > 0) {
      throw new Error(
        "Workspace schema from renumbered migrations exists without either the legacy or current migration marker set; refusing ambiguous reconciliation."
      );
    }
    return { bridged: false, reason: "no-legacy-workspace-lineage" };
  }

  if (!sameMarkerSet(legacyMarkers, legacyCreatedAts)) {
    throw new Error(
      `Legacy Workspace migration lineage is partial (${legacyMarkers.size}/${legacyCreatedAts.length} markers present); refusing renumber reconciliation.`
    );
  }

  const canonicalRows = unwrapRows(
    await conn.query("SELECT created_at AS createdAt FROM `__drizzle_migrations` WHERE created_at = ? LIMIT 1", [
      CANONICAL_ACCOUNT_MERGE_0039_CREATED_AT,
    ])
  );
  if (canonicalRows.length === 0) {
    throw new Error(
      "Legacy Workspace 0039-0043 lineage is present but canonical Account Merge 0039 is not recorded; refusing renumber reconciliation."
    );
  }

  const mismatches = await findWorkspaceRenumberSchemaMismatches(conn, migrationsFolder);
  if (mismatches.length > 0) {
    throw new Error(
      `Legacy Workspace schema does not match current 0040-0044 contract: ${mismatches.join(", ")}. Refusing to alter migration history.`
    );
  }

  await recordCurrentWorkspaceMarkers(conn, migrationsFolder);
  return { bridged: true, reason: "legacy-workspace-renumber-lineage-verified" };
}
