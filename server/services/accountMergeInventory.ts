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
export const ACCOUNT_MERGE_EXCLUDED_INDIRECT_TABLES: Array<{
  table: string;
  via: string;
  reason: string;
}> = [
  {
    table: "paymentSlipClaims",
    via: "userId (direct) + sourceId -> payments.id / walletTopups.id",
    reason:
      "The GLOBAL anti-replay claim registry: one row = one bank transaction consumed once, across every account. It is never re-parented, moved, or deleted by any account workflow - doing so would re-open every slip the source ever used for replay (see accountRecoveryDataClassification.ts's paymentSlipClaims.userId entry). The merge preview still surfaces the source's row count for the admin via getAccountMergePaymentSlipClaimsCount + an explanatory note; it is reported, not inventoried for transfer. IPE-003 scope forbids any anti-replay change.",
  },
  {
    table: "paymentSlipLegacyCollisions",
    via: "sourceId -> payments.id / walletTopups.id",
    reason:
      "Backfill-only, immutable record of a KNOWN historical strong-identifier collision across two or more already-approved financial rows. Global anti-replay state, never written by a live approval and never account-scoped - a merge must leave it byte-for-byte untouched. IPE-003 scope forbids any anti-replay change.",
  },
  {
    table: "paymentSlipLegacyUnknown",
    via: "sourceId -> payments.id / walletTopups.id",
    reason:
      "Backfill-only, immutable record that a historical row's file identity is permanently unrecoverable. Global anti-replay bookkeeping, explicitly 'never consulted to block or approve anything' and never account-scoped - a merge must not touch it. IPE-003 scope forbids any anti-replay change.",
  },
  {
    table: "ocrVerificationAttempts",
    via: "subjectId -> payments.id / walletTopups.id (initiatedByUserId is an admin actor, classified deliberately_ignored)",
    reason:
      "Sanitized OCR attempt diagnostics for a payment/top-up. Not user-owned economic or entitlement data - it is provider-outage-vs-bad-slip telemetry keyed to the subject, and the subject's own ownership is already inventoried via orders/payments. Re-parenting diagnostics rows carries no user-visible value and IPE-003 keeps OCR/anti-replay behavior unchanged.",
  },
  {
    table: "paymentSlipReviewResolutions",
    via: "subjectId -> payments.id / walletTopups.id (adminUserId is an admin actor, classified deliberately_ignored)",
    reason:
      "Audited human overrides of an automated anti-replay signal on a payment/top-up. An admin-adjudication audit trail, not the source account's own data; the underlying payment's ownership is already inventoried via orders/payments. IPE-003 scope forbids any anti-replay change.",
  },
  {
    table: "slipEvidenceBindings",
    via: "sourceId -> payments.id / walletTopups.id (ownerUserId is an immutable historical snapshot)",
    reason:
      "The write-once evidence chain for exact uploaded bytes and its historical owner. Account merges must leave it immutable; ownership of the underlying financial subject is already inventoried through orders/payments or walletTopups.",
  },
];

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
