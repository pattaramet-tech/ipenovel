# Status Synchronization Audit

## Status Fields Identified

### 1. payment.status (payments table)
- **Possible values:** `pending` | `approved` | `rejected`
- **Default:** `pending`
- **Meaning:**
  - `pending`: Payment slip not yet submitted, or submitted but awaiting admin review
  - `approved`: Admin has verified and approved the payment
  - `rejected`: Admin has rejected the payment (rejectionReason will be set)

### 2. order.status (orders table)
- **Possible values:** `pending` | `approved` | `rejected` | `cancelled`
- **Default:** `pending`
- **Meaning:**
  - `pending`: Order created, awaiting payment approval
  - `approved`: Payment approved, purchase entitlements granted
  - `rejected`: Payment rejected, order cancelled
  - `cancelled`: Order cancelled by customer or system

### 3. order.paymentStatus (orders table)
- **Possible values:** `unpaid` | `submitted` | `approved` | `rejected`
- **Default:** `unpaid`
- **Meaning:**
  - `unpaid`: Order created, no payment slip submitted yet
  - `submitted`: Payment slip submitted, awaiting admin review
  - `approved`: Payment approved by admin
  - `rejected`: Payment rejected by admin

## Status Transition Flows

### Normal Approval Flow
```
Initial State:
  order.status = "pending"
  order.paymentStatus = "unpaid"
  payment.status = "pending"

After Payment Slip Submission:
  order.status = "pending" (no change)
  order.paymentStatus = "submitted"
  payment.status = "pending" (no change)

After Admin Approval:
  order.status = "approved"
  order.paymentStatus = "approved"
  payment.status = "approved"
  → Purchase entitlements granted
```

### Rejection Flow
```
Initial State:
  order.status = "pending"
  order.paymentStatus = "unpaid"
  payment.status = "pending"

After Payment Slip Submission:
  order.status = "pending" (no change)
  order.paymentStatus = "submitted"
  payment.status = "pending" (no change)

After Admin Rejection:
  order.status = "rejected"
  order.paymentStatus = "rejected"
  payment.status = "rejected"
  payment.rejectionReason = "reason text"
  → Purchase entitlements NOT granted
```

## Source of Truth

- **payment.status** is the source of truth for payment verification state
- **order.paymentStatus** should mirror payment.status
- **order.status** reflects the overall order state (pending → approved/rejected/cancelled)

## Consistency Rules

1. When `payment.status` changes, `order.paymentStatus` must change to match
2. When `payment.status` = "approved", `order.status` must be "approved"
3. When `payment.status` = "rejected", `order.status` must be "rejected"
4. When `payment.rejectionReason` is set, `order.notes` should also be updated
5. Never have `payment.status` = "approved" with `order.status` = "pending"
6. Never have `payment.status` = "rejected" with `order.status` = "approved"

## Files to Check

### Backend
- [ ] server/services/orderService.ts - approvePayment(), rejectPayment()
- [ ] server/db.ts - updateOrder(), updatePayment()
- [ ] server/routers.ts - payments.approve, payments.reject

### Frontend
- [ ] client/src/pages/PaymentPage.tsx - Display payment status
- [ ] client/src/pages/OrdersPage.tsx - Display order and payment status
- [ ] client/src/pages/OrderDetailPage.tsx - Display detailed status info
- [ ] client/src/pages/admin/AdminPaymentsPage.tsx - Admin payment review

## Current Issues Found

### Issue 1: Incomplete Status Sync in approvePayment()
- ✅ Updates payment.status = "approved"
- ✅ Updates order.status = "approved"
- ❌ Does NOT update order.paymentStatus = "approved"

### Issue 2: Incomplete Status Sync in rejectPayment()
- ✅ Updates payment.status = "rejected"
- ✅ Updates order.status = "rejected"
- ❌ Does NOT update order.paymentStatus = "rejected"
- ❌ Does NOT update order.notes with rejection reason

### Issue 3: Frontend Accesses Wrong Field
- OrdersPage.tsx tries to access order.rejectionReason
- Should access payment.rejectionReason instead

## Status Sync Implementation Checklist

- [ ] Fix approvePayment() to update order.paymentStatus
- [ ] Fix rejectPayment() to update order.paymentStatus and order.notes
- [ ] Fix OrdersPage.tsx to read payment.rejectionReason
- [ ] Fix OrderDetailPage.tsx to display all three statuses correctly
- [ ] Add tests to verify status consistency
- [ ] Verify no contradictory states in database
