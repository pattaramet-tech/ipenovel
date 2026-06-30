# Production Database Schema Fix - walletTopups Mismatch

## 🚨 Problem Summary

**Current Issue**: `/wallet` page throws query error when loading recentTopups

```
Failed query:
select ... from `walletTopups` where `walletTopups`.`userId` = ? ...
```

**Root Cause**: Production DB `walletTopups` table is missing OCR-related columns that the Drizzle ORM schema expects.

---

## 📋 Expected vs. Actual Columns

**Expected by Drizzle (25 columns)**:
```
id, userId, requestedAmount, bonusAmount, creditedAmount, slipImageUrl
slipSubmittedAt, status, rejectionReason, reviewedByUserId, reviewedAt
approvedAt, approvedByAdminId, rejectedAt
extractedData, ocrConfidence, visionConfidence, structuredConfidence, finalConfidence
duplicateStatus, ocrDecision, reviewReason, approvalSource
createdAt, updatedAt
```

**Likely Missing in Production**: OCR and approval tracking columns added after production deployment

---

## ✅ Step-by-Step Fix

### STEP 1: Diagnose Current State

Run these queries **IN PRODUCTION DB** (don't modify, just check):

```sql
-- Check walletTopups structure
SHOW CREATE TABLE walletTopups;
SHOW COLUMNS FROM walletTopups;

-- Check walletAccounts structure  
SHOW CREATE TABLE walletAccounts;
SHOW COLUMNS FROM walletAccounts;
```

**Report which columns are MISSING** before proceeding to STEP 2.

---

### STEP 2: Apply Database Migration

Located in: `migrations/001_fix_wallet_topups_schema.sql`

**IMPORTANT: Read the migration file first!**

```bash
# View the migration (to verify before running)
cat migrations/001_fix_wallet_topups_schema.sql
```

**Then run IN PRODUCTION DB**:

```sql
-- Source the migration file in your MySQL client:
SOURCE /path/to/migrations/001_fix_wallet_topups_schema.sql;

-- Or copy-paste the SQL statements directly into your DB client
```

**After running migration**:
```sql
-- Verify all columns exist
SHOW COLUMNS FROM walletTopups;

-- Verify all columns have proper defaults
DESCRIBE walletTopups;

-- Check row count is unchanged
SELECT COUNT(*) FROM walletTopups;
```

---

### STEP 3: Apply walletAccounts Migration (Optional but Recommended)

Located in: `migrations/002_fix_wallet_accounts_schema.sql`

```sql
SOURCE /path/to/migrations/002_fix_wallet_accounts_schema.sql;
```

---

### STEP 4: Verify Production Fix

**In Production Environment**:

1. **Test /wallet page loads**
   ```
   Open: https://yoursite.com/wallet (as a test user)
   Expected: Page loads, balance shows, no errors
   ```

2. **Check server logs**
   ```
   Tail your application logs for 5 minutes
   Should NOT see: "Failed query select walletTopups"
   Should NOT see: "Unknown column"
   ```

3. **Test wallet topup flow**
   - Create test topup (amount: 250)
   - Upload slip image
   - Verify topup appears in admin panel
   - Check server logs for any OCR/database errors

4. **Test admin balance adjustment**
   - Navigate to Admin > Wallet Topups
   - Click "Adjust Balance" on an approved topup
   - Set amount to +50, mode "add"
   - Verify balance in database increased

---

## 📝 Code Changes Made

### 1. server/db.ts - getWalletSummary()

Changed from `SELECT *` to explicit column selection:

```typescript
// BEFORE: Selects all 25 columns
db.select().from(walletTopups)

// AFTER: Selects only 12 necessary columns
db.select({
  id: walletTopups.id,
  userId: walletTopups.userId,
  requestedAmount: walletTopups.requestedAmount,
  bonusAmount: walletTopups.bonusAmount,
  creditedAmount: walletTopups.creditedAmount,
  slipImageUrl: walletTopups.slipImageUrl,
  slipSubmittedAt: walletTopups.slipSubmittedAt,
  status: walletTopups.status,
  rejectionReason: walletTopups.rejectionReason,
  reviewReason: walletTopups.reviewReason,
  approvedAt: walletTopups.approvedAt,
  createdAt: walletTopups.createdAt,
}).from(walletTopups)
```

**Benefits**:
- Prevents "Unknown column" errors if schema still diverges
- Faster query (smaller result set)
- More maintainable (explicit about what's needed)
- Migration files created and documented

---

## 🔍 Troubleshooting

### If migration fails with "Duplicate column name"
- Column already exists, skip that ALTER statement
- Check `SHOW COLUMNS` to see current state

### If /wallet still errors after migration
1. Check `DESCRIBE walletTopups` to verify all 25 columns exist
2. Check column data types match Drizzle definition
3. Check for any column encoding issues (should be utf8mb4)
4. Clear browser cache and refresh /wallet

### If topup doesn't save after uploading slip
1. Check `createWalletTopup` server logs
2. Verify `walletTopups` insert permissions
3. Verify timestamps are being set correctly (see `createdAt`, `updatedAt`)

---

## 📊 Files Affected

```
migrations/
  001_fix_wallet_topups_schema.sql     (NEW - migration script)
  002_fix_wallet_accounts_schema.sql   (NEW - optional defaults fix)

server/
  db.ts                                 (MODIFIED - safe column selection)

Code diff:
  - server/db.ts: getWalletSummary() function (12 line change)
```

---

## ✨ Expected Results After Fix

✅ `/wallet` page loads without query errors  
✅ Balance displays correctly  
✅ Recent topups show in Wallet page  
✅ Admin Wallet Topups page works  
✅ Balance adjustments save to database  
✅ No "Unknown column" or schema errors in logs  

---

## 🚀 Deployment Steps

1. ✅ **Code deployed** (commit: `8542b30`)
   - Defensive `getWalletSummary()` query
   - Migration files added

2. ⏳ **Database migration** (to be run in production)
   - Source `migrations/001_fix_wallet_topups_schema.sql`
   - Verify with `SHOW COLUMNS`

3. ⏳ **Test production**
   - Open /wallet
   - Verify no errors in logs
   - Test topup creation
   - Test admin adjustments

4. ⏳ **Monitor**
   - Watch server logs for errors
   - Test with production users

---

## 📞 Questions?

If migration fails or /wallet still doesn't work:
1. Share output of `SHOW COLUMNS FROM walletTopups;`
2. Share error message from production logs
3. Share output of `DESCRIBE walletTopups;`
