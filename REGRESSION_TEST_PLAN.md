# Regression Test Plan - Post Blocker Fixes

## Overview
Comprehensive regression testing covering all 10 critical areas after fixing 6 critical release blockers.

---

## 1. MANUS AUTH LOGIN/SESSION PROTECTION

### Test Cases

#### 1.1 User Login Flow
- [ ] User can login via Manus OAuth
- [ ] Session cookie is created after login
- [ ] User is redirected to home page after login
- [ ] User info is displayed in header (name, points)
- [ ] Logout clears session cookie
- [ ] User cannot access protected routes without login

#### 1.2 Session Protection
- [ ] Protected procedures require authentication
- [ ] Unauthenticated requests to protected endpoints return 401/FORBIDDEN
- [ ] Session persists across page refreshes
- [ ] Session expires after inactivity (if configured)
- [ ] User context is correctly injected in procedures

#### 1.3 Authorization Boundaries
- [ ] Regular users cannot access admin routes
- [ ] Admin users can access admin routes
- [ ] User role is correctly set (admin/user)
- [ ] Owner user is automatically set as admin

---

## 2. MULTI-ITEM CART AND CHECKOUT

### Test Cases

#### 2.1 Cart Management
- [ ] User can add single episode to cart
- [ ] User can add multiple episodes from different novels to cart
- [ ] Cart prevents duplicate items (same episode)
- [ ] Cart prevents already-purchased episodes
- [ ] User can remove item from cart
- [ ] User can clear entire cart
- [ ] Cart persists across page refreshes
- [ ] Cart is user-specific (users see only their items)

#### 2.2 Checkout Flow
- [ ] User can proceed to checkout from cart
- [ ] Checkout displays correct subtotal (sum of all items)
- [ ] Checkout displays item details (novel, episode, price)
- [ ] User can apply valid coupon at checkout
- [ ] User can redeem points at checkout
- [ ] Checkout calculates correct discount amount
- [ ] Checkout calculates correct points discount
- [ ] Checkout displays correct total amount
- [ ] User can submit order

#### 2.3 Multi-Item Order Creation
- [ ] Order is created with all cart items
- [ ] Order has one order header (single orderNumber)
- [ ] Order has multiple orderItems (one per episode)
- [ ] Order status is "pending" after creation
- [ ] Order total matches checkout calculation
- [ ] Cart is cleared after order creation
- [ ] User can view order in order history

---

## 3. ORDER NUMBER GENERATION AND PAYMENT SUBMISSION

### Test Cases

#### 3.1 Order Number Generation
- [ ] Order number is unique per order
- [ ] Order number format is consistent (ORD-XXXXXXXX-XXXXXX)
- [ ] Order number is generated once and never changes
- [ ] Order number is displayed in order history
- [ ] Order number is displayed in payment slip upload page

#### 3.2 Payment Slip Submission
- [ ] User can upload payment slip image
- [ ] Payment slip is stored in S3
- [ ] Payment slip URL is saved in database
- [ ] Payment submission timestamp is recorded
- [ ] Payment status changes to "pending_review" after submission
- [ ] User can view submitted payment slip
- [ ] User cannot submit payment slip twice for same order

#### 3.3 Payment Status Tracking
- [ ] Payment status is "pending" before submission
- [ ] Payment status is "pending_review" after slip submission
- [ ] Payment status is "approved" after admin approval
- [ ] Payment status is "rejected" after admin rejection
- [ ] User can see payment status in order details

---

## 4. ADMIN APPROVE/REJECT FLOW

### Test Cases

#### 4.1 Admin Payment Verification Queue
- [ ] Admin can see pending payments list
- [ ] Pending payments are sorted newest to oldest
- [ ] Admin can view payment slip image
- [ ] Admin can view order details
- [ ] Admin can view order items
- [ ] Admin can view customer info

#### 4.2 Payment Approval
- [ ] Admin can approve payment
- [ ] Approval changes payment status to "approved"
- [ ] Approval timestamp is recorded
- [ ] Admin user ID is recorded as reviewer
- [ ] Order status changes to "approved"
- [ ] Order history is updated with approval action
- [ ] Approving twice is idempotent (no duplicates)

#### 4.3 Payment Rejection
- [ ] Admin can reject payment
- [ ] Rejection changes payment status to "rejected"
- [ ] Rejection reason is recorded
- [ ] Rejection timestamp is recorded
- [ ] Admin user ID is recorded as reviewer
- [ ] Order status changes to "rejected"
- [ ] Order history is updated with rejection action
- [ ] User can see rejection reason

#### 4.4 Admin Authorization
- [ ] Only admin users can access payment verification page
- [ ] Non-admin users cannot approve/reject payments
- [ ] Non-admin users cannot access admin routes

---

## 5. PURCHASES / ENTITLEMENT CREATION

### Test Cases

#### 5.1 Entitlement Granting on Approval
- [ ] Purchase record is created when payment is approved
- [ ] Purchase has correct userId
- [ ] Purchase has correct episodeId
- [ ] Purchase has correct novelId
- [ ] Purchase has correct orderId
- [ ] Purchase status is "active"
- [ ] Purchase createdAt timestamp is recorded

#### 5.2 Idempotent Entitlement Creation
- [ ] Approving payment twice creates only one purchase
- [ ] Purchase is not duplicated on second approval
- [ ] Unique constraint on (userId, episodeId) prevents duplicates

#### 5.3 No Entitlement on Rejection
- [ ] No purchase record is created when payment is rejected
- [ ] User cannot access episode if payment is rejected
- [ ] User can reorder same episode after rejection

#### 5.4 Purchase Verification
- [ ] Purchase can be queried by userId
- [ ] Purchase can be queried by episodeId
- [ ] Purchase can be queried by orderId
- [ ] User can see all their purchases

---

## 6. MY NOVELS CORRECTNESS

### Test Cases

#### 6.1 My Novels Display
- [ ] My Novels page shows all purchased episodes
- [ ] Episodes are grouped by novel
- [ ] Each novel shows all purchased episodes
- [ ] Episode details are correct (title, price, episode number)
- [ ] Only purchased episodes are shown (not cart items)
- [ ] Only episodes from approved orders are shown

#### 6.2 Purchase Status Display
- [ ] Purchased episodes show "Purchased" badge
- [ ] Non-purchased episodes don't show badge
- [ ] Episode price is displayed
- [ ] Purchase date is displayed

#### 6.3 My Novels Grouping
- [ ] Episodes from same novel are grouped together
- [ ] Novel title is displayed as group header
- [ ] Novel cover/thumbnail is displayed
- [ ] Multiple episodes from same novel are shown in list

---

## 7. READ/DOWNLOAD ACCESS CONTROL

### Test Cases

#### 7.1 Access Verification
- [ ] User can access purchased episodes
- [ ] User cannot access non-purchased episodes
- [ ] Non-purchased episodes show "Purchase to read" message
- [ ] Download link is only shown for purchased episodes

#### 7.2 Pre-signed URL Generation
- [ ] Pre-signed URL is generated for purchased episodes
- [ ] Pre-signed URL is only valid for entitled user
- [ ] Pre-signed URL expires after timeout
- [ ] Non-entitled users cannot use pre-signed URL
- [ ] Download works correctly with pre-signed URL

#### 7.3 Access Control Boundaries
- [ ] User A cannot access User B's purchased episodes
- [ ] User A cannot download User B's files
- [ ] User A cannot generate pre-signed URLs for User B's episodes
- [ ] Admin cannot bypass entitlement checks

---

## 8. COUPON AND POINTS CORRECTNESS

### Test Cases

#### 8.1 Coupon Validation at Checkout
- [ ] Valid coupon is accepted
- [ ] Invalid coupon is rejected with error
- [ ] Expired coupon is rejected
- [ ] Coupon with usage limit reached is rejected
- [ ] Coupon discount is calculated correctly
- [ ] Coupon code is stored in order

#### 8.2 Coupon Usage Recording (FIXED)
- [ ] Coupon usage is NOT recorded at checkout
- [ ] Coupon usage is recorded when payment is approved
- [ ] Coupon usage is NOT recorded when payment is rejected
- [ ] Coupon usage count increments correctly
- [ ] Coupon usage is tracked per user

#### 8.3 Points Redemption at Checkout
- [ ] User can redeem points at checkout
- [ ] Points discount is calculated correctly (1 point = 1 currency)
- [ ] User cannot redeem more points than balance
- [ ] Points amount is stored in order

#### 8.4 Points Deduction (FIXED)
- [ ] Points are NOT deducted at checkout
- [ ] Points are deducted when payment is approved
- [ ] Points are NOT deducted when payment is rejected
- [ ] Points deduction is idempotent (no duplicates on re-approval)
- [ ] Points transaction is recorded

#### 8.5 Points Earning
- [ ] Points are earned when order is approved
- [ ] Earning rate is correct (100 currency = 1 point)
- [ ] Points transaction is recorded
- [ ] Points balance is updated correctly

---

## 9. AUTHORIZATION BOUNDARIES BETWEEN USERS AND ADMINS

### Test Cases

#### 9.1 User Authorization
- [ ] Users can only view their own orders
- [ ] Users can only view their own cart
- [ ] Users can only remove their own cart items
- [ ] Users can only view their own wishlists
- [ ] Users can only remove their own wishlist items
- [ ] Users can only view their own purchases
- [ ] Users cannot access admin panel
- [ ] Users cannot approve/reject payments

#### 9.2 Admin Authorization
- [ ] Admins can view all orders
- [ ] Admins can view all payments
- [ ] Admins can approve/reject payments
- [ ] Admins can create/edit banners
- [ ] Admins can create/edit coupons
- [ ] Admins can view settings
- [ ] Admins can access admin panel
- [ ] Admins cannot bypass entitlement checks

#### 9.3 Cross-User Protection
- [ ] User A cannot remove User B's cart items
- [ ] User A cannot remove User B's wishlist items
- [ ] User A cannot view User B's orders
- [ ] User A cannot view User B's purchases
- [ ] User A cannot download User B's files

---

## 10. CRITICAL BLOCKER FIXES VERIFICATION

### Test Cases

#### 10.1 Fix 1.1 & 1.2: Payment Approval ID Lookup
- [ ] Payment approval uses correct ID lookup
- [ ] getPaymentById() function works correctly
- [ ] Payment is found by payment ID (not order ID)
- [ ] Approval succeeds with correct lookup

#### 10.2 Fix 1.2: Idempotency Protection
- [ ] Approving payment twice doesn't duplicate purchases
- [ ] Approving payment twice doesn't duplicate points
- [ ] Idempotency check is reached (not bypassed)

#### 10.3 Fix 1.3: Cart Item Authorization
- [ ] Cart item removal is authorized
- [ ] Unauthorized removal is rejected
- [ ] User can only remove their own items

#### 10.4 Fix 1.4: Wishlist Authorization
- [ ] Wishlist removal is authorized
- [ ] Unauthorized removal is rejected
- [ ] User can only remove their own items

#### 10.5 Fix 1.5: Coupon Usage Timing
- [ ] Coupon usage is recorded on approval (not checkout)
- [ ] Coupon usage is not recorded on rejection
- [ ] Coupon usage is not duplicated on re-approval

#### 10.6 Fix 1.6: Points Deduction Timing
- [ ] Points are deducted on approval (not checkout)
- [ ] Points are not deducted on rejection
- [ ] Points are not duplicated on re-approval

---

## Test Execution Results

### Summary
- Total Test Cases: 120+
- Passed: ___
- Failed: ___
- Blocked: ___
- Not Applicable: ___

### Critical Issues Found
(List any critical issues found during testing)

### Major Issues Found
(List any major issues found during testing)

### Minor Issues Found
(List any minor issues found during testing)

---

## Sign-Off

- [ ] All critical test cases passed
- [ ] All major test cases passed
- [ ] No blocking issues remain
- [ ] Project is ready for release

**Tested by:** _______________
**Date:** _______________
**Status:** _______________
