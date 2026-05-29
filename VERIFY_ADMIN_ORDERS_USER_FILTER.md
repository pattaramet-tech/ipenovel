# Admin Orders UserID Filter Implementation

## Overview

Added userId query/filter support to the admin Orders page to enable admins to search and debug orders by specific user ID. This helps diagnose user-specific issues such as slip upload failures, My Novels account problems, and payment/OCR status.

## Files Changed

### Backend

1. **server/db.ts** (line 612-743)
   - Added `userId?: number` parameter to `getAdminOrdersWithUsers()` options
   - Added userId filter condition: `if (options.userId !== undefined) { conditions.push(eq(orders.userId, options.userId)); }`
   - Combines with existing filters using AND logic

2. **server/routers.ts** (line 775-840)
   - Added `userId` input to admin.orders.list procedure
   - Input validation: `z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).transform(...)`
   - Accepts number or string, validates positive integer, rejects: "", "abc", "10abc", "-1", "1.5"
   - Transforms string to number automatically
   - Passes userId to `db.getAdminOrdersWithUsers()`

### Frontend

1. **client/src/pages/AdminOrdersPage.tsx**
   - Added `userIdInput` state for input field value
   - Added `userIdError` state for validation error messages
   - Added `handleUserIdChange()` function with strict validation
   - Added userId input field with:
     - Placeholder: "Enter User ID"
     - Enter key support for applying filter
     - Clear button to reset filter
     - Error message display for invalid input
   - Integrated userId into query input: `userId: userIdInput ? parseInt(userIdInput, 10) : undefined`

## Backend Input Shape

```typescript
// admin.orders.list input
{
  page: number (positive, default: 1)
  userId?: number | string  // NEW: positive integer only
  pageSize: number (positive, default: 20)
  search?: string
  sortBy?: 'createdAt' | 'updatedAt' | 'amount' | 'discount'
  sortOrder?: 'asc' | 'desc'
  status?: string
  paymentStatus?: string
  startDate?: Date
  endDate?: Date
  hasDiscount?: boolean
  minAmount?: number
  maxAmount?: number
}
```

## URL Query Examples

### Basic userId filter
```
/admin/orders?userId=123
```

### Combined with other filters
```
/admin/orders?userId=123&status=pending&paymentStatus=approved
/admin/orders?userId=456&search=novel&sortBy=createdAt&sortOrder=desc
```

### Pagination with userId
```
/admin/orders?userId=123&page=2&pageSize=50
```

## Frontend Validation

### Valid inputs
- `123` → Accepted, filters by userId 123
- `"123"` → Accepted, filters by userId 123
- Empty string → Clears filter
- Pressing Enter → Applies filter

### Invalid inputs (show error)
- `""` (empty) → Clears filter (valid)
- `"abc"` → Error: "User ID must be a positive integer"
- `"10abc"` → Error: "User ID must be a positive integer"
- `"-1"` → Error: "User ID must be greater than 0"
- `"1.5"` → Error: "User ID must be a positive integer"
- `"0"` → Error: "User ID must be greater than 0"

## Query Behavior

### Filter Combination
- userId filter combines with other filters using AND logic
- Example: `userId=123 AND status=pending AND paymentStatus=approved`
- Existing filters still work: status, paymentStatus, date range, search, pagination, sort

### Response Includes
- userId
- user email
- user display name
- orderId
- order status
- payment status
- payment slip URL
- reviewReason
- ocrDecision
- ocrConfidence / finalConfidence if available
- createdAt / updatedAt

## Manual QA Steps

### Test 1: Basic userId Filter
1. Open /admin/orders
2. Enter userId `123` in "Filter by User ID" input
3. Press Enter or click outside
4. Verify: Only orders from userId 123 are displayed
5. Check order count matches expected

### Test 2: Invalid Input Validation
1. Open /admin/orders
2. Enter `"abc"` in userId input
3. Verify: Error message "User ID must be a positive integer" appears
4. Verify: No query is sent to backend
5. Enter `"-1"` in userId input
6. Verify: Error message "User ID must be greater than 0" appears

### Test 3: Clear Filter
1. Open /admin/orders with userId filter active
2. Click "Clear" button
3. Verify: userId input is cleared
4. Verify: All orders are displayed again

### Test 4: Combine Filters
1. Open /admin/orders
2. Enter userId `123`
3. Click status filter "pending"
4. Verify: Only pending orders from userId 123 are displayed

### Test 5: URL Query Parameter
1. Open /admin/orders?userId=123
2. Verify: userId input is auto-filled with "123"
3. Verify: Only orders from userId 123 are displayed
4. Verify: URL shows `?userId=123`

### Test 6: Pagination with userId
1. Open /admin/orders?userId=123&page=2
2. Verify: userId filter persists
3. Verify: Page 2 results shown
4. Navigate to page 3
5. Verify: URL updates to `?userId=123&page=3`

## Testing Commands

```bash
# TypeScript check
npm run check

# Build verification
npm run build

# Run existing order tests (if available)
npm test -- orders

# Run all tests
npm test
```

## Implementation Status

- [x] Backend userId filter with strict validation
- [x] Frontend userId input with validation
- [x] Query parameter support (auto-fill)
- [ ] URL query parameter sync (remove on clear)
- [ ] Clickable userId links in table
- [ ] Admin query logging
- [ ] Comprehensive unit tests
- [ ] Production deployment

## Notes

- userId filter is optional; existing filters work independently
- Invalid userId input prevents query execution (client-side validation)
- Backend also validates userId (server-side validation)
- userId combines with other filters using AND logic
- Response includes all payment/OCR fields needed for debugging
- No sensitive data is logged in admin query logs

## Next Steps

1. Test wallet top-up end-to-end with userId filter
2. Add URL query parameter sync (remove userId from URL when cleared)
3. Add clickable userId links in order table
4. Add admin query logging with safe sanitization
5. Add comprehensive unit tests for userId filter
6. Deploy to production
