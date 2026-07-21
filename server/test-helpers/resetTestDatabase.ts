// Resets the disposable test database to an empty baseline for the app
// tables this repo's fixtures/integration tests actually use. Only ever
// called after the live "SELECT DATABASE()" check (see
// liveTestDatabaseCheck.ts) has already passed - never exported in a form
// that could run without that check, by construction (see
// scripts/test-db-prepare.ts, the only caller).
//
// Deletes rows (not DROP/TRUNCATE the tables themselves - the schema is
// managed exclusively by migrations) in child-before-parent order. There
// are no DB-enforced foreign keys in this schema (verified: no
// `references()` anywhere in drizzle/schema.ts), so this order is a
// correctness convention, not a constraint requirement.
import { drizzle } from "drizzle-orm/mysql2";
import {
  dailyCheckins,
  couponUsages,
  coupons,
  orderItems,
  payments,
  orders,
  episodes,
  novels,
  users,
} from "../../drizzle/schema";

export async function resetTestDatabase(db: ReturnType<typeof drizzle>): Promise<void> {
  const tables = [dailyCheckins, couponUsages, coupons, orderItems, payments, orders, episodes, novels, users];
  for (const table of tables) {
    await db.delete(table as any);
  }
}
