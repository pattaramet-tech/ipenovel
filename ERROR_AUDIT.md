# Customer-Facing Error Handling Audit

## BAD_REQUEST Errors Found (No Messages)

### Cart Operations (routers.ts)

1. **Line 196: Already Purchased Episode**
   - Endpoint: `cart.add`
   - Issue: Returns `BAD_REQUEST` without message
   - Should be: "This episode has already been purchased"
   - Correct code: `BAD_REQUEST`

2. **Line 201: Free Episode Added to Cart**
   - Endpoint: `cart.add`
   - Issue: Returns `BAD_REQUEST` without message
   - Should be: "Free episodes cannot be added to cart"
   - Correct code: `BAD_REQUEST`

3. **Line 211: Episode Already in Cart**
   - Endpoint: `cart.add`
   - Issue: Returns `BAD_REQUEST` without message
   - Should be: "This episode is already in your cart"
   - Correct code: `CONFLICT` (better than BAD_REQUEST)

### Checkout Operations (routers.ts)

4. **Line 251: Coupon Validation Error**
   - Endpoint: `checkout.create`
   - Issue: Has message (good!)
   - Status: ✅ Already fixed

5. **Line 268: Empty Cart**
   - Endpoint: `checkout.create`
   - Issue: Returns `BAD_REQUEST` without message
   - Should be: "Your cart is empty"
   - Correct code: `BAD_REQUEST`

6. **Line 280: Checkout Validation Error**
   - Endpoint: `checkout.create`
   - Issue: Has message (good!)
   - Status: ✅ Already fixed

### Payment Operations (routers.ts)

7. **Line 335: Payment Slip Required**
   - Endpoint: `payments.upload`
   - Issue: Has message (good!)
   - Status: ✅ Already fixed

### Wishlist Operations (routers.ts)

8. **Line 474: Wishlist Validation Error**
   - Endpoint: `wishlist.toggle`
   - Issue: Returns `BAD_REQUEST` without message
   - Should be: "Cannot add this item to wishlist"
   - Correct code: `BAD_REQUEST`

### Admin Payment Operations (routers.ts)

9. **Line 551: Admin Payment Approval Error**
   - Endpoint: `admin.payments.approve`
   - Issue: Returns `BAD_REQUEST` without message
   - Should be: "Payment approval failed"
   - Correct code: `BAD_REQUEST`

10. **Line 562: Admin Payment Rejection Error**
    - Endpoint: `admin.payments.reject`
    - Issue: Returns `BAD_REQUEST` without message
    - Should be: "Payment rejection failed"
    - Correct code: `BAD_REQUEST`

## Error Handling Improvements Needed

### Frontend Error Display
- Most pages don't show error messages to users
- Generic "Something went wrong" messages
- No context about which action failed

### Backend Logging
- No structured logging of errors
- Cannot trace which procedure failed
- Cannot see user context or input summary

### Error Codes
- Some errors use wrong codes (BAD_REQUEST instead of CONFLICT, NOT_FOUND, etc.)
- Inconsistent error handling across endpoints

## Files to Fix
1. `server/routers.ts` - Add error messages to all BAD_REQUEST throws
2. `server/services/orderService.ts` - Add error messages
3. `server/db.ts` - Add error messages
4. `server/_core/errorHandler.ts` - Add structured logging
5. `client/src/pages/*.tsx` - Add error display UI
6. `client/src/lib/trpc.ts` - Add error handler hook

## Testing Plan
1. Test cart.add with already purchased episode
2. Test cart.add with free episode
3. Test cart.add with duplicate episode
4. Test checkout.create with empty cart
5. Test checkout.create with invalid coupon
6. Test payments.upload without slip
7. Test wishlist.toggle with invalid episode
8. Test admin payment approval/rejection
