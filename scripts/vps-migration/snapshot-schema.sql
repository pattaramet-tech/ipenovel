-- VPS migration validation snapshot queries.
--
-- READ-ONLY. Every statement in this file is a SELECT. There is no
-- DROP/TRUNCATE/DELETE/UPDATE/INSERT, no migration execution, and nothing
-- here mutates any database. This file consolidates the full query set
-- documented (with rationale for each) in docs/VPS_DATA_VALIDATION.md -
-- read that document for *why* each check exists; this file exists so the
-- full set can be run against a database in one pass without hand-copying
-- from the doc each time.
--
-- Usage: run this file's queries (whole file, or section by section) against
-- the source database, save the results; run again against the target
-- database; assemble both into the JSON snapshot shape documented in
-- scripts/vps-migration/README.md; feed both into compare-snapshots.mjs.
-- Nothing in this repository does that assembly automatically - see
-- README.md for why.
--
-- Table/column names verified directly against drizzle/schema.ts at repo
-- HEAD da3a65e16b51ed7e81cead6fd3559e444fd3a814 (origin/main). See
-- docs/VPS_DATA_VALIDATION.md for the "no admins table" and "migration
-- journal is a file, not a table" notes before running section 14.

-- =============================================================
-- 1. Overall reconciliation summary - run this first as a quick fingerprint
-- =============================================================
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

-- =============================================================
-- 2. users / admins
-- =============================================================
SELECT COUNT(*) AS row_count FROM users;
SELECT MIN(id) AS min_id, MAX(id) AS max_id, MIN(createdAt) AS min_created_at, MAX(createdAt) AS max_created_at FROM users;
SELECT role, COUNT(*) AS count FROM users GROUP BY role;
SELECT openId, COUNT(*) AS count FROM users GROUP BY openId HAVING COUNT(*) > 1;
SELECT COUNT(*) AS admin_count FROM users WHERE role = 'admin';

-- =============================================================
-- 3. novels
-- =============================================================
SELECT COUNT(*) AS row_count FROM novels;
SELECT MIN(id) AS min_id, MAX(id) AS max_id, MIN(createdAt) AS min_created_at, MAX(createdAt) AS max_created_at FROM novels;
SELECT publicationStatus, COUNT(*) AS count FROM novels GROUP BY publicationStatus;
SELECT storyStatus, COUNT(*) AS count FROM novels GROUP BY storyStatus;
SELECT slug, COUNT(*) AS count FROM novels GROUP BY slug HAVING COUNT(*) > 1;

-- =============================================================
-- 4. episodes
-- =============================================================
SELECT COUNT(*) AS row_count FROM episodes;
SELECT MIN(id) AS min_id, MAX(id) AS max_id, MIN(createdAt) AS min_created_at, MAX(createdAt) AS max_created_at FROM episodes;
SELECT saleMode, COUNT(*) AS count FROM episodes GROUP BY saleMode;
SELECT isFree, isPublished, COUNT(*) AS count FROM episodes GROUP BY isFree, isPublished;
SELECT e.id AS episode_id, e.novelId FROM episodes e LEFT JOIN novels n ON n.id = e.novelId WHERE n.id IS NULL;
SELECT novelId, episodeNumber, COUNT(*) AS count FROM episodes GROUP BY novelId, episodeNumber HAVING COUNT(*) > 1;

-- =============================================================
-- 5. orders
-- =============================================================
SELECT COUNT(*) AS row_count FROM orders;
SELECT MIN(id) AS min_id, MAX(id) AS max_id, MIN(createdAt) AS min_created_at, MAX(createdAt) AS max_created_at FROM orders;
SELECT status, COUNT(*) AS count FROM orders GROUP BY status;
SELECT paymentStatus, COUNT(*) AS count FROM orders GROUP BY paymentStatus;
SELECT
  COUNT(*) AS approved_order_count,
  SUM(subtotal) AS sum_subtotal,
  SUM(discountAmount) AS sum_discount,
  SUM(pointsDiscountAmount) AS sum_points_discount,
  SUM(totalAmount) AS sum_total_amount
FROM orders WHERE status = 'approved';
SELECT o.id AS order_id, o.userId FROM orders o LEFT JOIN users u ON u.id = o.userId WHERE o.userId IS NOT NULL AND u.id IS NULL;
SELECT orderNumber, COUNT(*) AS count FROM orders GROUP BY orderNumber HAVING COUNT(*) > 1;

-- =============================================================
-- 6. orderItems
-- =============================================================
SELECT COUNT(*) AS row_count FROM orderItems;
SELECT MIN(id) AS min_id, MAX(id) AS max_id, MIN(createdAt) AS min_created_at, MAX(createdAt) AS max_created_at FROM orderItems;
SELECT
  COUNT(*) AS item_count,
  SUM(oi.unitPrice) AS sum_unit_price,
  SUM(oi.discountAmount) AS sum_discount,
  SUM(oi.finalPrice) AS sum_final_price
FROM orderItems oi JOIN orders o ON o.id = oi.orderId WHERE o.status = 'approved';
SELECT oi.id AS order_item_id, oi.orderId FROM orderItems oi LEFT JOIN orders o ON o.id = oi.orderId WHERE o.id IS NULL;
SELECT oi.id AS order_item_id, oi.episodeId FROM orderItems oi LEFT JOIN episodes e ON e.id = oi.episodeId WHERE e.id IS NULL;
SELECT orderId, episodeId, COUNT(*) AS count FROM orderItems GROUP BY orderId, episodeId HAVING COUNT(*) > 1;
SELECT o.id AS order_id, o.totalAmount, (COALESCE(SUM(oi.finalPrice), 0) - o.pointsDiscountAmount) AS computed_total
FROM orders o LEFT JOIN orderItems oi ON oi.orderId = o.id
WHERE o.status = 'approved'
GROUP BY o.id, o.totalAmount, o.pointsDiscountAmount
HAVING o.totalAmount <> (COALESCE(SUM(oi.finalPrice), 0) - o.pointsDiscountAmount);

-- =============================================================
-- 7. payments
-- =============================================================
SELECT COUNT(*) AS row_count FROM payments;
SELECT MIN(id) AS min_id, MAX(id) AS max_id, MIN(createdAt) AS min_created_at, MAX(createdAt) AS max_created_at FROM payments;
SELECT status, COUNT(*) AS count FROM payments GROUP BY status;
SELECT ocrDecision, COUNT(*) AS count FROM payments GROUP BY ocrDecision;
SELECT approvalSource, COUNT(*) AS count FROM payments GROUP BY approvalSource;
SELECT orderId, COUNT(*) AS count FROM payments GROUP BY orderId HAVING COUNT(*) > 1;
SELECT p.id AS payment_id, p.orderId FROM payments p LEFT JOIN orders o ON o.id = p.orderId WHERE o.id IS NULL;
SELECT o.id AS order_id, o.status AS order_status, p.status AS payment_status
FROM orders o LEFT JOIN payments p ON p.orderId = o.id
WHERE o.status = 'approved' AND (p.id IS NULL OR p.status <> 'approved');

-- =============================================================
-- 8. purchases (order-based entitlements)
-- =============================================================
SELECT COUNT(*) AS row_count FROM purchases;
SELECT MIN(id) AS min_id, MAX(id) AS max_id, MIN(createdAt) AS min_created_at, MAX(createdAt) AS max_created_at FROM purchases;
SELECT userId, episodeId, COUNT(*) AS count FROM purchases GROUP BY userId, episodeId HAVING COUNT(*) > 1;
SELECT pu.id, pu.userId FROM purchases pu LEFT JOIN users u ON u.id = pu.userId WHERE u.id IS NULL;
SELECT pu.id, pu.episodeId FROM purchases pu LEFT JOIN episodes e ON e.id = pu.episodeId WHERE e.id IS NULL;
SELECT pu.id, pu.orderId FROM purchases pu LEFT JOIN orders o ON o.id = pu.orderId WHERE o.id IS NULL;
-- Entitlement check: paid+approved but never granted access
SELECT o.id AS order_id, oi.episodeId, o.userId
FROM orders o JOIN orderItems oi ON oi.orderId = o.id
LEFT JOIN purchases pu ON pu.userId = o.userId AND pu.episodeId = oi.episodeId
WHERE o.status = 'approved' AND pu.id IS NULL;
-- Reverse entitlement check: access granted with no matching paid+approved order
SELECT pu.id AS purchase_id, pu.userId, pu.episodeId, pu.orderId
FROM purchases pu
LEFT JOIN orders o ON o.id = pu.orderId AND o.status = 'approved'
LEFT JOIN orderItems oi ON oi.orderId = pu.orderId AND oi.episodeId = pu.episodeId
WHERE o.id IS NULL OR oi.id IS NULL;

-- =============================================================
-- 9. episodePurchases (wallet-based entitlements)
-- =============================================================
SELECT COUNT(*) AS row_count FROM episodePurchases;
SELECT MIN(id) AS min_id, MAX(id) AS max_id, MIN(purchasedAt) AS min_purchased_at, MAX(purchasedAt) AS max_purchased_at FROM episodePurchases;
SELECT COUNT(*) AS purchase_count, SUM(pricePaid) AS sum_price_paid FROM episodePurchases;
SELECT userId, episodeId, COUNT(*) AS count FROM episodePurchases GROUP BY userId, episodeId HAVING COUNT(*) > 1;
SELECT ep.id, ep.userId FROM episodePurchases ep LEFT JOIN users u ON u.id = ep.userId WHERE u.id IS NULL;
SELECT ep.id, ep.episodeId FROM episodePurchases ep LEFT JOIN episodes e ON e.id = ep.episodeId WHERE e.id IS NULL;
SELECT COUNT(*) AS episodes_covered_by_both_paths
FROM purchases pu JOIN episodePurchases ep ON ep.userId = pu.userId AND ep.episodeId = pu.episodeId;
SELECT ep.id, ep.walletTransactionId FROM episodePurchases ep
LEFT JOIN walletTransactions wt ON wt.id = ep.walletTransactionId
WHERE ep.walletTransactionId IS NOT NULL AND wt.id IS NULL;

-- =============================================================
-- 10. pointsTransactions
-- =============================================================
SELECT COUNT(*) AS row_count FROM pointsTransactions;
SELECT MIN(id) AS min_id, MAX(id) AS max_id, MIN(createdAt) AS min_created_at, MAX(createdAt) AS max_created_at FROM pointsTransactions;
SELECT type, COUNT(*) AS count, SUM(amount) AS sum_amount FROM pointsTransactions GROUP BY type;
SELECT pt.id, pt.userId FROM pointsTransactions pt LEFT JOIN users u ON u.id = pt.userId WHERE u.id IS NULL;
SELECT userId,
       SUM(CASE WHEN type IN ('earn','adjust','refund') THEN amount WHEN type = 'redeem' THEN -amount ELSE 0 END) AS computed_net,
       MAX(id) AS last_transaction_id
FROM pointsTransactions GROUP BY userId;

-- =============================================================
-- 11. coupons / couponUsages
-- =============================================================
SELECT COUNT(*) AS row_count FROM coupons;
SELECT MIN(id) AS min_id, MAX(id) AS max_id, MIN(createdAt) AS min_created_at, MAX(createdAt) AS max_created_at FROM coupons;
SELECT isActive, scope, COUNT(*) AS count FROM coupons GROUP BY isActive, scope;
SELECT code, COUNT(*) AS count FROM coupons GROUP BY code HAVING COUNT(*) > 1;

SELECT COUNT(*) AS row_count FROM couponUsages;
SELECT MIN(id) AS min_id, MAX(id) AS max_id, MIN(usedAt) AS min_used_at, MAX(usedAt) AS max_used_at FROM couponUsages;
SELECT cu.id, cu.couponId FROM couponUsages cu LEFT JOIN coupons c ON c.id = cu.couponId WHERE c.id IS NULL;
SELECT cu.id, cu.orderId FROM couponUsages cu LEFT JOIN orders o ON o.id = cu.orderId WHERE o.id IS NULL;
SELECT couponId, orderId, COUNT(*) AS count FROM couponUsages GROUP BY couponId, orderId HAVING COUNT(*) > 1;
SELECT c.id AS coupon_id, c.code, c.usageCount AS counter_value, COUNT(cu.id) AS actual_usage_count
FROM coupons c LEFT JOIN couponUsages cu ON cu.couponId = c.id
GROUP BY c.id, c.code, c.usageCount
HAVING c.usageCount <> COUNT(cu.id);

-- =============================================================
-- 12. walletAccounts / walletTransactions / walletTopups
-- =============================================================
SELECT COUNT(*) AS row_count FROM walletAccounts;
SELECT MIN(id) AS min_id, MAX(id) AS max_id, MIN(createdAt) AS min_created_at, MAX(createdAt) AS max_created_at FROM walletAccounts;
SELECT SUM(balance) AS sum_balance, SUM(totalTopupApproved) AS sum_total_topup_approved, SUM(totalSpent) AS sum_total_spent FROM walletAccounts;
SELECT id, userId, balance FROM walletAccounts WHERE balance < 0;
SELECT userId, COUNT(*) AS count FROM walletAccounts GROUP BY userId HAVING COUNT(*) > 1;

SELECT COUNT(*) AS row_count FROM walletTransactions;
SELECT MIN(id) AS min_id, MAX(id) AS max_id, MIN(createdAt) AS min_created_at, MAX(createdAt) AS max_created_at FROM walletTransactions;
SELECT type, COUNT(*) AS count, SUM(amount) AS sum_amount FROM walletTransactions GROUP BY type;
SELECT wt.id, wt.userId FROM walletTransactions wt LEFT JOIN users u ON u.id = wt.userId WHERE u.id IS NULL;
SELECT wa.userId, wa.balance AS account_balance, latest.balanceAfter AS ledger_balance
FROM walletAccounts wa
JOIN (
  SELECT wt1.userId, wt1.balanceAfter
  FROM walletTransactions wt1
  JOIN (SELECT userId, MAX(id) AS max_id FROM walletTransactions GROUP BY userId) latest_id
    ON latest_id.userId = wt1.userId AND latest_id.max_id = wt1.id
) latest ON latest.userId = wa.userId
WHERE wa.balance <> latest.balanceAfter;

SELECT COUNT(*) AS row_count FROM walletTopups;
SELECT MIN(id) AS min_id, MAX(id) AS max_id, MIN(createdAt) AS min_created_at, MAX(createdAt) AS max_created_at FROM walletTopups;
SELECT status, COUNT(*) AS count FROM walletTopups GROUP BY status;
SELECT approvalSource, COUNT(*) AS count FROM walletTopups GROUP BY approvalSource;
SELECT
  COUNT(*) AS approved_topup_count,
  SUM(requestedAmount) AS sum_requested,
  SUM(bonusAmount) AS sum_bonus,
  SUM(creditedAmount) AS sum_credited
FROM walletTopups WHERE status = 'approved';
SELECT wtp.id, wtp.userId FROM walletTopups wtp LEFT JOIN users u ON u.id = wtp.userId WHERE u.id IS NULL;

-- =============================================================
-- 13. dailyCheckins
-- =============================================================
SELECT COUNT(*) AS row_count FROM dailyCheckins;
SELECT MIN(id) AS min_id, MAX(id) AS max_id, MIN(issuedAt) AS min_issued_at, MAX(issuedAt) AS max_issued_at FROM dailyCheckins;
SELECT status, COUNT(*) AS count FROM dailyCheckins GROUP BY status;
SELECT campaignKey, COUNT(*) AS count FROM dailyCheckins GROUP BY campaignKey;
SELECT userId, checkinDate, campaignKey, COUNT(*) AS count FROM dailyCheckins GROUP BY userId, checkinDate, campaignKey HAVING COUNT(*) > 1;
SELECT couponId, COUNT(*) AS count FROM dailyCheckins WHERE couponId IS NOT NULL GROUP BY couponId HAVING COUNT(*) > 1;
SELECT dc.id, dc.userId FROM dailyCheckins dc LEFT JOIN users u ON u.id = dc.userId WHERE u.id IS NULL;
SELECT dc.id, dc.couponId FROM dailyCheckins dc LEFT JOIN coupons c ON c.id = dc.couponId WHERE dc.couponId IS NOT NULL AND c.id IS NULL;

-- =============================================================
-- 14. Migration count / tag verification
-- ENGINE-SPECIFIC discovery step - the migrations-tracking table name is
-- Drizzle's default convention, not confirmed against installed package
-- source in this audit. Run the discovery query FIRST, then substitute the
-- real name into the two queries below it if different from
-- __drizzle_migrations.
-- =============================================================
SELECT TABLE_NAME
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE '%drizzle%migrat%';

SELECT COUNT(*) AS applied_migration_count FROM __drizzle_migrations;
SELECT * FROM __drizzle_migrations ORDER BY id;

-- Full table inventory (portable across MySQL/MariaDB/TiDB)
SELECT TABLE_NAME, TABLE_ROWS
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME;
