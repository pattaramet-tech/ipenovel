/** TEST ONLY. Never import from a CLI or application module.
 * Builds only the writer's table subset from actual Drizzle column/index/FK
 * metadata. No application migrations, seed scripts or live credentials. */
import { readFile } from "node:fs/promises";
import { platform } from "node:os";
import { SQL, getTableName } from "drizzle-orm";
import { getTableConfig, MySqlDialect } from "drizzle-orm/mysql-core";
import mysql, { type Connection, type ConnectionOptions } from "mysql2/promise";
import {
  users,
  orders,
  payments,
  walletTopups,
  accountMutationGuards,
  accountMergeCases,
  paymentSlipClaims,
  slipEvidenceBindings,
  slipEvidenceUploads,
  paymentSlipLegacyUnknown,
  paymentSlipLegacyCollisions,
} from "../../drizzle/schema";

export function isolatedRepairDatabaseOptions(
  env: NodeJS.ProcessEnv
): ConnectionOptions {
  if (platform() !== "linux")
    throw new Error("ISOLATED_REPAIR_REQUIRES_REAL_LINUX");
  if (env.DATABASE_URL || env.TEST_DATABASE_URL)
    throw new Error("ISOLATED_REPAIR_FORBIDS_AMBIENT_DATABASE_URLS");
  let url: URL;
  try {
    if (!env.IPE_REPAIR_TEST_DB_URL) throw new Error();
    url = new URL(env.IPE_REPAIR_TEST_DB_URL);
  } catch {
    throw new Error("ISOLATED_REPAIR_EXPLICIT_DATABASE_URL_REQUIRED");
  }
  const docker =
    url.hostname === "ipe-repair-mariadb" &&
    env.IPE_REPAIR_TEST_ALLOW_DOCKER_SERVICE === "1";
  if (
    url.protocol !== "mysql:" ||
    url.search ||
    url.hash ||
    (!docker && url.hostname !== "127.0.0.1") ||
    !/^\/ipe_repair_test_[a-f0-9]{12}$/.test(url.pathname) ||
    !url.username ||
    !url.password ||
    !url.port
  )
    throw new Error("ISOLATED_REPAIR_DATABASE_TARGET_REJECTED");
  return {
    host: url.hostname,
    port: Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    connectTimeout: 5000,
    dateStrings: true,
    decimalNumbers: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
  };
}

export async function openIsolatedRepairDatabase(
  options: ConnectionOptions
): Promise<Connection> {
  // All callers receive options only from the strict parser; do not accept app
  // options supplied to the writer's test dependency seam.
  const c = await mysql.createConnection(options);
  try {
    const [rows] = await c.query<any[]>(
      "SELECT VERSION() AS version, DATABASE() AS db"
    );
    if (
      rows.length !== 1 ||
      !/^11\.4\.\d+-MariaDB/.test(rows[0].version) ||
      rows[0].db !== options.database ||
      !/^ipe_repair_test_[a-f0-9]{12}$/.test(rows[0].db)
    )
      throw new Error("ISOLATED_REPAIR_REAL_MARIADB_11_4_REQUIRED");
    await c.query("SET SESSION time_zone = '+00:00'");
    await c.query(
      "SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'"
    );
    return c;
  } catch (error) {
    c.destroy();
    throw error;
  }
}

const tables = [
  users,
  orders,
  accountMutationGuards,
  accountMergeCases,
  slipEvidenceUploads,
  slipEvidenceBindings,
  payments,
  walletTopups,
  paymentSlipClaims,
  paymentSlipLegacyUnknown,
  paymentSlipLegacyCollisions,
];
const dialect = new MySqlDialect();
const quote = (name: string) => {
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name))
    throw new Error("UNSAFE_SYNTHETIC_IDENTIFIER");
  return `\`${name}\``;
};
const literal = (value: unknown): string => {
  if (value instanceof SQL) {
    const query = dialect.sqlToQuery(value);
    if (query.params.length)
      throw new Error("UNSUPPORTED_SYNTHETIC_SCHEMA_EXPRESSION");
    return query.sql;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return mysql.escape(value);
  throw new Error("UNSUPPORTED_SYNTHETIC_SCHEMA_LITERAL");
};

export async function assertEmptyIsolatedDatabase(
  c: Connection
): Promise<void> {
  const [rows] = await c.query<any[]>(
    "SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE()"
  );
  if (rows.length) throw new Error("ISOLATED_REPAIR_DATABASE_MUST_START_EMPTY");
}

export async function createIsolatedRepairSchema(
  c: Connection,
  owned: string[]
): Promise<void> {
  for (const table of tables) {
    const config = getTableConfig(table);
    const definitions = config.columns.map(column => {
      const typed = column as typeof column & {
        autoIncrement?: boolean;
        hasOnUpdateNow?: boolean;
      };
      let definition = `${quote(column.name)} ${column.getSQLType()}`;
      if (column.generated) {
        const expression =
          typeof column.generated.as === "function"
            ? column.generated.as()
            : column.generated.as;
        definition += ` GENERATED ALWAYS AS (${literal(expression)}) ${column.generated.mode ?? "virtual"}`;
      } else {
        definition += column.notNull ? " NOT NULL" : " NULL";
        if (column.default !== undefined)
          definition += ` DEFAULT ${literal(column.default)}`;
        if (typed.autoIncrement) definition += " AUTO_INCREMENT";
        if (typed.hasOnUpdateNow) definition += " ON UPDATE CURRENT_TIMESTAMP";
      }
      if (column.primary) definition += " PRIMARY KEY";
      if (column.isUnique) definition += " UNIQUE";
      return definition;
    });
    for (const index of config.indexes) {
      const i = index.config;
      definitions.push(
        `${i.unique ? "UNIQUE " : ""}KEY ${quote(i.name)} (${i.columns
          .map(column => {
            if (!("name" in column))
              throw new Error("UNSUPPORTED_SYNTHETIC_INDEX");
            return quote(column.name);
          })
          .join(", ")})`
      );
    }
    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      if (!tables.some(t => getTableName(t) === getTableName(ref.foreignTable)))
        throw new Error("OUTSIDE_SYNTHETIC_SCHEMA_FOREIGN_KEY");
      definitions.push(
        `CONSTRAINT ${quote(fk.getName())} FOREIGN KEY (${ref.columns.map(c => quote(c.name)).join(", ")}) REFERENCES ${quote(getTableName(ref.foreignTable))} (${ref.foreignColumns.map(c => quote(c.name)).join(", ")}) ON DELETE ${fk.onDelete ?? "no action"} ON UPDATE ${fk.onUpdate ?? "no action"}`
      );
    }
    await c.query(
      `CREATE TABLE ${quote(config.name)} (${definitions.join(", ")}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );
    owned.push(config.name);
  }
  // Actual manually reviewed DDL, never a rewritten mock audit schema.
  const ddl = await readFile(
    new URL(
      "../../scripts/manual/legacy-slip-reference-repair-audit.sql",
      import.meta.url
    ),
    "utf8"
  );
  await c.query(ddl);
  owned.push("legacySlipReferenceRepairAudit");
}

export async function dropOwnedIsolatedTables(
  c: Connection,
  owned: string[]
): Promise<void> {
  const [rows] = await c.query<any[]>("SELECT DATABASE() AS db");
  if (rows.length !== 1 || !/^ipe_repair_test_[a-f0-9]{12}$/.test(rows[0].db))
    throw new Error("ISOLATED_REPAIR_CLEANUP_TARGET_REJECTED");
  // No DROP DATABASE, glob, pre-existing table, foreign-key-disable or general
  // fixture cleanup. Only successfully created names tracked in this process.
  while (owned.length) {
    await c.query(`DROP TABLE ${quote(owned[owned.length - 1])}`);
    owned.pop();
  }
}

export async function insertSyntheticRow(
  c: Connection,
  table: string,
  row: Record<string, unknown>
): Promise<void> {
  if (!tables.some(t => getTableName(t) === table))
    throw new Error("UNKNOWN_SYNTHETIC_TABLE");
  const keys = Object.keys(row);
  await c.query(
    `INSERT INTO ${quote(table)} (${keys.map(quote).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    Object.values(row)
  );
}
