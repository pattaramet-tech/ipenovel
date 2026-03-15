# Ipenovel V2 - Order/Payment/Purchase State Flow

## State Machine Overview

The system manages three interrelated state machines: **Order**, **Payment**, and **Purchase**. Understanding their lifecycle is critical for correct implementation.

---

## 1. Order State Machine

### States

```
┌─────────────────────────────────────────────────────────────────┐
│                    ORDER STATE MACHINE                          │
└─────────────────────────────────────────────────────────────────┘

                          [PENDING]
                              ↓
                    (Customer uploads slip)
                              ↓
                    ┌─────────┴─────────┐
                    ↓                   ↓
                [APPROVED]          [REJECTED]
                    ↓                   ↓
              (Access granted)   (Can retry)
```

### State Definitions

| State | Meaning | Transitions | Side Effects |
|-------|---------|-----------|--------------|
| **PENDING** | Order created, awaiting payment verification | → APPROVED, → REJECTED | Cart cleared, coupon usage incremented, points deducted |
| **APPROVED** | Payment verified, purchases granted | None (terminal) | Purchases created, points awarded, order history logged |
| **REJECTED** | Payment rejected by admin | None (terminal) | No purchases created, no points awarded, order history logged |

### Transitions

#### PENDING → APPROVED
**Trigger:** Admin clicks "Approve" on payment

**Preconditions:**
- Order status = 'pending'
- Payment status = 'pending'
- Payment has slip image

**Actions:**
1. Set order.status = 'approved'
2. Set payment.status = 'approved'
3. Set payment.approvedAt = now()
4. Set payment.approvedBy = adminUserId
5. Create Purchase records (see Purchase State Machine)
6. Award points (see Points Earning)
7. Create OrderHistory entry

**Postconditions:**
- User can access purchased episodes
- User receives points
- Order is immutable

**Idempotency:**
- If already approved, return success without duplicating purchases/points

#### PENDING → REJECTED
**Trigger:** Admin clicks "Reject" on payment with reason

**Preconditions:**
- Order status = 'pending'
- Payment status = 'pending'
- Rejection reason provided

**Actions:**
1. Set order.status = 'rejected'
2. Set payment.status = 'rejected'
3. Set payment.rejectionReason = reason
4. Set payment.rejectedAt = now()
5. Set payment.rejectedBy = adminUserId
6. Create OrderHistory entry

**Postconditions:**
- No purchases created
- No points awarded
- User can create new order to retry

**Idempotency:**
- If already rejected, return error (cannot re-reject)

---

## 2. Payment State Machine

### States

```
┌─────────────────────────────────────────────────────────────────┐
│                   PAYMENT STATE MACHINE                         │
└─────────────────────────────────────────────────────────────────┘

                          [PENDING]
                              ↓
                    (Admin reviews slip)
                              ↓
                    ┌─────────┴─────────┐
                    ↓                   ↓
                [APPROVED]          [REJECTED]
                    ↓                   ↓
              (Purchases created)  (Reason recorded)
```

### State Definitions

| State | Meaning | Slip Image | Admin Action | Next State |
|-------|---------|-----------|--------------|-----------|
| **PENDING** | Awaiting admin review | Required | Approve/Reject | APPROVED/REJECTED |
| **APPROVED** | Payment verified | Present | None | (terminal) |
| **REJECTED** | Payment rejected | Present | None | (terminal) |

### Payment Record Lifecycle

```
1. ORDER CREATION
   ├─ Payment created with status = 'pending'
   ├─ slipImageUrl = null
   ├─ approvedAt = null
   ├─ rejectionReason = null
   └─ createdAt = now()

2. SLIP UPLOAD
   ├─ Customer uploads payment slip image
   ├─ Image uploaded to S3
   ├─ Payment.slipImageUrl = S3 URL
   ├─ Payment.slipImageKey = S3 key
   └─ Payment.updatedAt = now()

3. ADMIN REVIEW
   ├─ Admin views pending payments
   ├─ Admin verifies slip matches order amount
   └─ Admin chooses: APPROVE or REJECT

4A. APPROVAL
    ├─ Payment.status = 'approved'
    ├─ Payment.approvedAt = now()
    ├─ Payment.approvedBy = adminUserId
    ├─ Payment.updatedAt = now()
    └─ (Order state updated to 'approved')

4B. REJECTION
    ├─ Payment.status = 'rejected'
    ├─ Payment.rejectionReason = "Reason text"
    ├─ Payment.rejectedAt = now()
    ├─ Payment.rejectedBy = adminUserId
    ├─ Payment.updatedAt = now()
    └─ (Order state updated to 'rejected')
```

---

## 3. Purchase State Machine (Entitlements)

### States

```
┌─────────────────────────────────────────────────────────────────┐
│                  PURCHASE STATE MACHINE                         │
└─────────────────────────────────────────────────────────────────┘

                    [GRANTED] ← Created on payment approval
                        ↓
                    (User has access)
                        ↓
                    [ACTIVE] or [EXPIRED]
                        ↓
                    (Access denied if expired)
```

### State Definitions

| State | Meaning | Access | Expiration | Notes |
|-------|---------|--------|-----------|-------|
| **GRANTED** | Purchase entitlement created | ✓ Allowed | Optional | User can access episode |
| **EXPIRED** | Expiration time passed | ✗ Denied | Mandatory | Time-limited access ended |
| **REVOKED** | Admin revoked access | ✗ Denied | N/A | Future feature |

### Purchase Record Lifecycle

```
1. PAYMENT APPROVAL
   ├─ For each OrderItem in approved order:
   │  ├─ Check if Purchase already exists (idempotency)
   │  ├─ If exists, skip (already granted)
   │  └─ If not exists, create:
   │     ├─ Purchase.userId = order.userId
   │     ├─ Purchase.episodeId = item.episodeId
   │     ├─ Purchase.orderId = order.id
   │     ├─ Purchase.purchaseType = 'paid'
   │     ├─ Purchase.grantedAt = now()
   │     ├─ Purchase.expiresAt = null (permanent)
   │     └─ Purchase.createdAt = now()
   └─ Unique constraint on (userId, episodeId) prevents duplicates

2. ACCESS CHECK
   ├─ User requests episode download/read
   ├─ System checks: SELECT * FROM purchases WHERE userId = ? AND episodeId = ?
   ├─ If found:
   │  ├─ Check if expiresAt is null or > now()
   │  ├─ If valid, grant access
   │  └─ If expired, deny access
   └─ If not found, deny access

3. FREE EPISODES
   ├─ Free episodes (isFree = true) accessible to all
   ├─ No purchase record required
   ├─ Access check: episode.isFree OR purchase exists
   └─ Future: Create purchase on first view for tracking
```

### Idempotency Protection

**Problem:** What if payment approval is called twice?

**Solution:** Unique constraint on (userId, episodeId)

```typescript
// First approval
INSERT INTO purchases (userId, episodeId, orderId, purchaseType, grantedAt)
VALUES (123, 456, 789, 'paid', now())
// Success - Purchase created

// Second approval (retry)
INSERT INTO purchases (userId, episodeId, orderId, purchaseType, grantedAt)
VALUES (123, 456, 789, 'paid', now())
// Error: Duplicate entry for key 'unique_user_episode'
// Application catches error and returns success (idempotent)
```

---

## 4. Complete Order Lifecycle Example

### Scenario: User purchases 3 episodes

```
┌──────────────────────────────────────────────────────────────────┐
│                   COMPLETE ORDER LIFECYCLE                       │
└──────────────────────────────────────────────────────────────────┘

STEP 1: SHOPPING
├─ User browses novels
├─ User adds Episode 1 to cart (฿29.99)
├─ User adds Episode 2 to cart (฿29.99)
├─ User adds Episode 3 to cart (฿39.99)
└─ Cart total: ฿99.97

STEP 2: CHECKOUT PREPARATION
├─ User applies coupon "SUMMER30" (-30%)
├─ Discount: ฿29.99
├─ Subtotal after discount: ฿69.98
├─ User redeems 50 points (฿50 discount)
├─ Final total: ฿19.98
├─ Points earned on purchase: 0 (50 points = ฿50 already deducted)
└─ Cart cleared

STEP 3: ORDER CREATION
├─ Order created:
│  ├─ orderNumber = "ORD-20260315-ABC123"
│  ├─ userId = 42
│  ├─ subtotalAmount = ฿99.97
│  ├─ discountAmount = ฿29.99
│  ├─ pointsRedeemed = 50
│  ├─ pointsDiscount = ฿50.00
│  ├─ totalAmount = ฿19.98
│  ├─ status = 'pending'
│  ├─ couponCode = "SUMMER30"
│  └─ createdAt = 2026-03-15 18:30:00
│
├─ OrderItems created:
│  ├─ Item 1: episodeId=456, originalPrice=฿29.99, finalPrice=฿20.99
│  ├─ Item 2: episodeId=457, originalPrice=฿29.99, finalPrice=฿20.99
│  └─ Item 3: episodeId=458, originalPrice=฿39.99, finalPrice=฿27.99
│
├─ Payment created:
│  ├─ orderId = 789
│  ├─ status = 'pending'
│  ├─ slipImageUrl = null
│  └─ createdAt = 2026-03-15 18:30:00
│
├─ CouponUsage recorded:
│  ├─ couponId = 1
│  ├─ orderId = 789
│  ├─ userId = 42
│  └─ usedAt = 2026-03-15 18:30:00
│
└─ PointsTransaction recorded:
   ├─ userId = 42
   ├─ transactionType = 'redeem'
   ├─ pointsAmount = -50
   ├─ description = "Redeemed for order ORD-20260315-ABC123"
   └─ createdAt = 2026-03-15 18:30:00

STEP 4: PAYMENT SUBMISSION
├─ User uploads payment slip image
├─ Image uploaded to S3: s3://bucket/payments/789-xxx-slip.jpg
├─ Payment updated:
│  ├─ slipImageUrl = "https://cdn.../payments/789-xxx-slip.jpg"
│  ├─ slipImageKey = "payments/789-xxx-slip.jpg"
│  └─ updatedAt = 2026-03-15 18:35:00
└─ Order status remains 'pending'

STEP 5: ADMIN REVIEW
├─ Admin views pending payments
├─ Admin sees:
│  ├─ Order: ORD-20260315-ABC123
│  ├─ Amount: ฿19.98
│  ├─ Items: 3 episodes
│  └─ Slip image: [thumbnail]
├─ Admin verifies slip matches amount
└─ Admin clicks "APPROVE"

STEP 6: PAYMENT APPROVAL
├─ Payment updated:
│  ├─ status = 'approved'
│  ├─ approvedAt = 2026-03-15 18:40:00
│  ├─ approvedBy = 1 (admin user ID)
│  └─ updatedAt = 2026-03-15 18:40:00
│
├─ Order updated:
│  ├─ status = 'approved'
│  └─ updatedAt = 2026-03-15 18:40:00
│
├─ Purchases created (3 records):
│  ├─ Purchase 1: userId=42, episodeId=456, orderId=789, purchaseType='paid', grantedAt=2026-03-15 18:40:00
│  ├─ Purchase 2: userId=42, episodeId=457, orderId=789, purchaseType='paid', grantedAt=2026-03-15 18:40:00
│  └─ Purchase 3: userId=42, episodeId=458, orderId=789, purchaseType='paid', grantedAt=2026-03-15 18:40:00
│
├─ Points earned:
│  ├─ Points = floor(19.98 / 100) = 0 points
│  ├─ PointsTransaction: userId=42, transactionType='earn', pointsAmount=0
│  └─ (No points earned because final amount is < ฿100)
│
└─ OrderHistory entry created:
   ├─ orderId = 789
   ├─ action = 'approved'
   ├─ performedBy = 1
   └─ createdAt = 2026-03-15 18:40:00

STEP 7: USER ACCESS
├─ User views "My Novels"
├─ System queries purchases for user 42
├─ Returns 3 episodes with download buttons
├─ User clicks "Download Episode 1"
├─ System generates pre-signed S3 URL
├─ User downloads file
└─ Access granted ✓
```

---

## 5. Idempotency Scenarios

### Scenario A: Duplicate Payment Approval

```
Timeline:
├─ T1: Admin clicks "Approve" on payment 789
├─ T2: System creates purchases and awards points
├─ T3: Network delay, admin clicks "Approve" again (retry)
├─ T4: System attempts to create purchases again
│
├─ T4 Execution:
│  ├─ INSERT INTO purchases (userId=42, episodeId=456, ...)
│  ├─ Error: Duplicate entry for key 'unique_user_episode'
│  ├─ Application catches error
│  ├─ Returns success (idempotent)
│  └─ No duplicate purchases created
│
└─ Result: ✓ Idempotent - Safe to retry
```

### Scenario B: Duplicate Points Earning

```
Timeline:
├─ T1: Payment approval creates PointsTransaction
├─ T2: Admin retries approval (network retry)
├─ T3: System attempts to create PointsTransaction again
│
├─ T3 Execution:
│  ├─ Check if PointsTransaction already exists for this order
│  ├─ If exists, skip (idempotent)
│  ├─ If not exists, create new
│  └─ Application returns success
│
└─ Result: ✓ Idempotent - Safe to retry
```

### Scenario C: Cart Item Already Purchased

```
Timeline:
├─ User adds Episode 1 to cart
├─ User purchases Episode 1 (order approved)
├─ User tries to add Episode 1 to cart again
│
├─ Execution:
│  ├─ System checks: SELECT * FROM purchases WHERE userId=42 AND episodeId=456
│  ├─ Purchase found
│  ├─ Return error: "Episode already purchased"
│  └─ Prevent duplicate purchase
│
└─ Result: ✓ Business rule enforced
```

---

## 6. State Transition Validation

### Order State Transitions

```typescript
// Valid transitions
const validTransitions = {
  'pending': ['approved', 'rejected'],
  'approved': [],  // Terminal state
  'rejected': []   // Terminal state
};

// Validation logic
function canTransition(currentState: string, newState: string): boolean {
  return validTransitions[currentState]?.includes(newState) ?? false;
}

// Examples
canTransition('pending', 'approved')   // ✓ true
canTransition('pending', 'rejected')   // ✓ true
canTransition('approved', 'rejected')  // ✗ false
canTransition('rejected', 'pending')   // ✗ false
```

### Payment State Transitions

```typescript
const validTransitions = {
  'pending': ['approved', 'rejected'],
  'approved': [],  // Terminal state
  'rejected': []   // Terminal state
};
```

### Purchase State Transitions

```typescript
const validTransitions = {
  'granted': ['expired', 'revoked'],  // Future: support revocation
  'expired': [],   // Terminal state
  'revoked': []    // Terminal state
};
```

---

## 7. Concurrency & Race Conditions

### Race Condition 1: Simultaneous Approvals

**Scenario:** Admin A and Admin B both approve same payment simultaneously

**Prevention:**
```sql
-- Payment status is checked before update
UPDATE payments 
SET status = 'approved', approvedAt = now(), approvedBy = ?
WHERE id = ? AND status = 'pending'
LIMIT 1;

-- If status is not 'pending', update fails
-- Only one admin's update succeeds
```

### Race Condition 2: Duplicate Purchase Creation

**Scenario:** Payment approval and user view both try to create purchase

**Prevention:**
```sql
-- Unique constraint on (userId, episodeId)
UNIQUE KEY unique_user_episode (userId, episodeId)

-- Only one INSERT succeeds
-- Duplicate attempt gets error, handled gracefully
```

### Race Condition 3: Cart Modification During Checkout

**Scenario:** User modifies cart while checkout is processing

**Prevention:**
```typescript
// Cart cleared immediately after order creation
// Subsequent modifications fail because cart is empty
// User must create new order if they want to add items
```

---

## 8. Error Handling & Recovery

### Error: Payment Already Approved

```typescript
try {
  await approvePayment(paymentId, adminId);
} catch (error) {
  if (error.code === 'ALREADY_APPROVED') {
    // Idempotent - return success
    return { success: true, alreadyApproved: true };
  }
  throw error;
}
```

### Error: Order Not Found

```typescript
try {
  await getOrder(orderId);
} catch (error) {
  if (error.code === 'NOT_FOUND') {
    // Return 404 to user
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Order not found' });
  }
  throw error;
}
```

### Error: Coupon Expired

```typescript
try {
  await validateCoupon(couponCode, subtotal);
} catch (error) {
  if (error.code === 'COUPON_EXPIRED') {
    // Return user-friendly error
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Coupon has expired' });
  }
  throw error;
}
```

---

## 9. Audit Trail

All state changes logged in `orderHistory`:

```
Order 789 Timeline:
├─ 2026-03-15 18:30:00 - created (system)
├─ 2026-03-15 18:35:00 - slip_uploaded (system)
├─ 2026-03-15 18:40:00 - approved (admin_id=1)
└─ Details: { approvedBy: 1, purchasesCreated: 3, pointsAwarded: 0 }
```

---

## 10. State Diagram (Complete)

```
┌─────────────────────────────────────────────────────────────────┐
│              COMPLETE STATE MACHINE DIAGRAM                     │
└─────────────────────────────────────────────────────────────────┘

USER FLOW:
  Browse → Add to Cart → Checkout → Upload Slip → Wait for Approval

ORDER STATE:
  [PENDING] ──(admin approve)──→ [APPROVED] ──→ Purchases Created
     ↑                                           Points Awarded
     └──(admin reject)──→ [REJECTED] ──→ No Purchases
                                         No Points

PAYMENT STATE:
  [PENDING] ──(slip upload)──→ [PENDING] ──(admin review)──→ [APPROVED/REJECTED]
     ↑                                                              ↓
     └─────────────────────────────────────────────────────────────┘
                    (Admin can view slip)

PURCHASE STATE:
  [GRANTED] ──(on order approval)──→ User has access
     ↓
  [ACTIVE] (if not expired)
     ↓
  [EXPIRED] (if expiresAt < now)
     ↓
  Access denied

POINTS STATE:
  [EARNED] ──(on order approval)──→ Added to balance
     ↓
  [REDEEMABLE] ──(user redeems)──→ [SPENT]
     ↓
  Discount applied to next order
```
