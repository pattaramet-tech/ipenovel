# Wallet System - End-to-End Verification Checklist

## Pre-Verification Setup
- [ ] Dev server running: `pnpm dev`
- [ ] Database clean or test data isolated
- [ ] Browser console open for error monitoring
- [ ] Network tab open to verify API calls

## User Flows - Wallet Top-up

### Flow 1: Create Top-up Request
- [ ] Navigate to /wallet
- [ ] Click "Create Top-up Request"
- [ ] Enter amount (e.g., 500 THB)
- [ ] Submit
- [ ] Verify: Top-up appears in "Pending Requests" with status "pending"
- [ ] Verify: No balance change yet
- [ ] Verify: API call to `trpc.wallet.createTopupRequest` succeeds

### Flow 2: Upload Payment Slip
- [ ] From /wallet, find pending top-up
- [ ] Click "Upload Slip"
- [ ] Select image file (or use test image)
- [ ] Verify: Slip uploads successfully
- [ ] Verify: Slip image appears in top-up request
- [ ] Verify: Status remains "pending"
- [ ] Verify: API call to `trpc.wallet.uploadTopupSlip` succeeds

### Flow 3: Wallet Balance Display
- [ ] View /wallet page
- [ ] Verify: Current balance displays correctly
- [ ] Verify: Transaction history shows all previous wallet operations
- [ ] Verify: Top-up requests section shows pending requests
- [ ] Verify: API calls to `trpc.wallet.getSummary` and `trpc.wallet.getBalance` succeed

## Admin Flows - Top-up Approval

### Flow 4: Admin Reviews Pending Top-ups
- [ ] Navigate to /admin/wallet-topups
- [ ] Verify: Page loads (requires admin login)
- [ ] Verify: Pending top-up requests display in list
- [ ] Verify: Shows user name, email, amount, slip image, created time
- [ ] Verify: API call to `trpc.wallet.admin.listPendingTopups` succeeds

### Flow 5: Admin Approves Top-up
- [ ] From /admin/wallet-topups, find pending top-up
- [ ] Click "Approve" button
- [ ] Verify: Success toast appears
- [ ] Verify: Top-up status changes to "approved"
- [ ] Verify: Top-up disappears from pending list
- [ ] Verify: API call to `trpc.wallet.admin.approveTopup` succeeds
- [ ] **Critical**: Verify user's wallet balance increased by exactly the requested amount
- [ ] **Critical**: Verify only ONE transaction created (no duplicates)

### Flow 6: Admin Rejects Top-up
- [ ] From /admin/wallet-topups, find another pending top-up
- [ ] Click "Reject" button
- [ ] Enter rejection reason (e.g., "Invalid slip format")
- [ ] Verify: Success toast appears
- [ ] Verify: Top-up status changes to "rejected"
- [ ] Verify: Top-up disappears from pending list
- [ ] Verify: API call to `trpc.wallet.admin.rejectTopup` succeeds
- [ ] **Critical**: Verify user's wallet balance NOT changed
- [ ] **Critical**: Verify NO transaction created for this rejection

### Flow 7: Idempotency - Approve Twice
- [ ] Create new top-up request
- [ ] Approve it once
- [ ] Note the balance after first approval
- [ ] Attempt to approve the same top-up again (if UI allows)
- [ ] **Critical**: Verify balance did NOT increase again
- [ ] **Critical**: Verify only ONE transaction exists for this top-up

## User Flows - Wallet Checkout

### Flow 8: Add Items to Cart
- [ ] Browse novels/episodes
- [ ] Add 1-2 items to cart
- [ ] Navigate to /cart
- [ ] Verify: Cart displays items with prices
- [ ] Verify: Total amount calculated correctly

### Flow 9: Wallet Checkout - Sufficient Balance
- [ ] Ensure user has wallet balance >= cart total
- [ ] From /cart, click "Pay with Wallet" button
- [ ] Verify: Checkout processes
- [ ] Verify: Success message appears
- [ ] Verify: Cart cleared
- [ ] Verify: Order created with status "completed"
- [ ] Verify: API call to `trpc.checkout.walletCheckout` succeeds
- [ ] **Critical**: Verify wallet balance decreased by exact cart total
- [ ] **Critical**: Verify purchases/entitlements created immediately
- [ ] **Critical**: Verify user can access purchased content immediately

### Flow 10: Wallet Checkout - Insufficient Balance
- [ ] Ensure user has wallet balance < cart total
- [ ] From /cart, click "Pay with Wallet" button
- [ ] Verify: Checkout fails with error message
- [ ] Verify: Error message is clear (e.g., "Insufficient wallet balance")
- [ ] Verify: Cart NOT cleared
- [ ] Verify: No order created
- [ ] **Critical**: Verify wallet balance unchanged
- [ ] **Critical**: Verify no transaction created

### Flow 11: Wallet Page After Checkout
- [ ] Navigate to /wallet
- [ ] Verify: Balance reflects the debit from checkout
- [ ] Verify: Transaction history shows "checkout" transaction
- [ ] Verify: Transaction references the order ID
- [ ] Verify: Timestamp is recent

## Legacy Flows - Manual Slip Payment

### Flow 12: Manual Slip Payment Still Works
- [ ] Add items to cart
- [ ] Navigate to /cart
- [ ] Click "Pay with Slip" button (existing manual payment)
- [ ] Verify: Manual payment flow works unchanged
- [ ] Verify: Upload slip, submit
- [ ] Verify: Order created with status "pending_payment"
- [ ] Verify: Wallet balance NOT affected
- [ ] Verify: Admin can approve/reject from /admin/payments

### Flow 13: Both Payment Options Available
- [ ] Navigate to /cart with items
- [ ] Verify: Both "Pay with Wallet" and "Pay with Slip" buttons visible
- [ ] Verify: User can choose either option
- [ ] Verify: Choosing one doesn't disable the other

## Admin Flows - Backward Compatibility

### Flow 14: Admin Payments Page Still Works
- [ ] Navigate to /admin/payments
- [ ] Verify: Manual slip payments display
- [ ] Verify: Can approve/reject manual payments
- [ ] Verify: Wallet payments do NOT appear here (they're auto-approved)
- [ ] Verify: Existing admin flow unchanged

## Authorization & Security

### Flow 15: Non-admin Cannot Access Wallet Admin
- [ ] Log in as regular user
- [ ] Try to navigate to /admin/wallet-topups
- [ ] Verify: Access denied or redirected
- [ ] Verify: Cannot call admin endpoints

### Flow 16: User Cannot View Other User's Wallet
- [ ] Log in as User A
- [ ] Note User A's balance
- [ ] Log in as User B
- [ ] Verify: User B's wallet is independent
- [ ] Verify: Cannot access User A's data

## Data Integrity

### Flow 17: Transaction History Complete
- [ ] Perform several wallet operations (topup, checkout, etc.)
- [ ] Navigate to /wallet
- [ ] Verify: All operations appear in transaction history
- [ ] Verify: No missing transactions
- [ ] Verify: Timestamps are in chronological order

### Flow 18: Balance Consistency
- [ ] Calculate balance from transaction history (sum of all amounts)
- [ ] Verify: Calculated balance matches displayed balance
- [ ] Verify: No balance drift

## Error Scenarios

### Flow 19: Invalid Input Handling
- [ ] Try to create top-up with amount = 0
- [ ] Verify: Validation error shown
- [ ] Try to create top-up with negative amount
- [ ] Verify: Validation error shown
- [ ] Try to upload non-image file as slip
- [ ] Verify: File type validation error shown

### Flow 20: Network Error Handling
- [ ] Simulate network error (DevTools > Network > Offline)
- [ ] Try to create top-up request
- [ ] Verify: Error message shown
- [ ] Verify: No partial state created
- [ ] Restore network
- [ ] Verify: Can retry successfully

## Performance & Load

### Flow 21: List Performance
- [ ] Create 50+ top-up requests
- [ ] Navigate to /admin/wallet-topups
- [ ] Verify: Page loads in < 3 seconds
- [ ] Verify: Pagination/virtualization works if implemented
- [ ] Verify: No UI freeze

## Final Verification Summary

**Must Pass (Blockers):**
- [ ] Wallet checkout succeeds and grants access immediately
- [ ] Top-up approval credits balance exactly once (no duplicates)
- [ ] Top-up rejection does NOT credit balance
- [ ] Insufficient balance fails safely (no partial debit)
- [ ] Manual slip payment flow unchanged
- [ ] Admin can approve/reject from /admin/wallet-topups

**Should Pass (Quality):**
- [ ] Balance consistency verified
- [ ] Transaction history complete
- [ ] Authorization enforced
- [ ] Error handling graceful
- [ ] Performance acceptable

**Known Limitations:**
- [ ] List any limitations found during testing
- [ ] Document any deferred features

---

## Test Results

**Date:** [Fill in]
**Tester:** [Fill in]
**Environment:** [Dev/Staging/Production]

**Blockers Found:** 
- [ ] None
- [ ] [List any blockers]

**Quality Issues Found:**
- [ ] None
- [ ] [List any issues]

**Sign-off:**
- [ ] Ready for production
- [ ] Needs fixes (see blockers)
- [ ] Needs further testing

