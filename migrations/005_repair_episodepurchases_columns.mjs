// Safe repair for episodePurchases schema mismatch in production.
//
// Why this is a .mjs script and not a .sql file:
// - Standard MySQL does NOT support `CREATE INDEX IF NOT EXISTS` (that is
//   MariaDB-only syntax and is a hard syntax error on real MySQL).
// - `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` only works on MySQL 8.0.29+,
//   which is not guaranteed for the production instance.
// - This script checks INFORMATION_SCHEMA directly and only issues an
//   ALTER/CREATE INDEX statement for whatever is actually missing, so it
//   is safe to run on any MySQL 5.7+/8.0.x instance and safe to re-run.
//
// Usage:
//   DATABASE_URL="mysql://user:pass@host:port/db" node migrations/005_repair_episodepurchases_columns.mjs
//
// Does NOT touch drizzle/0023_gifted_juggernaut.sql or any other migration.

import mysql from "mysql2/promise";

const REQUIRED_COLUMNS = [
  {
    name: "walletTransactionId",
    ddl: "ADD COLUMN `walletTransactionId` INT NULL COMMENT 'Reference to wallet debit transaction'",
  },
  {
    name: "purchasedAt",
    ddl: "ADD COLUMN `purchasedAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'When the episode was purchased'",
  },
  {
    name: "createdAt",
    ddl: "ADD COLUMN `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'When the record was created'",
  },
];

const REQUIRED_INDEX = {
  name: "episodePurchases_walletTransactionId_idx",
  ddl: "CREATE INDEX `episodePurchases_walletTransactionId_idx` ON `episodePurchases` (`walletTransactionId`)",
};

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. Aborting.");
    process.exit(1);
  }

  const connection = await mysql.createConnection(databaseUrl);

  try {
    const [dbRows] = await connection.query("SELECT DATABASE() AS db");
    const dbName = dbRows[0].db;
    console.log(`Connected to database: ${dbName}`);

    // 1. Confirm table exists before doing anything
    const [tableRows] = await connection.query(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'episodePurchases'`,
      [dbName]
    );
    if (tableRows.length === 0) {
      console.error("episodePurchases table does not exist. This script only repairs an existing table. Aborting.");
      process.exit(1);
    }

    // 2. Inspect actual columns
    const [columnRows] = await connection.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'episodePurchases'`,
      [dbName]
    );
    const existingColumns = new Set(columnRows.map((r) => r.COLUMN_NAME));
    console.log("Existing columns:", [...existingColumns].join(", "));

    // 3. Add only what's missing
    for (const col of REQUIRED_COLUMNS) {
      if (existingColumns.has(col.name)) {
        console.log(`[skip] Column already exists: ${col.name}`);
        continue;
      }
      console.log(`[add] Adding missing column: ${col.name}`);
      await connection.query(`ALTER TABLE \`episodePurchases\` ${col.ddl}`);
      console.log(`[ok] Added column: ${col.name}`);
    }

    // 4. Inspect actual indexes
    const [indexRows] = await connection.query(
      `SELECT DISTINCT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'episodePurchases' AND INDEX_NAME = ?`,
      [dbName, REQUIRED_INDEX.name]
    );
    if (indexRows.length > 0) {
      console.log(`[skip] Index already exists: ${REQUIRED_INDEX.name}`);
    } else {
      console.log(`[add] Creating missing index: ${REQUIRED_INDEX.name}`);
      await connection.query(REQUIRED_INDEX.ddl);
      console.log(`[ok] Created index: ${REQUIRED_INDEX.name}`);
    }

    // 5. Report final column list
    const [finalColumns] = await connection.query(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'episodePurchases' ORDER BY ORDINAL_POSITION`,
      [dbName]
    );
    console.log("\nFinal episodePurchases columns:");
    for (const c of finalColumns) {
      console.log(`  ${c.COLUMN_NAME} | ${c.COLUMN_TYPE} | nullable=${c.IS_NULLABLE} | default=${c.COLUMN_DEFAULT}`);
    }

    // 6. Confirm the query from the bug report now succeeds
    const [testRows] = await connection.query(
      "SELECT id, userId, novelId, episodeId, pricePaid, walletTransactionId, purchasedAt, createdAt FROM episodePurchases LIMIT 1"
    );
    console.log(`\nVerification query succeeded. Rows returned: ${testRows.length}`);
    console.log("Repair complete.");
  } finally {
    await connection.end();
  }
}

main().catch((err) => {
  console.error("Repair failed:", err);
  process.exit(1);
});
