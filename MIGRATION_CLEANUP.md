# Pre-Migration Cleanup Guide

## Migration 0020: Unique Index on couponUsages (couponId, orderId)

Before running migration 0020 in production, you must check for and clean up duplicate entries in the `couponUsages` table.

### Step 1: Check for Duplicates

Run this query to identify duplicate (couponId, orderId) pairs:

```sql
SELECT couponId, orderId, COUNT(*) AS duplicateCount
FROM couponUsages
GROUP BY couponId, orderId
HAVING COUNT(*) > 1;
```

If this query returns no rows, you can proceed directly to migration 0020.

### Step 2: Delete Duplicates (if any exist)

If duplicates are found, keep only the oldest row for each (couponId, orderId) pair and delete the rest:

```sql
DELETE FROM couponUsages
WHERE id NOT IN (
  SELECT keep_id FROM (
    SELECT MIN(id) AS keep_id
    FROM couponUsages
    GROUP BY couponId, orderId
  ) AS keep_rows
);
```

This query:
- Groups by (couponId, orderId)
- Keeps the row with the minimum id (oldest)
- Deletes all other duplicates

### Step 3: Verify Cleanup

Run the check query again to confirm no duplicates remain:

```sql
SELECT couponId, orderId, COUNT(*) AS duplicateCount
FROM couponUsages
GROUP BY couponId, orderId
HAVING COUNT(*) > 1;
```

Expected result: No rows returned.

### Step 4: Apply Migration

Once cleanup is complete and verified, run the migration:

```bash
pnpm db:push
```

This will create the unique index on (couponId, orderId), preventing future duplicates.

### Rollback Plan

If migration 0020 fails due to unexpected duplicates:
1. Revert to the previous checkpoint
2. Run the cleanup queries above
3. Retry the migration

### Why This Matters

The unique index prevents:
- Double-counting coupon usage on retry
- Checkout finalization from being called multiple times safely
- Data integrity issues in coupon redemption tracking
