export interface QueryableConnection {
  query(sql: string, params?: unknown[]): Promise<[any[], unknown?]>;
}

export declare const RECONSTRUCTED_SELECTED_MIGRATION: {
  tag: string;
  createdAt: number;
  file: string;
};
export declare const LEGACY_ACCOUNT_SPORTS_MIGRATION_CREATED_AT: number[];
export declare const LEGACY_WORKSPACE_MIGRATION_CREATED_AT: number[];
export declare const LEGACY_SELECTED_MIGRATION_CREATED_AT: number[];
export declare const LEGACY_ACCOUNT_SPORTS_REQUIRED_TABLES: string[];
export declare const LEGACY_WORKSPACE_REQUIRED_TABLES: string[];
export declare const LEGACY_SELECTED_REQUIRED_TABLES: string[];
export declare const LEGACY_SELECTED_REQUIRED_COLUMNS: Array<{
  table: string;
  column: string;
  nullable: boolean;
}>;
export declare const LEGACY_SELECTED_REQUIRED_INDEXES: Array<{
  table: string;
  index: string;
}>;
export declare const LEGACY_WORKSPACE_REQUIRED_INDEXES: Array<{
  table: string;
  index: string;
}>;
export declare const LEGACY_WORKSPACE_REQUIRED_FOREIGN_KEYS: Array<{
  table: string;
  column: string;
  referencedTable: string;
  referencedColumn: string;
}>;

export declare function findLegacySelectedSchemaMismatches(conn: QueryableConnection): Promise<string[]>;
export declare function bridgeLegacySelectedFeatureMigration(
  conn: QueryableConnection,
  migrationsFolder: string
): Promise<{ bridged: boolean; reason: string }>;
