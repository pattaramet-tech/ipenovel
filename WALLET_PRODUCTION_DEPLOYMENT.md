# Wallet Feature - Production Deployment & Monitoring Checklist

**Release Version:** 549a734b (Final Hardening Pass)  
**Status:** ✅ READY FOR PRODUCTION  
**Last Updated:** April 4, 2026

---

## Pre-Deployment Verification (Run Before Release)

### Code & Tests
- [x] All TypeScript compiles without errors: `pnpm tsc --noEmit` ✅
- [x] All wallet tests pass: `pnpm test wallet` ✅
  - wallet-final-production-test.test.ts: 2/2 (atomicity + idempotency)
  - wallet-bonus.test.ts: 8/8 (bonus calculation)
  - wallet-bonus-smoke-test.test.ts: 9/9 (boundary tests)
  - wallet-staging-e2e.test.ts: 7/7 (end-to-end flow)
- [x] Staging E2E verification complete ✅
  - Top-up submission with bonus calculation
  - Admin approval with wallet credit
  - Logs and UI consistency
  - Rejection flow safety

### Database
- [ ] Backup production database: `mysqldump -h $DB_HOST -u $DB_USER -p$DB_PASS --all-databases > backup_$(date +%Y%m%d_%H%M%S).sql`
- [ ] Verify database connection: `mysql -h $DB_HOST -u $DB_USER -p$DB_PASS -e "SELECT VERSION();"`
- [ ] Verify wallet tables exist:
  ```sql
  SHOW TABLES LIKE 'wallet%';
  -- Expected: walletAccounts, walletTransactions, walletTopups, topupLogs
  ```

### Environment
- [ ] All required environment variables set:
  - `DATABASE_URL` - MySQL connection string
  - `JWT_SECRET` - Session signing secret
  - `VITE_APP_ID` - Manus OAuth app ID
  - `OAUTH_SERVER_URL` - Manus OAuth backend
  - `VITE_OAUTH_PORTAL_URL` - Manus login portal
  - `BUILT_IN_FORGE_API_URL` - Manus built-in APIs
  - `BUILT_IN_FORGE_API_KEY` - API key for backend
  - `VITE_FRONTEND_FORGE_API_KEY` - API key for frontend
- [ ] No hardcoded secrets in code
- [ ] Build succeeds: `pnpm build`

---

## Deployment Steps

### 1. Pre-Release (30 minutes before)
```bash
# Create final backup
mysqldump -h $DB_HOST -u $DB_USER -p$DB_PASS --all-databases > wallet_backup_$(date +%Y%m%d_%H%M%S).sql

# Verify backup size
ls -lh wallet_backup_*.sql

# Run final tests
pnpm test wallet
```

### 2. Release Deployment
```bash
# Build production bundle
pnpm build

# Deploy frontend (Manus handles this via UI Publish button)
# Deploy backend (Manus handles this automatically)

# Verify deployment
curl -s https://your-domain.manus.space/api/health | grep -q "ok" && echo "✅ Deployment successful"
```

### 3. Post-Deployment Verification (Immediate - 5 minutes)

#### Authentication & Access Control
- [ ] User can log in successfully
- [ ] Non-authenticated users cannot access /wallet (redirected to login)
- [ ] Non-admin users cannot access /admin/wallet-topups (403 error)
- [ ] Admin users can access /admin/wallet-topups

#### Wallet Top-up Flow
- [ ] User can navigate to /wallet from navbar
- [ ] Wallet page displays current balance
- [ ] User can create a top-up request (test with 250฿ to verify bonus)
- [ ] User can upload slip image
- [ ] Admin can see pending top-ups in /admin/wallet-topups
- [ ] Admin can approve top-up
- [ ] User's wallet balance increases by creditedAmount (250฿ + 10฿ = 260฿)
- [ ] Top-up shows in user's history with correct amounts

#### Bonus Calculation Verification
- [ ] 249.99฿ top-up: No bonus (0฿)
- [ ] 250.00฿ top-up: +10฿ bonus (total 260฿)
- [ ] 499.99฿ top-up: +10฿ bonus (total 509.99฿)
- [ ] 500.00฿ top-up: +20฿ bonus (total 520฿)

#### Admin Approval Flow
- [ ] Admin can see: user name, requestedAmount, bonusAmount, creditedAmount
- [ ] Admin can approve top-up
- [ ] Admin can reject top-up with reason
- [ ] Rejection reason appears in user's wallet page
- [ ] Wallet not credited on rejection

#### Error Handling
- [ ] Invalid amount (0, negative) shows error
- [ ] File too large (>5MB) shows error
- [ ] Invalid file type shows error
- [ ] Network error during upload shows error
- [ ] Duplicate submission prevented (button disabled during upload)

#### UI/UX
- [ ] Wallet page responsive on mobile
- [ ] No console errors in browser DevTools
- [ ] All text visible and readable
- [ ] Loading states show spinner
- [ ] Empty states show helpful message

---

## 48-Hour Monitoring Checklist

### Hour 0-1: Critical Checks
- [ ] Monitor error logs for wallet-related errors
- [ ] Check database connection stability
- [ ] Verify no spike in API response times
- [ ] Monitor CPU/memory usage on server

### Hour 1-4: User Activity
- [ ] Monitor top-up submissions (should see activity)
- [ ] Monitor admin approvals (verify flow works)
- [ ] Check for any user-reported issues in support channel
- [ ] Verify wallet balance calculations are correct

### Hour 4-24: Stability
- [ ] Monitor for any intermittent errors
- [ ] Check admin logs for approval activity
- [ ] Verify no duplicate transactions
- [ ] Monitor database query performance

### Hour 24-48: Regression
- [ ] Verify manual slip payment still works (regression)
- [ ] Verify coupon functionality (regression)
- [ ] Verify points redemption (regression)
- [ ] Verify old pending orders still open correctly

### Key Monitoring Points
```
Error Patterns to Watch:
- "Wallet account not found" → Account creation issue
- "already processed" → Concurrent approval issue
- "Insufficient wallet balance" → Balance calculation issue
- Database connection errors → Database stability issue

Success Indicators:
- Top-up submissions increasing
- Admin approvals processing smoothly
- Wallet balances increasing correctly
- No duplicate transactions
- User satisfaction (no complaints)
```

---

## Rollback Plan

### Immediate Rollback (If Critical Issues Found)

**Option 1: Revert to Previous Checkpoint**
```bash
cd /home/ubuntu/ipenovel-v2
git checkout acbdd8dc  # Previous checkpoint before final hardening
pnpm build
# Redeploy via Manus UI Publish button
```

**Option 2: Disable Wallet Feature**
```bash
# Set environment variable to disable wallet
export WALLET_FEATURE_ENABLED=false
# Restart server
# Wallet routes will return 404
```

**Option 3: Restore Database**
```bash
# Restore from backup created before deployment
mysql -h $DB_HOST -u $DB_USER -p$DB_PASS < wallet_backup_YYYYMMDD_HHMMSS.sql
```

### Rollback Verification
- [ ] Wallet routes return 404 or are disabled
- [ ] Admin wallet page inaccessible
- [ ] "Pay with Wallet" button removed from cart
- [ ] Manual slip payment flow still works
- [ ] No wallet data lost (all tables intact)
- [ ] User sessions not affected

---

## Known Caveats & Monitoring Points

### Atomicity & Idempotency
- **Verified**: Wallet account creation is atomic (inside transaction)
- **Verified**: Concurrent approvals prevented (idempotency check)
- **Verified**: Wallet debit rolls back on transaction failure
- **Monitor**: Check logs for any "already processed" errors (should be rare)

### Bonus Calculation
- **Verified**: Tiers: <250=0%, 250-499=+10฿, ≥500=+20฿
- **Verified**: creditedAmount = requestedAmount + bonusAmount
- **Monitor**: Spot-check random approvals to verify bonus applied correctly

### User Joins in Logs
- **Fixed**: createdByName now joins creator user, not owner
- **Monitor**: Verify admin names appear correctly in topup logs

### Database Performance
- **Monitor**: Query performance on getTopupLogs (uses table aliases)
- **Monitor**: Transaction performance on approveWalletTopup (multiple steps)

---

## Support & Escalation

### Common Issues & Fixes

**Issue: "Wallet account not found" error**
- **Cause**: User doesn't have wallet account yet
- **Fix**: Fixed in final hardening - account created atomically on first approval
- **Verify**: Try approving a top-up for new user - should work

**Issue: User balance not increasing after approval**
- **Cause**: creditedAmount not being used (only requestedAmount credited)
- **Fix**: Fixed in final hardening - approveWalletTopup uses creditedAmount
- **Verify**: Approve 250฿ top-up, verify wallet increases by 260฿ (not 250฿)

**Issue: Admin sees wrong approver name in logs**
- **Cause**: createdByName was joining owner user instead of creator
- **Fix**: Fixed in final hardening - now uses table aliases
- **Verify**: Check topup logs - createdByName should show approver, not owner

**Issue: Duplicate approvals crediting wallet twice**
- **Cause**: Concurrent approval requests not prevented
- **Fix**: Fixed in final hardening - idempotency check prevents double-credit
- **Verify**: Try approving same top-up twice - second should fail with "already processed"

### Escalation Path
1. Check error logs in `.manus-logs/` directory
2. Review database for data consistency
3. Contact Manus support if database corruption suspected
4. Prepare rollback if needed

---

## Final Sign-Off

**Deployment Approved By:** [Your Name]  
**Date:** [Deployment Date]  
**Time:** [Deployment Time]  
**Checkpoint:** 549a734b  

**Go/No-Go Decision:** ✅ **GO FOR PRODUCTION**

**Reasoning:**
- All 26 wallet tests passing (atomicity, idempotency, bonus tiers, E2E)
- Staging E2E verification complete (submission → approval → consistency)
- Critical fixes verified: atomic account creation, correct user joins, bonus calculation
- No known blockers or regressions
- Monitoring plan in place
- Rollback plan documented

**Next Steps After Release:**
1. Monitor for 48 hours per checklist
2. Gather user feedback
3. Plan maintenance window for any non-critical improvements
4. Document any issues for future releases
