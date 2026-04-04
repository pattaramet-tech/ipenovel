# Wallet Feature - Final Release Package

**Release Date:** March 30, 2026  
**Version:** 96c828e3  
**Status:** ✅ Production Ready  

---

## 1. Final Changed Files List

### Backend Files (Server)
- `server/routers.ts` - Wallet router at top-level of appRouter (lines 1001-1036)
- `server/services/walletService.ts` - Wallet business logic with atomic transactions
- `server/db.ts` - Database helpers for wallet operations

### Frontend Files (Client)
- `client/src/pages/WalletPage.tsx` - User wallet page with guided top-up flow
- `client/src/pages/AdminWalletTopupsPage.tsx` - Admin review and approval page
- `client/src/pages/CartPage.tsx` - Added "Pay with Wallet" button
- `client/src/App.tsx` - Added /wallet and /admin/wallet-topups routes
- `client/src/components/Navbar.tsx` - Added Wallet navigation link (Thai: กระเป๋าเงิน)
- `client/src/components/AdminLayout.tsx` - Added Wallet Top-ups admin menu item
- `client/src/contexts/LanguageContext.tsx` - Added wallet translations (Thai/English)

### Test Files
- `server/wallet.service.test.ts` - Unit tests for wallet service methods
- `server/wallet-behavior.test.ts` - Comprehensive behavior/regression tests (30+ cases)

### Documentation Files
- `WALLET_E2E_VERIFICATION.md` - End-to-end verification checklist
- `WALLET_RELEASE_READINESS.md` - Release approval report
- `WALLET_DEPLOYMENT_HANDOFF.md` - Deployment guide with smoke tests

---

## 2. Database Migrations

### Pre-Deployment Verification
```bash
# Verify database connection
mysql -h $DB_HOST -u $DB_USER -p$DB_PASS -e "SELECT VERSION();"

# Backup production database
mysqldump -h $DB_HOST -u $DB_USER -p$DB_PASS --all-databases > wallet_release_backup_$(date +%Y%m%d_%H%M%S).sql
```

### Migration Commands
```bash
# Run from project root
cd /home/ubuntu/ipenovel-v2

# Generate migrations from schema
pnpm db:generate

# Apply migrations to database
pnpm db:push

# Verify migrations applied
mysql -h $DB_HOST -u $DB_USER -p$DB_PASS ipenovel -e "SHOW TABLES LIKE 'wallet%';"
```

### Expected Database Tables
```sql
-- Verify these tables exist after migration:
SHOW TABLES LIKE 'wallet%';

-- Expected output:
-- walletAccounts
-- walletTransactions
-- walletTopups

-- Verify wallet columns:
DESCRIBE walletAccounts;
-- Columns: id, userId, balance, createdAt, updatedAt

DESCRIBE walletTransactions;
-- Columns: id, walletAccountId, type, amount, description, createdAt

DESCRIBE walletTopups;
-- Columns: id, userId, requestedAmount, slipImageUrl, status, rejectionReason, reviewedByUserId, reviewedAt, createdAt, updatedAt
```

---

## 3. Production Smoke Test Checklist

### Pre-Deployment (Run Before Release)
- [ ] Database backup completed and verified
- [ ] All TypeScript compiles without errors: `pnpm tsc --noEmit`
- [ ] All tests pass: `pnpm test`
- [ ] Build succeeds: `pnpm build`
- [ ] No console errors in dev server: `pnpm dev`

### Post-Deployment (Run Immediately After Release)

#### Authentication & Access Control
- [ ] User can log in successfully
- [ ] Non-authenticated users cannot access /wallet (redirected to login)
- [ ] Non-admin users cannot access /admin/wallet-topups (403 error)
- [ ] Admin users can access /admin/wallet-topups

#### Wallet Top-up Flow (Upload-Slip-First)
- [ ] User can navigate to /wallet from navbar (Thai: กระเป๋าเงิน)
- [ ] Wallet page displays current balance (shows 0.00 for new users)
- [ ] Wallet page shows bonus tiers: <250฿=0%, 250-499฿=+10฿, ≥500฿=+20฿
- [ ] User can click "Request Top-up" button
- [ ] User can enter amount and click "Create Request"
- [ ] After creation, user immediately sees payment step with:
  - [ ] Top-up summary showing: requestedAmount, bonusAmount, creditedAmount (total)
  - [ ] Request ID and status: "pending"
  - [ ] QR code image loads correctly
  - [ ] File upload input accepts JPEG/PNG/PDF
  - [ ] "Upload Slip" button is disabled until file selected
- [ ] User can select a file and upload slip
- [ ] After upload, user sees success toast: "Slip uploaded successfully. Waiting for admin review."
- [ ] User is returned to main wallet page
- [ ] Top-up request shows in list with status "pending"
- [ ] Top-up list displays: amount, bonus, total (creditedAmount), status
- [ ] User can click "Upload Slip" button again if needed

#### Admin Wallet Review
- [ ] Admin can navigate to /admin/wallet-topups from admin menu
- [ ] Admin sees list of pending top-up requests
- [ ] Admin can see: user name, requestedAmount, bonusAmount, creditedAmount (total), slip image, created time, status
- [ ] Admin can click "Approve" button
- [ ] After approval, top-up status changes to "approved"
- [ ] User's wallet balance increases by creditedAmount (requested + bonus)
- [ ] Bonus is correctly applied based on tier: <250=0, 250-499=10, ≥500=20
- [ ] Admin can reject with reason (modal dialog, not prompt)
- [ ] After rejection, top-up status changes to "rejected"
- [ ] User sees rejection reason in wallet page (red text below badge)
- [ ] User's wallet balance does NOT increase on rejection

#### Wallet Checkout Flow
- [ ] User adds items to cart
- [ ] User sees "Pay with Wallet" button below "Proceed to Checkout"
- [ ] User can click "Pay with Wallet"
- [ ] If balance insufficient: error toast shows "Insufficient wallet balance"
- [ ] If balance sufficient: order created, purchases granted, user redirected to /my-novels
- [ ] Purchased content accessible in /my-novels
- [ ] Wallet balance decreases by order total (after discounts/points)

#### Manual Slip Payment (Regression)
- [ ] User can still use "Proceed to Checkout" button
- [ ] Manual slip payment flow works unchanged
- [ ] User can upload slip for manual payment
- [ ] Admin can approve/reject manual payments

#### Error Handling
- [ ] Invalid amount (0, negative, non-numeric) shows error toast
- [ ] File too large (>5MB) shows error toast
- [ ] Invalid file type shows error toast
- [ ] Network error during upload shows error toast
- [ ] Duplicate submission prevented (button disabled during upload)

#### UI/UX
- [ ] Wallet page responsive on mobile (test at 375px width)
- [ ] Payment step responsive on mobile
- [ ] All text visible and readable
- [ ] No console errors in browser DevTools
- [ ] No alert() dialogs (all feedback via toast)
- [ ] Loading states show spinner/skeleton
- [ ] Empty states show helpful message

---

## 4. Rollback Checklist

### Immediate Rollback (If Critical Issues Found)
```bash
# Option 1: Rollback to previous checkpoint
cd /home/ubuntu/ipenovel-v2
git checkout 5f557b9d  # Previous stable checkpoint before final QA

# Option 2: Revert database migrations
# Restore from backup created before deployment
mysql -h $DB_HOST -u $DB_USER -p$DB_PASS < wallet_release_backup_YYYYMMDD_HHMMSS.sql

# Option 3: Disable wallet feature via environment variable
# Set WALLET_FEATURE_ENABLED=false in .env
# Restart server
```

### Rollback Verification
- [ ] Wallet routes return 404 (feature disabled)
- [ ] Admin wallet page inaccessible
- [ ] "Pay with Wallet" button removed from cart
- [ ] Manual slip payment flow still works
- [ ] No wallet data lost (all tables intact)
- [ ] User sessions not affected

### Partial Rollback (If Only UI Issues)
```bash
# Revert only frontend changes
git checkout 5f557b9d -- client/src/pages/WalletPage.tsx
git checkout 5f557b9d -- client/src/pages/AdminWalletTopupsPage.tsx
pnpm build
# Redeploy frontend only
```

---

## 5. Admin Operating Guide for Wallet Top-ups

### Daily Workflow

#### Morning Check
1. Log in to admin dashboard
2. Navigate to **Admin Menu → Wallet Top-ups** (or `/admin/wallet-topups`)
3. Review pending top-up requests:
   - Sort by newest first (default)
   - Check slip image quality (must be legible)
   - Verify amount matches user's claim

#### Approval Process
1. Click **Approve** button next to pending request
2. Confirm action (no additional dialog needed)
3. System automatically:
   - Updates top-up status to "approved"
   - Credits user's wallet balance
   - Creates wallet transaction record
   - Sends notification to user (if enabled)
4. User can immediately use wallet balance for purchases

#### Rejection Process
1. Click **Reject** button next to pending request
2. Enter rejection reason in modal (e.g., "Slip image unclear", "Amount mismatch")
3. Click **Confirm Reject**
4. System automatically:
   - Updates top-up status to "rejected"
   - Does NOT credit wallet balance
   - Stores rejection reason
   - Sends notification to user with reason
5. User can see rejection reason in their wallet page

#### Suspicious Activity
- **Duplicate requests:** Check if same user submitted multiple requests for same amount. May indicate:
  - User didn't see confirmation (normal)
  - User trying to exploit system (investigate)
- **Unusual amounts:** Requests significantly higher than typical. Review slip carefully.
- **Blurry/Invalid slips:** Always reject with clear reason. User can resubmit.

### Weekly Reporting
```sql
-- Generate weekly wallet top-up report
SELECT 
  DATE(createdAt) as date,
  COUNT(*) as total_requests,
  SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) as approved,
  SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) as rejected,
  SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending,
  SUM(CASE WHEN status='approved' THEN requestedAmount ELSE 0 END) as approved_total
FROM walletTopups
WHERE createdAt >= DATE_SUB(NOW(), INTERVAL 7 DAY)
GROUP BY DATE(createdAt)
ORDER BY date DESC;
```

### Troubleshooting

| Issue | Solution |
|-------|----------|
| Slip image won't load | Check S3 upload status. Verify URL in database. |
| Can't approve/reject | Verify admin role. Check browser console for errors. |
| Balance not updating | Check wallet transaction record created. Verify user's wallet account exists. |
| User sees old rejection reason | Clear browser cache. Refresh wallet page. |

---

## 6. Support Guide for Common Wallet User Issues

### User Onboarding

#### "How do I add money to my wallet?"
1. Click **Wallet** (กระเป๋าเงิน) in the top navigation
2. Click **Request Top-up** button
3. Enter the amount you want to add
4. Click **Create Request**
5. Scan the QR code with your banking app and pay
6. Take a screenshot of the payment confirmation
7. Upload the screenshot on the same page
8. Wait for admin approval (usually within 24 hours)
9. Your wallet balance will update automatically

#### "Why is my wallet balance still 0?"
- Top-up request is still pending admin review
- Check your wallet page for status
- If rejected, you'll see the reason in red text

#### "How do I use my wallet to buy novels?"
1. Add items to your cart
2. Click **Pay with Wallet** button (below "Proceed to Checkout")
3. If you have enough balance, purchase completes immediately
4. Access your novels in **My Novels** section

### Common Issues

#### "My top-up was rejected. What do I do?"
1. Check your wallet page for rejection reason
2. Common reasons:
   - **"Slip image unclear"** → Take a clearer screenshot and resubmit
   - **"Amount mismatch"** → Verify you paid the exact amount shown
   - **"Invalid slip format"** → Use JPEG/PNG/PDF format
3. Create a new top-up request and resubmit

#### "I uploaded a slip but nothing happened"
- Check that upload completed (success message appeared)
- Refresh your wallet page
- If still pending after 24 hours, contact support

#### "I don't have enough wallet balance"
- Your top-up request may still be pending
- Check status in your wallet page
- If approved but balance not updated, refresh page
- If still not updated after 5 minutes, contact support

#### "The QR code won't scan"
- Try taking a screenshot of the QR code and scanning that
- Make sure your phone camera is clean
- Try a different banking app
- If still failing, contact support with screenshot

#### "I paid but my slip was rejected"
- Verify you paid the exact amount shown
- Take a clearer screenshot showing:
  - Payment amount
  - Recipient name/account
  - Timestamp
- Create a new top-up request with better slip image

#### "My wallet balance is wrong"
- Refresh the page (may be caching issue)
- Check recent transactions to verify all purchases
- If discrepancy persists, contact support with:
  - Expected balance
  - Actual balance
  - List of recent purchases

### FAQ

**Q: How long does approval take?**  
A: Usually 1-2 hours during business hours, up to 24 hours maximum.

**Q: Can I cancel a top-up request?**  
A: Not through the UI currently. Contact support if needed.

**Q: What if I overpay?**  
A: Contact support. Admin can manually adjust balance.

**Q: Can I use wallet and manual payment together?**  
A: Not in single transaction. Choose one method per purchase.

**Q: Is my wallet balance secure?**  
A: Yes. Wallet balance stored in encrypted database. All transactions logged.

---

## 7. Monitoring & Log Points (First 48 Hours)

### Critical Metrics to Monitor

#### Real-Time Alerts (Set Up in Monitoring Dashboard)
```
1. Error Rate > 5% for /api/trpc/wallet.* endpoints
   Action: Page on-call engineer immediately
   
2. Database query time > 5 seconds for wallet queries
   Action: Check for slow queries, possible deadlock
   
3. S3 upload failures > 10% for slip images
   Action: Check S3 bucket permissions, quota
   
4. User complaints in support channel > 3 in 1 hour
   Action: Investigate common issue pattern
```

### Log Points to Monitor

#### Server Logs
```bash
# Watch for wallet errors in real-time
tail -f /var/log/app.log | grep -i wallet

# Check for failed transactions
grep "walletCheckout.*error\|walletCheckout.*failed" /var/log/app.log

# Monitor top-up slip uploads
grep "uploadTopupSlip\|uploadPaymentSlip" /var/log/app.log

# Check database connection issues
grep "wallet.*database\|wallet.*connection" /var/log/app.log
```

#### Database Logs
```sql
-- Monitor wallet transaction volume
SELECT 
  DATE_FORMAT(createdAt, '%Y-%m-%d %H:00') as hour,
  COUNT(*) as transaction_count,
  SUM(amount) as total_amount
FROM walletTransactions
WHERE createdAt >= DATE_SUB(NOW(), INTERVAL 48 HOUR)
GROUP BY hour
ORDER BY hour DESC;

-- Check for failed top-ups
SELECT * FROM walletTopups 
WHERE status='rejected' 
AND createdAt >= DATE_SUB(NOW(), INTERVAL 48 HOUR)
ORDER BY createdAt DESC;

-- Monitor wallet account creation
SELECT COUNT(*) as new_wallets
FROM walletAccounts
WHERE createdAt >= DATE_SUB(NOW(), INTERVAL 48 HOUR);
```

#### Frontend Logs (Browser Console)
```
Monitor for:
- "Failed to upload slip" errors
- "Wallet checkout failed" errors
- Network request failures to /api/upload
- Unhandled promise rejections in wallet components
```

### 24-Hour Checkpoint

After 24 hours, generate report:

```sql
SELECT 
  'Wallet Accounts' as metric,
  COUNT(*) as value
FROM walletAccounts
WHERE createdAt >= DATE_SUB(NOW(), INTERVAL 24 HOUR)

UNION ALL

SELECT 
  'Top-up Requests',
  COUNT(*)
FROM walletTopups
WHERE createdAt >= DATE_SUB(NOW(), INTERVAL 24 HOUR)

UNION ALL

SELECT 
  'Approved Top-ups',
  COUNT(*)
FROM walletTopups
WHERE status='approved'
AND createdAt >= DATE_SUB(NOW(), INTERVAL 24 HOUR)

UNION ALL

SELECT 
  'Rejected Top-ups',
  COUNT(*)
FROM walletTopups
WHERE status='rejected'
AND createdAt >= DATE_SUB(NOW(), INTERVAL 24 HOUR)

UNION ALL

SELECT 
  'Wallet Checkouts',
  COUNT(*)
FROM walletTransactions
WHERE type='debit'
AND description LIKE '%checkout%'
AND createdAt >= DATE_SUB(NOW(), INTERVAL 24 HOUR)

UNION ALL

SELECT 
  'Total Wallet Revenue',
  SUM(amount)
FROM walletTransactions
WHERE type='credit'
AND createdAt >= DATE_SUB(NOW(), INTERVAL 24 HOUR);
```

### 48-Hour Checkpoint

If no critical issues found:
- [ ] All smoke tests passed
- [ ] Error rate < 1%
- [ ] No data corruption detected
- [ ] User feedback positive
- [ ] Admin operations smooth
- [ ] Database performance normal

**Status: ✅ RELEASE STABLE**

If issues found:
- [ ] Document issue
- [ ] Implement fix
- [ ] Run regression tests
- [ ] Deploy fix
- [ ] Continue monitoring

---

## Release Sign-Off

- **Release Manager:** _______________
- **QA Lead:** _______________
- **Database Admin:** _______________
- **Date:** _______________

---

## Emergency Contacts

| Role | Contact | Escalation |
|------|---------|-----------|
| On-Call Engineer | [Phone/Slack] | Page immediately if error rate > 10% |
| Database Admin | [Phone/Slack] | Page if DB connection issues |
| Support Lead | [Phone/Slack] | Notify if > 5 user complaints in 1 hour |
| Product Manager | [Phone/Slack] | Daily summary report |

---

## Post-Release (Day 3+)

- [ ] Collect user feedback
- [ ] Monitor error rates (should stabilize < 0.5%)
- [ ] Review admin workflow efficiency
- [ ] Plan for Phase 2 features:
  - [ ] Wallet balance auto-refresh
  - [ ] Transaction export (CSV)
  - [ ] Admin analytics dashboard
