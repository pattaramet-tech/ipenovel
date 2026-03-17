# Order/Payment Status Synchronization Audit

## Status Fields Identified

### 1. payment.status
- **Location**: `drizzle/schema.ts` line 227
- **Possible Values**: `["pending", "approved", "rejected"]`
- **Default**: "pending"
- **Purpose**: Represents the admin's review result of a payment slip
- **Updated By**:
  - `approvePayment()` in orderService.ts → sets to "approved"
  - `rejectPayment()` in orderService.ts → sets to "rejected"
  - Payment slip upload in routers.ts line 327 → sets to "pending"

### 2. order.status
- **Location**: `drizzle/schema.ts` line 174
- **Possible Values**: `["pending", "approved", "rejected", "cancelled"]`
- **Default**: "pending"
- **Purpose**: Represents the overall order fulfillment state
- **Updated By**:
  - Order creation in orderService.ts → defaults to "pending"
  - `approvePayment()` in orderService.ts line 184 → sets to "approved"
  - `rejectPayment()` in orderService.ts line 258 → sets to "rejected"
  - Payment slip upload in routers.ts line 333 → sets to "pending"

### 3. order.paymentStatus
- **Location**: `drizzle/schema.ts` line 175
- **Possible Values**: `["unpaid", "submitted", "approved", "rejected"]`
- **Default**: "unpaid"
- **Purpose**: Represents the payment-specific state from the customer's perspective
- **Updated By**:
  - Order creation in orderService.ts → defaults to "unpaid"
  - Payment slip upload in routers.ts line 332 → sets to "submitted"
  - ❌ **NOT updated** during approval/rejection (THIS IS THE BUG!)

## Status Synchronization Issues Found

### Issue 1: Missing order.paymentStatus Update on Approval
**Location**: `server/services/orderService.ts` lines 167-200 (approvePayment function)

**Current Behavior**:
```
approvePayment():
  ✅ payment.status = "approved"
  ✅ order.status = "approved"
  ❌ order.paymentStatus = NOT UPDATED (still "submitted")
```

**Expected Behavior**:
```
approvePayment():
  ✅ payment.status = "approved"
  ✅ order.status = "approved"
  ✅ order.paymentStatus = "approved"  ← MISSING
```

**Impact**: Customer sees paymentStatus="submitted" even after admin approval, causing confusion.

### Issue 2: Missing order.paymentStatus Update on Rejection
**Location**: `server/services/orderService.ts` lines 244-260 (rejectPayment function)

**Current Behavior**:
```
rejectPayment():
  ✅ payment.status = "rejected"
  ✅ order.status = "rejected"
  ❌ order.paymentStatus = NOT UPDATED (still "submitted")
```

**Expected Behavior**:
```
rejectPayment():
  ✅ payment.status = "rejected"
  ✅ order.status = "rejected"
  ✅ order.paymentStatus = "rejected"  ← MISSING
```

**Impact**: Customer sees paymentStatus="submitted" even after rejection, causing confusion.

### Issue 3: Potential Mismatch Between order.status and order.paymentStatus
**Current Design**:
- `order.status` = overall order state (pending/approved/rejected/cancelled)
- `order.paymentStatus` = payment-specific state (unpaid/submitted/approved/rejected)

**Risk**: These two fields can become out of sync if not updated together consistently.

## Pages That Read Statuses

### Customer-Facing Pages
1. **OrdersPage.tsx** - Displays order list with status
2. **OrderDetailPage.tsx** - Displays detailed order status and payment status
3. **PaymentPage.tsx** - Displays payment status and allows slip upload

### Admin Pages
1. **AdminPaymentsPage.tsx** - Displays payment list with approval/rejection buttons
2. **AdminOrdersPage.tsx** - Displays order list with statuses

## Status Transition Rules

### Valid Transitions for order.paymentStatus
```
unpaid → submitted (when slip uploaded)
submitted → approved (when admin approves)
submitted → rejected (when admin rejects)
rejected → submitted (when customer re-uploads slip)
```

### Valid Transitions for order.status
```
pending → approved (when payment approved)
pending → rejected (when payment rejected)
pending → cancelled (if supported)
```

### Valid Transitions for payment.status
```
pending → approved (when admin approves)
pending → rejected (when admin rejects)
rejected → pending (when customer re-uploads slip)
```

## Recommended Fixes

### Fix 1: Update approvePayment() to sync order.paymentStatus
In `server/services/orderService.ts` line 184, after updating order.status, also update order.paymentStatus:

```typescript
await db.updateOrder(order.id, { 
  status: "approved",
  paymentStatus: "approved"  // ADD THIS
});
```

### Fix 2: Update rejectPayment() to sync order.paymentStatus
In `server/services/orderService.ts` line 258, after updating order.status, also update order.paymentStatus:

```typescript
await db.updateOrder(order.id, { 
  status: "rejected",
  paymentStatus: "rejected"  // ADD THIS
});
```

### Fix 3: Also store rejectionReason in rejectPayment()
In `server/services/orderService.ts` line 258, store the rejection reason:

```typescript
await db.updateOrder(order.id, { 
  status: "rejected",
  paymentStatus: "rejected",
  notes: reason  // Store rejection reason
});
```

## Testing Strategy

### Test Cases to Add
1. **Approval Flow**: Create order → Upload slip → Approve → Verify all three status fields are correct
2. **Rejection Flow**: Create order → Upload slip → Reject → Verify all three status fields are correct
3. **Re-upload Flow**: Create order → Upload slip → Reject → Re-upload slip → Verify statuses reset correctly
4. **UI Consistency**: Verify customer pages show consistent status information

## Files to Modify

1. `server/services/orderService.ts` - Fix approvePayment() and rejectPayment()
2. `server/db.ts` - Verify updateOrder() supports paymentStatus parameter
3. Tests - Add/update tests for status synchronization
