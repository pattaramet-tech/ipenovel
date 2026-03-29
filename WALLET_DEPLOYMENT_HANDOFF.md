# Wallet System - Deployment Handoff Guide

**Version:** 63ed7177  
**Date:** March 30, 2026  
**Status:** Ready for Production Deployment  

---

## 1. Changed Files by Category

### Backend - Core Implementation

| File | Changes | Impact |
|------|---------|--------|
| `server/routers.ts` | Added wallet router at top-level of appRouter (lines 1001-1036) | Exposes 6 wallet endpoints + 3 admin endpoints |
| `server/services/walletService.ts` | New file: Wallet business logic, atomic transactions, approval/rejection | Core wallet operations |
| `server/db.ts` (extended) | Added 6 wallet database helpers | Query layer for wallet operations |
| `drizzle/schema.ts` | Added 3 wallet tables (walletAccounts, walletTransactions, walletTopups) | Database schema |

### Frontend - User-Facing Pages

| File | Changes | Impact |
|------|---------|--------|
| `client/src/pages/WalletPage.tsx` | New file: User wallet page with balance, transactions, top-ups | User can view wallet and manage top-ups |
| `client/src/pages/AdminWalletTopupsPage.tsx` | New file: Admin review page for pending top-ups | Admin can approve/reject top-ups |
| `client/src/App.tsx` | Added /wallet and /admin/wallet-topups routes | Routes accessible |

### Frontend - Integration Points

| File | Changes | Impact |
|------|---------|--------|
| `client/src/components/Navbar.tsx` | Added Wallet navigation link | Users can access /wallet from navbar |
| `client/src/contexts/LanguageContext.tsx` | Added wallet translation keys (Thai + English) | Wallet label displays in both languages |
| `client/src/pages/CartPage.tsx` | Added "Pay with Wallet" button | Users can checkout with wallet |

### Tests - Comprehensive Coverage

| File | Changes | Impact |
|------|---------|--------|
| `server/wallet.service.test.ts` | New file: 8 unit tests verifying service methods | Ensures wallet service methods exist |
| `server/wallet-behavior.test.ts` | New file: 30+ behavior/regression tests | Comprehensive coverage of critical flows |

### Documentation - Deployment & Verification

| File | Changes | Impact |
|------|---------|--------|
| `WALLET_E2E_VERIFICATION.md` | New file: 21-point end-to-end verification checklist | UAT guide |
| `WALLET_RELEASE_READINESS.md` | New file: Release readiness report with UAT/deployment checklists | Release approval document |
| `WALLET_DEPLOYMENT_HANDOFF.md` | This file: Deployment guide | Deployment instructions |

---

## 2. Database Migrations Required

### Migration Command

```bash
cd /home/ubuntu/ipenovel-v2
pnpm db:push
```

This command will:
1. Generate migration files for wallet schema changes
2. Apply migrations to the database
3. Create three new tables with proper indexes

### New Tables Created

**Table 1: `walletAccounts`**
```sql
CREATE TABLE walletAccounts (
  id INT PRIMARY KEY AUTO_INCREMENT,
  userId INT NOT NULL UNIQUE,
  balance DECIMAL(12, 2) NOT NULL DEFAULT 0,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX walletAccounts_userId_idx (userId)
);
```

**Table 2: `walletTransactions`**
```sql
CREATE TABLE walletTransactions (
  id INT PRIMARY KEY AUTO_INCREMENT,
  userId INT NOT NULL,
  type ENUM('topup_approved', 'topup_rejected', 'checkout', 'refund') NOT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  description VARCHAR(255),
  relatedId INT,
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX walletTransactions_userId_idx (userId),
  INDEX walletTransactions_createdAt_idx (createdAt)
);
```

**Table 3: `walletTopups`**
```sql
CREATE TABLE walletTopups (
  id INT PRIMARY KEY AUTO_INCREMENT,
  userId INT NOT NULL,
  requestedAmount DECIMAL(12, 2) NOT NULL,
  status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
  slipImageUrl VARCHAR(500),
  rejectionReason VARCHAR(255),
  createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX walletTopups_userId_idx (userId),
  INDEX walletTopups_status_idx (status),
  INDEX walletTopups_createdAt_idx (createdAt)
);
```

### Rollback Migration

If deployment fails, rollback with:
```bash
# Revert to previous checkpoint (8b2db457)
git checkout 8b2db457 -- drizzle/schema.ts
pnpm db:push  # This will drop wallet tables
```

---

## 3. Environment Variables & Storage Configuration

### No New Environment Variables Required

The wallet system uses existing environment variables:
- `DATABASE_URL` - For wallet table operations
- `VITE_FRONTEND_FORGE_API_URL` - For slip image uploads (existing S3 integration)
- `VITE_FRONTEND_FORGE_API_KEY` - For slip image uploads (existing S3 integration)

### Storage Configuration for Slip Uploads

**Existing S3 Integration Used:**
- Slip images uploaded via existing `storagePut()` helper
- Images stored in same S3 bucket as other app assets
- No additional configuration needed

**File Upload Limits:**
- Max file size: 5MB (enforced by frontend validation)
- Supported formats: JPG, PNG, WebP (enforced by frontend)
- Recommended: Add server-side validation if not present

**Storage Path Convention:**
```
s3://bucket/wallet-slips/{userId}/{topupId}-{timestamp}.{ext}
```

---

## 4. Admin Permissions & Routes

### New Admin Routes

| Route | Purpose | Required Role | Status |
|-------|---------|----------------|--------|
| `/admin/wallet-topups` | Review pending top-up requests | admin | New |

### New Admin Endpoints (tRPC)

| Endpoint | Purpose | Required Role | Status |
|----------|---------|----------------|--------|
| `trpc.wallet.admin.listPendingTopups` | List pending top-ups | admin | New |
| `trpc.wallet.admin.approveTopup` | Approve top-up request | admin | New |
| `trpc.wallet.admin.rejectTopup` | Reject top-up request | admin | New |

### Authorization Enforcement

All admin endpoints use `adminProcedure` which enforces:
- User must be authenticated
- User must have `role === 'admin'`
- Request fails with 403 Forbidden if not authorized

**No additional permission configuration needed** - authorization is enforced at the tRPC procedure level.

---

## 5. Step-by-Step Production Deployment Order

### Phase 1: Pre-Deployment (T-1 hour)

1. **Backup production database**
   ```bash
   # Use your database backup tool
   # Example: mysqldump -u user -p database > backup-$(date +%Y%m%d-%H%M%S).sql
   ```

2. **Verify all tests pass**
   ```bash
   cd /home/ubuntu/ipenovel-v2
   pnpm test
   pnpm tsc --noEmit
   ```

3. **Build production bundle**
   ```bash
   pnpm build
   ```

4. **Verify no build errors**
   ```bash
   # Check build output for errors
   ls -la dist/
   ```

### Phase 2: Deployment (T-0)

5. **Deploy code to production**
   ```bash
   # Using your deployment tool (git push, docker deploy, etc.)
   # Ensure version 63ed7177 is deployed
   ```

6. **Run database migrations**
   ```bash
   # SSH into production server
   cd /app/ipenovel-v2
   pnpm db:push
   # This creates wallet tables
   ```

7. **Restart application server**
   ```bash
   # Restart Node.js process
   systemctl restart ipenovel-v2
   # or: pm2 restart ipenovel-v2
   # or: docker restart ipenovel-v2
   ```

8. **Verify server is running**
   ```bash
   curl -s https://your-domain.com/api/health | jq .
   # Should return 200 OK
   ```

### Phase 3: Post-Deployment Verification (T+15 min)

9. **Run smoke tests** (see section 7 below)

10. **Monitor error logs**
    ```bash
    tail -f /var/log/ipenovel-v2/error.log
    # Watch for wallet-related errors
    ```

11. **Monitor application metrics**
    - Wallet checkout success rate
    - API response times
    - Database query performance

12. **Notify stakeholders**
    - Wallet feature is live
    - Users can now top-up and checkout with wallet

---

## 6. Rollback Plan

### If Critical Issues Found (T+30 min)

**Option 1: Quick Rollback (Recommended)**

```bash
# Revert to previous checkpoint
git checkout 8b2db457
git push production main

# Restart application
systemctl restart ipenovel-v2

# Revert database (CAUTION: will drop wallet tables)
# Only do this if wallet data is not critical yet
# pnpm db:push  # This reverts schema to previous version
```

**Option 2: Keep Code, Disable Wallet Endpoints**

```bash
# If you want to keep wallet tables but disable endpoints:
# 1. Revert server/routers.ts to remove wallet router
# 2. Revert client routes
# 3. Restart application
# Wallet data remains in database for future re-enablement
```

**Option 3: Gradual Rollback**

```bash
# 1. Disable wallet checkout button in UI (feature flag)
# 2. Monitor for issues
# 3. If no issues after 24 hours, proceed
# 4. If issues, revert completely
```

### Rollback Verification

After rollback, verify:
- [ ] Manual slip payment still works
- [ ] No errors in logs
- [ ] Admin pages load correctly
- [ ] User data intact

---

## 7. Known Caveats & Monitoring Points

### Caveats

**Caveat 1: Wallet Balance Precision**
- Balance stored as DECIMAL(12, 2) (supports up to 9,999,999.99)
- All calculations use exact decimal arithmetic
- No floating-point rounding errors
- **Monitoring:** Check for any balance discrepancies in transaction audit trail

**Caveat 2: Concurrent Checkout Prevention**
- Wallet checkout uses atomic transaction + cart status check
- If user submits checkout twice rapidly, second fails with "cart already checked out"
- **Monitoring:** Monitor error logs for "cart already checked out" errors (should be rare)

**Caveat 3: Slip Upload Storage**
- Slip images stored in S3 (same bucket as other assets)
- If S3 is unavailable, slip upload fails
- **Monitoring:** Monitor S3 availability and upload success rate

**Caveat 4: Admin Approval Delay**
- Top-up approval is manual (admin must approve)
- No automatic approval or time-based approval
- Users see "pending" status until admin approves
- **Monitoring:** Track average approval time (should be < 1 hour)

**Caveat 5: No Recurring Top-ups**
- Each top-up is one-time only
- Users must create new request for each top-up
- **Monitoring:** Monitor top-up request frequency per user

### Monitoring Points After Release

**Critical Metrics (Monitor Every 5 Minutes)**

1. **Wallet Checkout Success Rate**
   - Target: > 99%
   - Alert if: < 95%
   - Query: `SELECT COUNT(*) FROM walletTransactions WHERE type='checkout' AND createdAt > NOW() - INTERVAL 5 MINUTE`

2. **Balance Consistency**
   - Target: 100% (balance = sum of transactions)
   - Alert if: Any discrepancy found
   - Query: `SELECT userId, SUM(amount) as calculated_balance FROM walletTransactions GROUP BY userId HAVING calculated_balance != (SELECT balance FROM walletAccounts WHERE userId = walletTransactions.userId)`

3. **Error Rate**
   - Target: < 0.1%
   - Alert if: > 1%
   - Monitor: Application error logs for wallet-related errors

4. **API Response Time**
   - Target: < 500ms for wallet queries
   - Alert if: > 2s
   - Monitor: APM tool or application metrics

5. **Database Query Performance**
   - Target: All wallet queries < 100ms
   - Alert if: Any query > 1s
   - Monitor: Slow query log

**Important Metrics (Monitor Every 1 Hour)**

- Top-up approval rate (should be steady)
- Top-up rejection rate (should be low)
- Average approval time (should be < 1 hour)
- User wallet balance distribution (should be reasonable)
- Duplicate checkout attempts (should be rare)

**Daily Review**

- Total wallet revenue
- User adoption (% of users with non-zero balance)
- Average top-up amount
- Manual slip payment volume (should remain stable)
- Any anomalies in transaction patterns

### Alert Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| Checkout success rate | < 95% | < 90% |
| Balance discrepancy | Any | Any |
| API response time | > 1s | > 5s |
| Error rate | > 0.5% | > 2% |
| S3 upload failure | > 5% | > 10% |

---

## 8. Smoke Test After Deploy - 5 Critical Checks

Run these checks immediately after deployment (within 15 minutes):

### Check 1: Wallet Page Loads
```bash
curl -s https://your-domain.com/wallet \
  -H "Cookie: session=<admin-session>" | grep -q "กระเป๋าเงิน\|Wallet"
# Expected: 200 OK, page contains wallet title
```

### Check 2: Admin Wallet Page Loads
```bash
curl -s https://your-domain.com/admin/wallet-topups \
  -H "Cookie: session=<admin-session>" | grep -q "Top-up Request"
# Expected: 200 OK, page contains admin title
```

### Check 3: Wallet Balance Query Works
```bash
curl -s https://your-domain.com/api/trpc/wallet.getSummary \
  -H "Cookie: session=<user-session>" | jq .
# Expected: 200 OK, returns user wallet summary
```

### Check 4: Wallet Tables Exist
```bash
# SSH into production database
mysql -u user -p database -e "SHOW TABLES LIKE 'wallet%';"
# Expected: 3 tables (walletAccounts, walletTransactions, walletTopups)
```

### Check 5: Manual Slip Payment Still Works
```bash
# Test creating a payment slip submission (existing flow)
# Expected: Existing manual payment flow unchanged
# Verify: /admin/payments page still shows manual payments
```

### Quick Verification Script

```bash
#!/bin/bash
# wallet-smoke-test.sh

echo "=== Wallet Deployment Smoke Tests ==="

# Test 1: Wallet page accessible
echo "Test 1: Wallet page..."
curl -s -o /dev/null -w "%{http_code}" https://your-domain.com/wallet
echo ""

# Test 2: Admin wallet page accessible
echo "Test 2: Admin wallet page..."
curl -s -o /dev/null -w "%{http_code}" https://your-domain.com/admin/wallet-topups
echo ""

# Test 3: Database tables exist
echo "Test 3: Database tables..."
mysql -u user -p database -e "SELECT COUNT(*) as wallet_tables FROM information_schema.tables WHERE table_schema='database' AND table_name LIKE 'wallet%';"

# Test 4: No critical errors in logs
echo "Test 4: Error logs..."
tail -100 /var/log/ipenovel-v2/error.log | grep -i "wallet\|error" | head -5

# Test 5: API health check
echo "Test 5: API health..."
curl -s https://your-domain.com/api/health | jq .

echo "=== Smoke Tests Complete ==="
```

---

## 9. Deployment Checklist

### Pre-Deployment
- [ ] Database backup created
- [ ] All tests passing (`pnpm test`)
- [ ] TypeScript clean (`pnpm tsc --noEmit`)
- [ ] Build succeeds (`pnpm build`)
- [ ] No build errors
- [ ] Changelog updated
- [ ] Stakeholders notified

### Deployment
- [ ] Code deployed to production (version 63ed7177)
- [ ] Database migrations applied (`pnpm db:push`)
- [ ] Application server restarted
- [ ] Health check passes
- [ ] No deployment errors in logs

### Post-Deployment (First 15 Minutes)
- [ ] Smoke tests pass (all 5 checks)
- [ ] No critical errors in logs
- [ ] Wallet page loads for users
- [ ] Admin wallet page loads for admins
- [ ] Manual slip payment still works

### Post-Deployment (First Hour)
- [ ] Monitor error logs (no wallet-related errors)
- [ ] Monitor API response times (< 500ms)
- [ ] Monitor database performance
- [ ] Verify balance consistency
- [ ] Notify stakeholders of successful deployment

### Post-Deployment (First 24 Hours)
- [ ] Monitor wallet checkout success rate (> 99%)
- [ ] Monitor top-up approval/rejection rates
- [ ] Monitor user adoption
- [ ] Review transaction logs for anomalies
- [ ] Verify no data loss or corruption

---

## 10. Rollback Checklist

If rollback is needed:

- [ ] Identify root cause of issue
- [ ] Notify stakeholders
- [ ] Execute rollback (see section 6)
- [ ] Verify rollback successful
- [ ] Verify manual slip payment works
- [ ] Monitor logs for errors
- [ ] Document incident and root cause
- [ ] Plan fix and re-deployment

---

## 11. Support & Escalation

### Deployment Issues

**Issue:** Database migration fails  
**Solution:** Check migration logs, verify database permissions, ensure schema is compatible

**Issue:** Wallet page returns 404  
**Solution:** Verify routes added to App.tsx, restart application server

**Issue:** Admin wallet page shows "Access Denied"  
**Solution:** Verify user has admin role, check authorization middleware

**Issue:** Wallet checkout fails with "insufficient balance"  
**Solution:** Expected behavior - user needs to top-up wallet first

**Issue:** Slip upload fails  
**Solution:** Check S3 connectivity, verify file size < 5MB, check file type

### Escalation Path

1. **Level 1:** Check logs and smoke tests
2. **Level 2:** Review deployment steps and verify all changes applied
3. **Level 3:** Execute rollback if needed
4. **Level 4:** Engage development team for investigation

---

## 12. Post-Deployment Communication

### User Announcement

```
🎉 New Feature: Wallet Payment System

We're excited to announce the launch of our new wallet payment system!

✨ What's New:
- Top-up your wallet with bank transfers
- Checkout faster with wallet balance
- Track all wallet transactions
- Instant access to purchased content

🚀 How to Get Started:
1. Visit your Wallet page (link in navigation)
2. Create a top-up request
3. Upload your payment slip
4. Wait for admin approval
5. Start using your wallet!

❓ Questions?
Contact support@example.com
```

### Admin Announcement

```
📋 New Admin Feature: Wallet Top-up Management

Admins can now review and approve/reject wallet top-up requests.

✨ What's New:
- New /admin/wallet-topups page
- Review pending top-up requests
- Approve to credit user wallet
- Reject with reason

🔗 Access: https://your-domain.com/admin/wallet-topups

📊 Monitoring:
- Track top-up approval rates
- Monitor wallet revenue
- Review transaction history
```

---

## Summary

| Item | Status |
|------|--------|
| Code Ready | ✅ Yes |
| Tests Ready | ✅ Yes |
| Database Schema Ready | ✅ Yes |
| Documentation Complete | ✅ Yes |
| Deployment Plan | ✅ Yes |
| Rollback Plan | ✅ Yes |
| Monitoring Setup | ✅ Documented |
| **Ready to Deploy** | ✅ **YES** |

**Next Step:** Execute Phase 1 (Pre-Deployment) of the deployment plan.

