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
 *  orderItems, payments, orderHistory) - see ACCOUNT_RECOVERY_INDIRECT_TABLES's
 *  own doc comment for why these have no direct userId column to reflect
 *  over, and ACCOUNT_MERGE_EXCLUDED_INDIRECT_TABLES below for the
 *  payment/top-up-descendant tables that are deliberately NOT inventoried. */
export const ACCOUNT_MERGE_INDIRECT_TABLES: string[] = ACCOUNT_RECOVERY_INDIRECT_TABLES.map(
  (e) => e.table
);

/**
 * Tables that DO hang off a merge-classified parent (an order, a payment,
 * or a wallet top-up) but are deliberately left OUT of the merge inventory,
 * each with the reason it is safe to exclude. This list is the explicit,
 * reviewed answer to "why isn't <table> counted?" for every such table -
 * it must never become a silent catch-all, exactly like
 * accountRecoveryDataClassification.ts's "deliberately_ignored" category.
 *
 * server/services/accountMergeInventory.test.ts reflects over the real
 * drizzle/schema.ts and proves that every table which either carries an
 * `orderId`/`cartId` column or is scoped to an `order_payment`/`wallet_topup`
 * subject is resolved: inventoried (in db.ts's real ACCOUNT_MERGE_TABLE_NAMES
 * registry, directly or indirectly) XOR listed here with a reason. That
 * check enumerates schema tables independently - it cannot be satisfied by
 * comparing two lists both derived from the recovery classification.
 *
 * Audited against drizzle/schema.ts for IPE-003-C02.
 */
// This PR #45 reconstruction deliberately excludes every post-PR45 legacy
// payment/OCR/anti-replay table. There are therefore no payment-descendant
// tables to exempt from Account Merge inventory in this branch.
export const ACCOUNT_MERGE_EXCLUDED_INDIRECT_TABLES: Array<{
  table: string;
  via: string;
  reason: string;
}> = [];

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
