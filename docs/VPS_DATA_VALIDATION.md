# VPS Data Validation Queries

Read-only queries for comparing the source database (production TiDB) against the target database (VPS MariaDB) before, during, and after cutover. **Every query in this document is a `SELECT`. None of them write, and none of them require credentials to be pasted anywhere — run them by hand via the team's normal DB client, or feed the results into `scripts/vps-migration/preflight.mjs`/`compare-snapshots.mjs` per that script's README.**

Column and table names below were read directly from `drizzle/schema.ts` at repo HEAD `da3a65e16b51ed7e81cead6fd3559e444fd3a814` — not guessed. Two notes on the requested table list before the queries:

- **There is no separate `admins` table.** Admin accounts are rows in `users` with `role = 'admin'` (`drizzle/schema.ts:27`). All "admins" queries below query `users WHERE role = 'admin'`.
- **The migration journal is `drizzle/meta/_journal.json`** (a file in this repo, 33 entries, `idx` 0–32), not a database table on its own. Drizzle's migrator additionally tracks applied migrations in a database table it creates itself — by convention this is `__drizzle_migrations`, but this could not be directly confirmed from installed package source in this sandbox (no `node_modules` present in the audited worktree). **Verify the exact table name against the live source database** (`SHOW TABLES LIKE '%drizzle%';`) before relying on the migration-count query in §14 — it's written defensively (see that section) specifically because of this.

## How to use these queries

1. Run every query in a section against the **source** database, save the results.
2. Run the same query against the **target** database once data has been imported and migrated, save the results.
3. Feed both result sets (as the JSON snapshot shape described in `scripts/vps-migration/README.md`) into `scripts/vps-migration/compare-snapshots.mjs`, or diff by hand for a smaller ad-hoc check.
4. Any `-- ENGINE-SPECIFIC` marked query needs its counterpart run on the other engine before comparing — see the note on each.

None of these queries assume MariaDB-only or TiDB-only syntax except where explicitly marked `-- ENGINE-SPECIFIC`; the rest use plain ANSI-ish `SELECT`/`COUNT`/`SUM`/`GROUP BY`/`JOIN` supported identically by both.

---

## 1. `users`

```sql
-- Row count
SELECT COUNT(*) AS row_count FROM users;

-- MIN/MAX id and createdAt
SELECT MIN(id) AS min_id, MAX(id) AS max_id,
       MIN(createdAt) AS min_created_at, MAX(createdAt) AS max_created_at
FROM users;

-- Role distribution (admins = role='admin', see note above)
SELECT role, COUNT(*) AS count FROM users GROUP BY role;

-- Duplicate openId check (should always be zero - openId has a UNIQUE constraint,
-- this is a defense-in-depth check for the import/migration process itself)
SELECT openId, COUNT(*) AS count
FROM users
GROUP BY openId
HAVING COUNT(*) > 1;

-- Users with a passwordHash set (local admin accounts) vs OAuth-only accounts
SELECT
  SUM(CASE WHEN passwordHash IS NOT NULL THEN 1 ELSE 0 END) AS local_password_accounts,
  SUM(CASE WHEN passwordHash IS NULL THEN 1 ELSE 0 END) AS oauth_only_accounts
FROM users;
```

## 2. "admins" (`users WHERE role = 'admin'`)

```sql
SELECT COUNT(*) AS admin_count FROM users WHERE role = 'admin';

SELECT id, openId, email, createdAt, lastSignedIn
FROM users
WHERE role = 'admin'
ORDER BY id;
```

## 3. `novels`

```sql
SELECT COUNT(*) AS row_count FROM novels;

SELECT MIN(id) AS min_id, MAX(id) AS max_id,
       MIN(createdAt) AS min_created_at, MAX(createdAt) AS max_created_at
FROM novels;

SELECT publicationStatus, COUNT(*) AS count FROM novels GROUP BY publicationStatus;
SELECT storyStatus, COUNT(*) AS count FROM novels GROUP BY storyStatus;

-- Duplicate slug check (slug has a UNIQUE constraint; defense-in-depth)
SELECT slug, COUNT(*) AS count FROM novels GROUP BY slug HAVING COUNT(*) > 1;
```

## 4. `episodes`

```sql
SELECT COUNT(*) AS row_count FROM episodes;

SELECT MIN(id) AS min_id, MAX(id) AS max_id,
       MIN(createdAt) AS min_created_at, MAX(createdAt) AS max_created_at
FROM episodes;

SELECT saleMode, COUNT(*) AS count FROM episodes GROUP BY saleMode;
SELECT isFree, isPublished, COUNT(*) AS count FROM episodes GROUP BY isFree, isPublished;

-- Orphan check: episodes referencing a novelId that no longer exists
SELECT e.id AS episode_id, e.novelId
FROM episodes e
LEFT JOIN novels n ON n.id = e.novelId
WHERE n.id IS NULL;

-- Duplicate (novelId, episodeNumber) check (has a UNIQUE constraint; defense-in-depth)
SELECT novelId, episodeNumber, COUNT(*) AS count
FROM episodes
GROUP BY novelId, episodeNumber
HAVING COUNT(*) > 1;

-- Package episodes still referencing content: sanity size check (content is MEDIUMTEXT)
SELECT COUNT(*) AS package_episodes_with_content
FROM episodes
WHERE saleMode = 'package' AND content IS NOT NULL AND CHAR_LENGTH(content) > 0;
```

## 5. `orders`

```sql
SELECT COUNT(*) AS row_count FROM orders;

SELECT MIN(id) AS min_id, MAX(id) AS max_id,
       MIN(createdAt) AS min_created_at, MAX(createdAt) AS max_created_at
FROM orders;

-- Grouped status counts
SELECT status, COUNT(*) AS count FROM orders GROUP BY status;
SELECT paymentStatus, COUNT(*) AS count FROM orders GROUP BY paymentStatus;
SELECT status, paymentStatus, COUNT(*) AS count FROM orders GROUP BY status, paymentStatus ORDER BY status, paymentStatus;

-- Financial SUM (only status='approved' orders should count toward realized revenue -
-- compare this specific figure between source and target as an EXACT-match check)
SELECT
  COUNT(*) AS approved_order_count,
  SUM(subtotal) AS sum_subtotal,
  SUM(discountAmount) AS sum_discount,
  SUM(pointsDiscountAmount) AS sum_points_discount,
  SUM(totalAmount) AS sum_total_amount
FROM orders
WHERE status = 'approved';

-- All-orders financial SUM (informational - includes pending/rejected/cancelled,
-- expect this NOT to match revenue reports, only useful as a row-level total sanity check)
SELECT SUM(totalAmount) AS sum_total_amount_all_orders FROM orders;

-- Orphan check: orders referencing a userId that no longer exists
-- (userId is nullable - guest/anonymous orders, if any, are expected and excluded here)
SELECT o.id AS order_id, o.userId
FROM orders o
LEFT JOIN users u ON u.id = o.userId
WHERE o.userId IS NOT NULL AND u.id IS NULL;

-- Duplicate orderNumber check (has a UNIQUE constraint; defense-in-depth)
SELECT orderNumber, COUNT(*) AS count FROM orders GROUP BY orderNumber HAVING COUNT(*) > 1;
```

## 6. `orderItems`

```sql
SELECT COUNT(*) AS row_count FROM orderItems;

SELECT MIN(id) AS min_id, MAX(id) AS max_id,
       MIN(createdAt) AS min_created_at, MAX(createdAt) AS max_created_at
FROM orderItems;

-- Financial SUM, scoped to items belonging to approved orders only (EXACT-match check)
SELECT
  COUNT(*) AS item_count,
  SUM(oi.unitPrice) AS sum_unit_price,
  SUM(oi.discountAmount) AS sum_discount,
  SUM(oi.finalPrice) AS sum_final_price
FROM orderItems oi
JOIN orders o ON o.id = oi.orderId
WHERE o.status = 'approved';

-- Orphan check: orderItems referencing an orderId that no longer exists
SELECT oi.id AS order_item_id, oi.orderId
FROM orderItems oi
LEFT JOIN orders o ON o.id = oi.orderId
WHERE o.id IS NULL;

-- Orphan check: orderItems referencing an episodeId that no longer exists
SELECT oi.id AS order_item_id, oi.episodeId
FROM orderItems oi
LEFT JOIN episodes e ON e.id = oi.episodeId
WHERE e.id IS NULL;

-- Duplicate (orderId, episodeId) check (has a UNIQUE constraint; defense-in-depth)
SELECT orderId, episodeId, COUNT(*) AS count
FROM orderItems
GROUP BY orderId, episodeId
HAVING COUNT(*) > 1;

-- Cross-check: every approved order's totalAmount should reconcile with the SUM of its
-- items' finalPrice minus pointsDiscountAmount (an EXACT-match check per order, run this
-- as a targeted spot-check on a sample, not necessarily every row, if the table is large)
SELECT o.id AS order_id, o.totalAmount,
       (COALESCE(SUM(oi.finalPrice), 0) - o.pointsDiscountAmount) AS computed_total
FROM orders o
LEFT JOIN orderItems oi ON oi.orderId = o.id
WHERE o.status = 'approved'
GROUP BY o.id, o.totalAmount, o.pointsDiscountAmount
HAVING o.totalAmount <> (COALESCE(SUM(oi.finalPrice), 0) - o.pointsDiscountAmount);
```

## 7. `payments`

```sql
SELECT COUNT(*) AS row_count FROM payments;

SELECT MIN(id) AS min_id, MAX(id) AS max_id,
       MIN(createdAt) AS min_created_at, MAX(createdAt) AS max_created_at
FROM payments;

SELECT status, COUNT(*) AS count FROM payments GROUP BY status;
SELECT ocrDecision, COUNT(*) AS count FROM payments GROUP BY ocrDecision;
SELECT approvalSource, COUNT(*) AS count FROM payments GROUP BY approvalSource;

-- Every order should have at most one payment row (orderId is UNIQUE) - defense-in-depth
SELECT orderId, COUNT(*) AS count FROM payments GROUP BY orderId HAVING COUNT(*) > 1;

-- Orphan check: payments referencing an orderId that no longer exists
SELECT p.id AS payment_id, p.orderId
FROM payments p
LEFT JOIN orders o ON o.id = p.orderId
WHERE o.id IS NULL;

-- Every 'approved' order should have exactly one 'approved' payment (entitlement-adjacent
-- consistency check - a mismatch here means an order was marked approved without a
-- corresponding approved payment record, or vice versa)
SELECT o.id AS order_id, o.status AS order_status, p.status AS payment_status
FROM orders o
LEFT JOIN payments p ON p.orderId = o.id
WHERE o.status = 'approved' AND (p.id IS NULL OR p.status <> 'approved');
```

## 8. `orderItems` ↔ `purchases` entitlement check

```sql
-- Row count and MIN/MAX for purchases
SELECT COUNT(*) AS row_count FROM purchases;
SELECT MIN(id) AS min_id, MAX(id) AS max_id,
       MIN(createdAt) AS min_created_at, MAX(createdAt) AS max_created_at
FROM purchases;

-- Duplicate (userId, episodeId) check (has a UNIQUE constraint; defense-in-depth)
SELECT userId, episodeId, COUNT(*) AS count
FROM purchases
GROUP BY userId, episodeId
HAVING COUNT(*) > 1;

-- Orphan checks
SELECT pu.id, pu.userId FROM purchases pu LEFT JOIN users u ON u.id = pu.userId WHERE u.id IS NULL;
SELECT pu.id, pu.episodeId FROM purchases pu LEFT JOIN episodes e ON e.id = pu.episodeId WHERE e.id IS NULL;
SELECT pu.id, pu.orderId FROM purchases pu LEFT JOIN orders o ON o.id = pu.orderId WHERE o.id IS NULL;

-- ENTITLEMENT CHECK: every approved order's items should have a matching purchases row
-- (i.e. every episode a customer paid for and had approved must be readable). A row
-- returned here means a customer paid and was approved but was never granted access -
-- this is the single most important check in this document.
SELECT o.id AS order_id, oi.episodeId, o.userId
FROM orders o
JOIN orderItems oi ON oi.orderId = o.id
LEFT JOIN purchases pu ON pu.userId = o.userId AND pu.episodeId = oi.episodeId
WHERE o.status = 'approved' AND pu.id IS NULL;

-- REVERSE ENTITLEMENT CHECK: every purchases row should trace back to an approved order
-- containing that episode. A row returned here means someone has access that doesn't
-- trace to a paid, approved order - investigate before trusting the migration.
SELECT pu.id AS purchase_id, pu.userId, pu.episodeId, pu.orderId
FROM purchases pu
LEFT JOIN orders o ON o.id = pu.orderId AND o.status = 'approved'
LEFT JOIN orderItems oi ON oi.orderId = pu.orderId AND oi.episodeId = pu.episodeId
WHERE o.id IS NULL OR oi.id IS NULL;
```

## 9. `episodePurchases` (wallet-based entitlements)

```sql
SELECT COUNT(*) AS row_count FROM episodePurchases;

SELECT MIN(id) AS min_id, MAX(id) AS max_id,
       MIN(purchasedAt) AS min_purchased_at, MAX(purchasedAt) AS max_purchased_at
FROM episodePurchases;

-- Financial SUM (EXACT-match check)
SELECT COUNT(*) AS purchase_count, SUM(pricePaid) AS sum_price_paid FROM episodePurchases;

-- Duplicate (userId, episodeId) check (has a UNIQUE constraint; defense-in-depth)
SELECT userId, episodeId, COUNT(*) AS count
FROM episodePurchases
GROUP BY userId, episodeId
HAVING COUNT(*) > 1;

-- Orphan checks
SELECT ep.id, ep.userId FROM episodePurchases ep LEFT JOIN users u ON u.id = ep.userId WHERE u.id IS NULL;
SELECT ep.id, ep.episodeId FROM episodePurchases ep LEFT JOIN episodes e ON e.id = ep.episodeId WHERE e.id IS NULL;

-- CROSS-TABLE OVERLAP CHECK: purchases and episodePurchases are two independent
-- entitlement paths (order/cart checkout vs. direct wallet debit) for the SAME
-- (userId, episodeId) grant. Each table enforces its own uniqueness separately, so
-- nothing in the schema itself prevents the same user/episode pair from appearing in
-- BOTH tables (e.g. bought once via checkout, once via wallet, by mistake or design).
-- This is not necessarily a bug, but it IS worth an explicit count on both source and
-- target so migration doesn't silently change how many users have double-covered access.
SELECT COUNT(*) AS episodes_covered_by_both_paths
FROM purchases pu
JOIN episodePurchases ep ON ep.userId = pu.userId AND ep.episodeId = pu.episodeId;

-- Orphan check: episodePurchases referencing a walletTransactionId that no longer exists
-- (walletTransactionId is nullable)
SELECT ep.id, ep.walletTransactionId
FROM episodePurchases ep
LEFT JOIN walletTransactions wt ON wt.id = ep.walletTransactionId
WHERE ep.walletTransactionId IS NOT NULL AND wt.id IS NULL;
```

## 10. `pointsTransactions`

```sql
SELECT COUNT(*) AS row_count FROM pointsTransactions;

SELECT MIN(id) AS min_id, MAX(id) AS max_id,
       MIN(createdAt) AS min_created_at, MAX(createdAt) AS max_created_at
FROM pointsTransactions;

SELECT type, COUNT(*) AS count, SUM(amount) AS sum_amount FROM pointsTransactions GROUP BY type;

-- Orphan check
SELECT pt.id, pt.userId FROM pointsTransactions pt LEFT JOIN users u ON u.id = pt.userId WHERE u.id IS NULL;

-- Per-user running-balance consistency check (EXACT-match, spot-check on a sample of
-- users if the table is large): the most recent balanceAfter per user should be
-- non-negative and should equal earn+adjust+refund minus redeem for that user, IF the
-- table is a strictly append-only ledger (verify this assumption against actual
-- application logic before treating a mismatch as a migration bug rather than a
-- pre-existing data-quality issue - this query only reports the numbers, it does not
-- assert which one is "right").
SELECT userId,
       SUM(CASE WHEN type IN ('earn','adjust','refund') THEN amount
                WHEN type = 'redeem' THEN -amount ELSE 0 END) AS computed_net,
       MAX(id) AS last_transaction_id
FROM pointsTransactions
GROUP BY userId;
```

## 11. `coupons` and `couponUsages`

```sql
SELECT COUNT(*) AS row_count FROM coupons;
SELECT MIN(id) AS min_id, MAX(id) AS max_id,
       MIN(createdAt) AS min_created_at, MAX(createdAt) AS max_created_at
FROM coupons;

SELECT isActive, scope, COUNT(*) AS count FROM coupons GROUP BY isActive, scope;

-- Duplicate code check (has a UNIQUE constraint; defense-in-depth)
SELECT code, COUNT(*) AS count FROM coupons GROUP BY code HAVING COUNT(*) > 1;

SELECT COUNT(*) AS row_count FROM couponUsages;
SELECT MIN(id) AS min_id, MAX(id) AS max_id,
       MIN(usedAt) AS min_used_at, MAX(usedAt) AS max_used_at
FROM couponUsages;

-- Orphan checks
SELECT cu.id, cu.couponId FROM couponUsages cu LEFT JOIN coupons c ON c.id = cu.couponId WHERE c.id IS NULL;
SELECT cu.id, cu.orderId FROM couponUsages cu LEFT JOIN orders o ON o.id = cu.orderId WHERE o.id IS NULL;

-- Duplicate (couponId, orderId) check (has a UNIQUE constraint; defense-in-depth)
SELECT couponId, orderId, COUNT(*) AS count
FROM couponUsages
GROUP BY couponId, orderId
HAVING COUNT(*) > 1;

-- ENTITLEMENT-ADJACENT CHECK: coupons.usageCount (a denormalized counter) should equal
-- the actual COUNT(*) from couponUsages for that coupon - a mismatch means the counter
-- and the ledger have drifted, independent of migration (worth running on source ALONE
-- first to see if this is a pre-existing issue, then confirming the drift is identical
-- on target after migration - i.e. migration must not introduce NEW drift).
SELECT c.id AS coupon_id, c.code, c.usageCount AS counter_value,
       COUNT(cu.id) AS actual_usage_count
FROM coupons c
LEFT JOIN couponUsages cu ON cu.couponId = c.id
GROUP BY c.id, c.code, c.usageCount
HAVING c.usageCount <> COUNT(cu.id);
```

## 12. `walletAccounts`, `walletTransactions`, `walletTopups`

```sql
-- walletAccounts
SELECT COUNT(*) AS row_count FROM walletAccounts;
SELECT MIN(id) AS min_id, MAX(id) AS max_id,
       MIN(createdAt) AS min_created_at, MAX(createdAt) AS max_created_at
FROM walletAccounts;

-- Financial SUM (EXACT-match check - total customer wallet liability)
SELECT
  SUM(balance) AS sum_balance,
  SUM(totalTopupApproved) AS sum_total_topup_approved,
  SUM(totalSpent) AS sum_total_spent
FROM walletAccounts;

-- Any negative balance is a correctness red flag on either engine
SELECT id, userId, balance FROM walletAccounts WHERE balance < 0;

-- Duplicate userId check (has a UNIQUE constraint; defense-in-depth)
SELECT userId, COUNT(*) AS count FROM walletAccounts GROUP BY userId HAVING COUNT(*) > 1;

-- walletTransactions
SELECT COUNT(*) AS row_count FROM walletTransactions;
SELECT MIN(id) AS min_id, MAX(id) AS max_id,
       MIN(createdAt) AS min_created_at, MAX(createdAt) AS max_created_at
FROM walletTransactions;

SELECT type, COUNT(*) AS count, SUM(amount) AS sum_amount FROM walletTransactions GROUP BY type;

-- Orphan check
SELECT wt.id, wt.userId FROM walletTransactions wt LEFT JOIN users u ON u.id = wt.userId WHERE u.id IS NULL;

-- PER-USER LEDGER CONSISTENCY (EXACT-match, spot-check a sample if the table is large):
-- each user's latest walletTransactions.balanceAfter should equal their current
-- walletAccounts.balance - a mismatch means the ledger and the account snapshot have
-- drifted, which is exactly the kind of bug this migration must not introduce or hide.
SELECT wa.userId, wa.balance AS account_balance, latest.balanceAfter AS ledger_balance
FROM walletAccounts wa
JOIN (
  SELECT wt1.userId, wt1.balanceAfter
  FROM walletTransactions wt1
  JOIN (
    SELECT userId, MAX(id) AS max_id FROM walletTransactions GROUP BY userId
  ) latest_id ON latest_id.userId = wt1.userId AND latest_id.max_id = wt1.id
) latest ON latest.userId = wa.userId
WHERE wa.balance <> latest.balanceAfter;

-- walletTopups
SELECT COUNT(*) AS row_count FROM walletTopups;
SELECT MIN(id) AS min_id, MAX(id) AS max_id,
       MIN(createdAt) AS min_created_at, MAX(createdAt) AS max_created_at
FROM walletTopups;

SELECT status, COUNT(*) AS count FROM walletTopups GROUP BY status;
SELECT approvalSource, COUNT(*) AS count FROM walletTopups GROUP BY approvalSource;

-- Financial SUM, approved topups only (EXACT-match check)
SELECT
  COUNT(*) AS approved_topup_count,
  SUM(requestedAmount) AS sum_requested,
  SUM(bonusAmount) AS sum_bonus,
  SUM(creditedAmount) AS sum_credited
FROM walletTopups
WHERE status = 'approved';

-- Orphan check
SELECT wtp.id, wtp.userId FROM walletTopups wtp LEFT JOIN users u ON u.id = wtp.userId WHERE u.id IS NULL;
```

## 13. `dailyCheckins`

```sql
SELECT COUNT(*) AS row_count FROM dailyCheckins;

SELECT MIN(id) AS min_id, MAX(id) AS max_id,
       MIN(issuedAt) AS min_issued_at, MAX(issuedAt) AS max_issued_at
FROM dailyCheckins;

SELECT status, COUNT(*) AS count FROM dailyCheckins GROUP BY status;
SELECT campaignKey, COUNT(*) AS count FROM dailyCheckins GROUP BY campaignKey;

-- Duplicate (userId, checkinDate, campaignKey) check (has a UNIQUE constraint;
-- defense-in-depth - this is the "one check-in per user per day per campaign" invariant)
SELECT userId, checkinDate, campaignKey, COUNT(*) AS count
FROM dailyCheckins
GROUP BY userId, checkinDate, campaignKey
HAVING COUNT(*) > 1;

-- Duplicate couponId check (has a UNIQUE constraint, NULLs allowed and excluded here
-- since MySQL/MariaDB both permit multiple NULLs in a UNIQUE index by design)
SELECT couponId, COUNT(*) AS count
FROM dailyCheckins
WHERE couponId IS NOT NULL
GROUP BY couponId
HAVING COUNT(*) > 1;

-- Orphan checks
SELECT dc.id, dc.userId FROM dailyCheckins dc LEFT JOIN users u ON u.id = dc.userId WHERE u.id IS NULL;
SELECT dc.id, dc.couponId
FROM dailyCheckins dc
LEFT JOIN coupons c ON c.id = dc.couponId
WHERE dc.couponId IS NOT NULL AND c.id IS NULL;
```

## 14. Migration count / tag verification

```sql
-- ENGINE-SPECIFIC (information_schema is portable across MySQL/MariaDB/TiDB, but the
-- migrations-tracking table name below is Drizzle's default convention, NOT confirmed
-- against installed package source in this audit - run the discovery query FIRST):

-- Step 1: discover the actual migrations-tracking table name on THIS database
SELECT TABLE_NAME
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE '%drizzle%migrat%';

-- Step 2: once confirmed (commonly __drizzle_migrations), count applied migrations and
-- compare against drizzle/meta/_journal.json's 33 entries (idx 0-32) - substitute the
-- real table name if step 1 found something different:
SELECT COUNT(*) AS applied_migration_count FROM __drizzle_migrations;

SELECT * FROM __drizzle_migrations ORDER BY id;

-- Cross-check reminder (not a SQL query - a manual step): compare the hashes/tags
-- returned above against drizzle/meta/_journal.json's "tag" values for idx 0-32. The
-- journal is the source of truth for what SHOULD be applied; this table is what THE
-- DATABASE believes has been applied. A mismatch (fewer rows than 33, or hashes that
-- don't correspond to files in drizzle/) means the target database is not actually
-- fully migrated even if `pnpm db:migrate` reported success - do not proceed to cutover
-- until this reconciles.

-- Full table inventory sanity check (portable) - confirms the expected 31
-- application tables (per drizzle/schema.ts) all exist on the target, independent of
-- the migrations-tracking table above:
SELECT TABLE_NAME, TABLE_ROWS
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME;
```

## 15. Overall reconciliation summary (run last)

```sql
-- A single-row "fingerprint" combining the highest-value checks above, convenient for a
-- quick eyeball diff between source and target before drilling into the detailed
-- per-table queries if something looks off.
SELECT
  (SELECT COUNT(*) FROM users) AS users_count,
  (SELECT COUNT(*) FROM users WHERE role = 'admin') AS admins_count,
  (SELECT COUNT(*) FROM novels) AS novels_count,
  (SELECT COUNT(*) FROM episodes) AS episodes_count,
  (SELECT COUNT(*) FROM orders WHERE status = 'approved') AS approved_orders_count,
  (SELECT SUM(totalAmount) FROM orders WHERE status = 'approved') AS approved_orders_total,
  (SELECT COUNT(*) FROM payments WHERE status = 'approved') AS approved_payments_count,
  (SELECT COUNT(*) FROM purchases) AS purchases_count,
  (SELECT COUNT(*) FROM episodePurchases) AS episode_purchases_count,
  (SELECT SUM(pricePaid) FROM episodePurchases) AS episode_purchases_total,
  (SELECT SUM(balance) FROM walletAccounts) AS wallet_balance_total,
  (SELECT COUNT(*) FROM walletTopups WHERE status = 'approved') AS approved_topups_count,
  (SELECT SUM(creditedAmount) FROM walletTopups WHERE status = 'approved') AS approved_topups_credited_total,
  (SELECT COUNT(*) FROM coupons) AS coupons_count,
  (SELECT COUNT(*) FROM couponUsages) AS coupon_usages_count,
  (SELECT COUNT(*) FROM dailyCheckins) AS daily_checkins_count;
```

---

## Exact-match policy (used by `compare-snapshots.mjs`)

The following categories of value **must match exactly** between source and target snapshots taken at the same logical point in time (i.e. after writes have stopped on the source, per the cutover procedure) — any difference is a stop-the-cutover condition:

- Every financial `SUM(...)` in this document (§5, §6, §9, §12).
- Every entitlement `COUNT(*)` and the two entitlement-check queries in §8 (must return **zero rows**, not just "a similar number").
- The migration count in §14 (must be exactly 33, matching the journal).

The following are **informational / expected to have benign drift** and should be reported but not treated as a hard failure by default: row counts on tables that could plausibly gain rows between snapshot-taking (e.g. `readingProgress`-adjacent activity, if the source is still receiving reads/writes right up to the freeze point) — but note that per the Runbook and Checklist, **the source should not be accepting writes after the recorded cutover timestamp**, so even these should match exactly once both snapshots are taken after the freeze. Treat any drift here as worth explaining, not silently ignoring.
