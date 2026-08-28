import {
  ACCOUNT_RECOVERY_USER_DATA_CLASSIFICATION,
  ACCOUNT_RECOVERY_INDIRECT_TABLES,
} from "./accountRecoveryDataClassification";

/**
 * The Advanced Account Merge inventory's table list - deliberately DERIVED
 * from the already-exhaustive, reflection-tested Account Recovery
 * classification (accountRecoveryDataClassification.ts) rather than a
 * second, hand-maintained list. Every table Account Recovery treats as
 * "the source account's own data" (economic_hard_block/
 * user_owned_hard_block, direct or indirect) is exactly the set of tables
 * a full account merge must also account for - a source account that
 * reached the merge preview is, by construction, the non-empty case
 * Account Recovery's own empty-source-account invariant routes here (see
 * accountRecoveryService.ts's blockReasons: "requires Advanced Account
 * Merge"). Deriving from that single source of truth means a future
 * column/table added to the recovery classification is automatically
 * covered here too, with no second place to remember to update - drift
 * between the two lists is structurally impossible, not just tested for
 * (though server/services/accountMergeInventory.test.ts also proves the
 * real query registry in server/db.ts matches this list exactly, the same
 * "no drift between the inventory and the real queries" pattern already
 * used by ACCOUNT_RECOVERY_ECONOMIC_TABLE_NAMES/
 * ACCOUNT_RECOVERY_USER_OWNED_TABLE_NAMES).
 */
export const ACCOUNT_MERGE_DIRECT_TABLES: string[] = ACCOUNT_RECOVERY_USER_DATA_CLASSIFICATION.filter(
  (c) => c.category === "economic_hard_block" || c.category === "user_owned_hard_block"
).map((c) => c.table);

/** Same derivation for the no-direct-column, FK-only tables (cartItems,
 *  orderItems, payments) - see ACCOUNT_RECOVERY_INDIRECT_TABLES's own
 *  doc comment for why these have no direct userId column to reflect
 *  over. */
export const ACCOUNT_MERGE_INDIRECT_TABLES: string[] = ACCOUNT_RECOVERY_INDIRECT_TABLES.map(
  (e) => e.table
);

/**
 * Tables enforcing UNIQUE(userId) - at most one row per account. A source
 * account that owns one of these (walletAccounts' balance, carts' single
 * shopping cart) and a target that ALSO already owns one cannot simply be
 * re-parented (that would violate the unique constraint outright); a later
 * execution phase must explicitly consolidate them (e.g. sum a balance).
 * Kept here, not hand-duplicated in server/db.ts or the preview service -
 * server/services/accountMergeInventory.test.ts proves this matches the
 * real query registry's `isSingleton: true` entries exactly (same
 * no-drift pattern as ACCOUNT_MERGE_DIRECT_TABLES above), and
 * accountMergePreviewService.ts's projectedAction/warning derivation reads
 * this list rather than re-deriving its own notion of which tables are
 * singletons.
 */
export const ACCOUNT_MERGE_SINGLETON_TABLES: string[] = ["walletAccounts", "carts"];
