/**
 * The single, exhaustively-audited inventory of every user-referencing
 * column in drizzle/schema.ts, and how each one is treated by the Admin
 * Account Recovery workflow's safety checks
 * (server/db.ts's findAccountRecoveryEconomicData/
 * findAccountRecoveryUserOwnedData, composed by
 * server/services/accountRecoveryService.ts's assessAccountRecoverySafety).
 *
 * This list is not just documentation - it is CROSS-CHECKED by
 * server/services/accountRecoveryDataClassification.test.ts against a
 * runtime reflection over every real `drizzle/schema.ts` table (via
 * drizzle-orm's `getTableColumns`/`is(..., MySqlTable)`, not a hand-typed
 * guess) for exactly two properties:
 *   1. every user-referencing (dataType "number", name matching
 *      /userid|ownerid|createdby|reviewedby|approvedby|actorid|adminid/i)
 *      column that actually exists in the schema has a matching entry
 *      here (fails loudly if a new column like this is ever added to the
 *      schema without a corresponding classification decision - the whole
 *      point of this file existing at all);
 *   2. every entry here still corresponds to a real, existing
 *      table+column (fails loudly if a table/column is renamed or removed
 *      and this file silently goes stale).
 *
 * Categories:
 * - "economic_hard_block": Category A from the recovery-safety spec -
 *   wallet/balance/points, purchases, orders, payments, transactions,
 *   purchased episodes, coupons/financial rights. ANY row here on the
 *   source account is an unconditional, no-admin-override block.
 * - "user_owned_hard_block": Category B - cart, library/wishlist, reading
 *   progress, check-ins, and any other non-economic per-user data. As of
 *   the empty-source-account invariant, this is ALSO an unconditional,
 *   no-admin-override block - automated recovery is only ever permitted
 *   when the source account is genuinely, completely empty. This tool
 *   never moves, merges, or deletes this data or the source account
 *   itself; a non-empty source always routes to "blocked"
 *   (Advanced Account Merge, handled outside this tool).
 * - "recovery_internal": the account-recovery workflow's OWN subject
 *   matter (the authIdentities row being moved, the request/audit rows
 *   themselves) - not a THIRD-PARTY table this workflow needs to check
 *   for orphaned data, it IS the mechanism.
 * - "deliberately_ignored": a user-id-shaped column that is NOT the
 *   source account's own data - almost always an admin/system actor
 *   identity (who reviewed/approved/created something), or a column whose
 *   underlying row is already covered transitively by a DIFFERENT,
 *   already-classified column (see each entry's `reason`). Every entry in
 *   this category states, explicitly, why it is safe to exclude - this
 *   category must never be used as a silent catch-all.
 * - "merge_internal": the Advanced Account Merge feature's (IPE-003+) OWN
 *   subject matter - accountMergeCases/accountMergeAuditLogs' sourceUserId/
 *   targetUserId columns. Exactly analogous to "recovery_internal" above
 *   (it IS the mechanism, not third-party data this workflow scans for),
 *   kept as its own category rather than folded into "recovery_internal"
 *   only because the name "recovery_internal" specifically means the
 *   Account Recovery workflow and would be misleading applied to a
 *   different feature's bookkeeping.
 */

export type AccountRecoveryDataCategory =
  | "economic_hard_block"
  | "user_owned_hard_block"
  | "recovery_internal"
  | "deliberately_ignored"
  | "merge_internal";

export type AccountRecoveryColumnClassification = {
  table: string;
  column: string;
  category: AccountRecoveryDataCategory;
  reason: string;
};

export const ACCOUNT_RECOVERY_USER_DATA_CLASSIFICATION: AccountRecoveryColumnClassification[] = [
  // ---- recovery_internal: the workflow's own subject matter ----
  {
    table: "authIdentities",
    column: "userId",
    category: "recovery_internal",
    reason: "The exact row this workflow exists to move - not third-party data to check for, it IS the mechanism.",
  },
  {
    table: "accountRecoveryRequests",
    column: "requesterUserId",
    category: "recovery_internal",
    reason: "The recovery request's own subject (= the source account) - handled by the workflow itself, not a table it scans for orphaned data.",
  },
  {
    table: "accountRecoveryRequests",
    column: "requestedLegacyUserId",
    category: "recovery_internal",
    reason: "An unverified, user-typed claim shown to the admin for context only - never trusted as evidence, never used to look up data (see assessAccountRecoverySafety's docstring).",
  },
  {
    table: "accountRecoveryRequests",
    column: "sourceUserId",
    category: "recovery_internal",
    reason: "Set by executeAccountRecovery itself once approved - the workflow's own audit trail, not a foreign table.",
  },
  {
    table: "accountRecoveryRequests",
    column: "targetUserId",
    category: "recovery_internal",
    reason: "Set by executeAccountRecovery itself once approved - the workflow's own audit trail, not a foreign table.",
  },
  {
    table: "accountRecoveryAuditLogs",
    column: "sourceUserId",
    category: "recovery_internal",
    reason: "The workflow's own audit trail of its own actions.",
  },
  {
    table: "accountRecoveryAuditLogs",
    column: "targetUserId",
    category: "recovery_internal",
    reason: "The workflow's own audit trail of its own actions.",
  },

  // ---- merge_internal: Advanced Account Merge's (IPE-003+) own subject matter ----
  {
    table: "accountMergeCases",
    column: "sourceUserId",
    category: "merge_internal",
    reason: "The merge case's own subject (= the account recovery source) - handled by the merge workflow itself, not a table it scans for orphaned data.",
  },
  {
    table: "accountMergeCases",
    column: "targetUserId",
    category: "merge_internal",
    reason: "The merge case's own subject (= the account the source is merged into) - handled by the merge workflow itself, not a table it scans for orphaned data.",
  },
  {
    table: "accountMergeAuditLogs",
    column: "sourceUserId",
    category: "merge_internal",
    reason: "The workflow's own audit trail of its own actions.",
  },
  {
    table: "accountMergeAuditLogs",
    column: "targetUserId",
    category: "merge_internal",
    reason: "The workflow's own audit trail of its own actions.",
  },

  // ---- deliberately_ignored: admin/system actor identities, never the source's own data ----
  {
    table: "accountMergeCases",
    column: "createdByAdminId",
    category: "deliberately_ignored",
    reason: "The ADMIN who initiated the merge case, not the source account's own data.",
  },
  {
    table: "accountMergeAuditLogs",
    column: "actorAdminId",
    category: "deliberately_ignored",
    reason: "The ADMIN who performed the audited merge action, not the source account's own data.",
  },
  {
    table: "accountRecoveryRequests",
    column: "reviewedByAdminId",
    category: "deliberately_ignored",
    reason: "The ADMIN who reviewed the request, not the source account's own data.",
  },
  {
    table: "accountRecoveryAuditLogs",
    column: "actorAdminId",
    category: "deliberately_ignored",
    reason: "The ADMIN who performed the audited action, not the source account's own data.",
  },
  {
    table: "dailyCheckinCampaigns",
    column: "createdBy",
    category: "deliberately_ignored",
    reason: "The ADMIN who authored a global campaign config, not per-user data - this table has no per-user rows at all.",
  },
  {
    table: "orderHistory",
    column: "actorUserId",
    category: "deliberately_ignored",
    reason: "Records WHO performed an order status transition (often an admin/system actor, not necessarily the customer) - the underlying order is already economic_hard_block via orders.userId, so any order this actually belongs to is already caught there.",
  },
  {
    table: "payments",
    column: "reviewedByUserId",
    category: "deliberately_ignored",
    reason: "The ADMIN/reviewer identity, not the paying customer - payments have no direct userId at all (see the separate indirect-coverage note below); this column specifically is never the source account's own data.",
  },
  {
    table: "payments",
    column: "approvedByAdminId",
    category: "deliberately_ignored",
    reason: "The ADMIN who approved the payment, not the paying customer.",
  },
  {
    table: "topupLogs",
    column: "createdBy",
    category: "deliberately_ignored",
    reason: "The admin/system actor who wrote the log entry, not the top-up's own owner (see topupLogs.userId, already economic_hard_block).",
  },
  {
    table: "adminUserAuditLogs",
    column: "actorAdminId",
    category: "deliberately_ignored",
    reason: "The Admin Users Management feature's OWN append-only audit trail (server/services/adminUserManagementService.ts) - the admin who performed a name/role edit or delete, not the account-recovery source's own data. Unrelated to this workflow entirely.",
  },
  {
    table: "adminUserAuditLogs",
    column: "targetUserId",
    category: "deliberately_ignored",
    reason: "The Admin Users Management feature's OWN append-only audit trail - the user a name/role edit or delete was performed on, tracked by that feature's own delete-safety check (server/services/adminUserDeletionClassification.ts), not the account-recovery workflow.",
  },
  {
    table: "walletTopups",
    column: "reviewedByUserId",
    category: "deliberately_ignored",
    reason: "The ADMIN/reviewer identity, not the top-up's own owner (see walletTopups.userId, already economic_hard_block).",
  },
  {
    table: "walletTopups",
    column: "approvedByAdminId",
    category: "deliberately_ignored",
    reason: "The ADMIN who approved the top-up, not its own owner.",
  },
  {
    table: "paymentSlipReviewResolutions",
    column: "adminUserId",
    category: "deliberately_ignored",
    reason: "The ADMIN who resolved a legacy reference case ambiguity, not the owner of the payment being resolved. An admin-actor identity, consistent with the other actor columns above; the payment's own ownership is already covered transitively via payments -> orders.userId.",
  },
  {
    table: "ocrVerificationAttempts",
    column: "initiatedByUserId",
    category: "deliberately_ignored",
    reason: "The ADMIN who requested an OCR recheck, not the owner of the payment being rechecked. NULL for automatic attempts. Consistent with the other admin-actor columns above; the payment's own ownership is already covered transitively via payments -> orders.userId.",
  },
  {
    table: "paymentSlipClaims",
    column: "userId",
    category: "deliberately_ignored",
    reason:
      "The global anti-replay claim registry. A claim row records that ONE bank transaction was consumed by ONE submission; it is not user-owned data this workflow moves or must protect, and any account with a claim is ALREADY hard-blocked transitively by the orders/walletTopups row that created it. Note the Admin Users Management inventory classifies this same column as \"economic\" instead - deliberately, because hard-DELETING a user must never remove their claims (that would re-open every slip they used for replay), which is a different question from whether account RECOVERY needs to inspect them.",
  },

  // ---- economic_hard_block: Category A - wallet/points/purchases/orders/payments/transactions/coupons ----
  { table: "orders", column: "userId", category: "economic_hard_block", reason: "An order is a financial transaction record." },
  { table: "purchases", column: "userId", category: "economic_hard_block", reason: "A content-purchase entitlement." },
  { table: "episodePurchases", column: "userId", category: "economic_hard_block", reason: "A wallet-paid content-purchase entitlement." },
  { table: "walletAccounts", column: "userId", category: "economic_hard_block", reason: "The wallet balance itself." },
  { table: "walletTransactions", column: "userId", category: "economic_hard_block", reason: "A wallet ledger entry." },
  { table: "walletTopups", column: "userId", category: "economic_hard_block", reason: "A wallet top-up (money in)." },
  { table: "topupLogs", column: "userId", category: "economic_hard_block", reason: "An admin-audit record of a real credited top-up - financial history." },
  { table: "pointsTransactions", column: "userId", category: "economic_hard_block", reason: "The points-balance ledger - a redeemable financial right." },
  { table: "couponUsages", column: "userId", category: "economic_hard_block", reason: "A record of a coupon (discount/financial right) having been spent on a real order." },
  {
    table: "coupons",
    column: "ownerUserId",
    category: "economic_hard_block",
    reason: "A personal coupon (scope=\"user\") is itself an unredeemed financial right belonging to the source account - previously NOT checked by findAccountRecoveryEconomicData; added as part of the empty-source-account invariant fix.",
  },
  { table: "sportsMatchVotes", column: "userId", category: "economic_hard_block", reason: "Records real points spent on a wager, and may reference an issued reward coupon." },
  { table: "sportsMatchRewards", column: "userId", category: "economic_hard_block", reason: "A reward coupon issued to this user - a financial right." },
  { table: "dailyCheckinRewardGrants", column: "userId", category: "economic_hard_block", reason: "A granted points/coupon reward - a financial right, distinct from the check-in event itself (see dailyCheckins.userId below)." },

  // ---- user_owned_hard_block: Category B - cart/library/reading progress/check-ins ----
  { table: "carts", column: "userId", category: "user_owned_hard_block", reason: "The user's shopping cart." },
  { table: "wishlists", column: "userId", category: "user_owned_hard_block", reason: "The user's wishlist/library." },
  { table: "readingProgress", column: "userId", category: "user_owned_hard_block", reason: "Per-episode reading position/progress." },
  {
    table: "dailyCheckins",
    column: "userId",
    category: "user_owned_hard_block",
    reason: "The check-in EVENT record itself (date/streak) - the task spec's own Category B example list names \"check-ins\" explicitly; the actual reward VALUE this can carry is tracked separately and classified as economic (see dailyCheckinRewardGrants.userId above).",
  },
];

/**
 * Tables with NO direct user-id-shaped column at all, whose rows are
 * still transitively "this user's data" only through a foreign key to an
 * already-classified table. Documented here for audit completeness (the
 * task explicitly calls out "ความสัมพันธ์ทางอ้อม เช่น cartItems ->
 * carts.userId") - NOT part of the reflection-based column check above
 * (there is no user-id column on these tables to reflect over), and
 * intentionally not queried a second time by
 * findAccountRecoveryEconomicData/findAccountRecoveryUserOwnedData: a
 * cartItems/orderItems/payments/orderHistory row can never exist without
 * its parent carts/orders row, which is already checked directly.
 *
 * A note on membership: a table earns a place here when it has NO direct
 * user column AND its rows are wholly owned by a single classified parent
 * row. orderHistory qualifies even though it also carries an actorUserId
 * (an actor, not an owner - classified deliberately_ignored above). Tables
 * that merely reference a payment/top-up by id but represent
 * cross-account, globally-scoped anti-replay or OCR-diagnostic state
 * (paymentSlipClaims, paymentSlipLegacyCollisions, paymentSlipLegacyUnknown,
 * ocrVerificationAttempts, paymentSlipReviewResolutions) are deliberately
 * NOT here - see accountMergeInventory.ts's
 * ACCOUNT_MERGE_EXCLUDED_INDIRECT_TABLES for each one's reasoned exclusion.
 */
export const ACCOUNT_RECOVERY_INDIRECT_TABLES: Array<{
  table: string;
  via: string;
  category: Extract<AccountRecoveryDataCategory, "economic_hard_block" | "user_owned_hard_block">;
  reason: string;
}> = [
  {
    table: "cartItems",
    via: "cartId -> carts.userId",
    category: "user_owned_hard_block",
    reason: "Cannot exist without a parent carts row, which is already checked directly.",
  },
  {
    table: "orderItems",
    via: "orderId -> orders.userId",
    category: "economic_hard_block",
    reason: "Cannot exist without a parent orders row, which is already checked directly.",
  },
  {
    table: "payments",
    via: "orderId -> orders.userId",
    category: "economic_hard_block",
    reason: "Cannot exist without a parent orders row, which is already checked directly. (payments.reviewedByUserId/approvedByAdminId are separately classified above as deliberately_ignored admin-actor columns - this entry is about the payment row's own ownership, not those columns.)",
  },
  {
    table: "orderHistory",
    via: "orderId -> orders.userId",
    category: "economic_hard_block",
    reason:
      "The status-transition audit trail of the source account's own orders - every row hangs off a parent orders row (already economic_hard_block) and cannot exist without it, so Account Recovery's presence checks are covered by orders itself. Listed here because the Advanced Account Merge inventory (accountMergeInventory.ts), which needs a COMPLETE per-row picture of everything transitively owned by the source rather than mere presence, must count and preserve it. orderHistory.actorUserId is separately classified deliberately_ignored above (it records WHO performed a transition, often an admin/system actor); this entry is about the row's ownership via its order, which the actor column does not represent.",
  },
];
