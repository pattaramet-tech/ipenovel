/** Type declarations for migrate.mjs's testable exports (findMissingSchemaObjects and its required-object lists). main() itself is not exported - it only runs when this file is executed directly (see the isMain guard). */

export interface RequiredIndex {
  table: string;
  index: string;
}

export interface RequiredColumn {
  table: string;
  column: string;
}

export interface QueryableConnection {
  query(sql: string, params?: unknown[]): Promise<[any[], unknown?]>;
}

export declare const REQUIRED_TABLES: string[];
export declare const REQUIRED_COLUMNS: RequiredColumn[];
export declare const REQUIRED_INDEXES: RequiredIndex[];

export declare function findMissingSchemaObjects(conn: QueryableConnection): Promise<string[]>;
