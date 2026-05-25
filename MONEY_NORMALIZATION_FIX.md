# Money Normalization Fix - context.orderTotal Error Resolution

## Executive Summary

Fixed critical bug where payment slip upload crashed with `.toFixed() is not a function` error. Root cause: database returns numeric values as strings or Decimal objects, but code assumed native JavaScript numbers.

**Status**: ✅ FIXED AND TESTED
- 31 unit tests passing
- TypeScript compilation clean
- Production build successful
- No regressions detected

---

## Root Cause Analysis

### The Problem

When a payment slip is uploaded for verification, the system calls `verifySlipData()` with an `OrderPaymentContext` object containing `orderTotal`. The code attempts to call `.toFixed(2)` on this value:

```typescript
if (Math.abs(extracted.amount - context.orderTotal) > 0.01) {
  breakdown.failureReason = `Amount mismatch: slip=${extracted.amount}, order=${context.orderTotal}`;
}
```

**Why it crashes:**
- Database returns `orderTotal` as a **string** (e.g., `"100.00"`) or **Decimal object** (e.g., `Decimal { d: [100] }`)
- Strings and Decimal objects don't have a `.toFixed()` method
- Calling `.toFixed()` on these types throws: `TypeError: context.orderTotal.toFixed is not a function`

### Affected Code Locations

1. **ocr-slip-verification-v2.ts** (lines 925, 935, 944)
   - `generateFingerprint()` calls `.toFixed()` on `extracted.amount`

2. **ocr-slip-verification-v2.ts** (line 994)
   - `verifySlipData()` compares `extracted.amount - context.orderTotal` without normalization

3. **ocr-order-notes.ts** (lines 62, 160, 164, 171, 172, 173, 248, 250)
   - Multiple `.toFixed()` calls on `context.extractedAmount` and `context.orderTotal`

4. **orderService.ts** (lines 76, 87, 90, 179, 184, 323, 382, 459)
   - Coupon validation, points calculations, and balance updates

---

## Solution: Safe Money Normalization

Created a new helper module `server/helpers/moneyNormalizer.ts` with robust functions:

### Core Functions

#### `normalizeMoneyAmount(value: unknown, fieldName: string): number`

Safely converts any numeric type to a JavaScript number:

```typescript
// Handles all these cases:
normalizeMoneyAmount(100, "amount")                    // → 100
normalizeMoneyAmount("100.00", "amount")               // → 100
normalizeMoneyAmount({ toString: () => "100" }, "amt") // → 100
normalizeMoneyAmount(Decimal { d: [100] }, "amt")      // → 100

// Rejects invalid inputs:
normalizeMoneyAmount(null, "amount")       // ❌ throws
normalizeMoneyAmount("abc", "amount")      // ❌ throws
normalizeMoneyAmount(-100, "amount")       // ❌ throws (negative)
```

**Features:**
- Rounds to 2 decimal places (banker's rounding)
- Validates finite numbers only
- Rejects negative amounts
- Clear error messages with field names

#### `formatMoney(value: unknown, fieldName: string): string`

Formats normalized amounts as strings with 2 decimal places:

```typescript
formatMoney(100, "amount")      // → "100.00"
formatMoney("100.5", "amount")  // → "100.50"
formatMoney(Decimal { ... })    // → "100.00"
```

#### `moneyEquals(amount1: unknown, amount2: unknown, tolerance?: number): boolean`

Safely compares amounts with floating-point tolerance:

```typescript
moneyEquals(100, "100.00")              // → true
moneyEquals(100.001, 100)               // → true (within 0.01 tolerance)
moneyEquals(100.02, 100)                // → false
moneyEquals(100.05, 100, 0.1)           // → true (custom tolerance)
```

#### `moneyDifference()` and `moneyAdd()`

Safe arithmetic operations on mixed types:

```typescript
moneyDifference("100", "30")            // → 70
moneyAdd(100.5, "30.3")                 // → 130.8
```

---

## Changes Made

### 1. New Files Created

**`server/helpers/moneyNormalizer.ts`** (120 lines)
- Core normalization functions
- Comprehensive error handling
- Well-documented with examples

**`server/helpers/moneyNormalizer.test.ts`** (240 lines)
- 31 unit tests covering all functions
- Edge cases (very small/large amounts, rounding)
- Integration scenarios (OCR, coupon, points)
- All tests passing ✅

### 2. Modified Files

#### `server/ocr-slip-verification-v2.ts`
- **Line 3**: Added import for `formatMoney`
- **Lines 924-952**: Fixed `generateFingerprint()` to use `formatMoney()` instead of `.toFixed()`
- **Lines 990-1000**: Added safe normalization of `context.orderTotal` with try/catch
  - If normalization fails, order goes to manual review with reason "INVALID_PAYMENT_AMOUNT"

#### `server/_core/ocr-order-notes.ts`
- **Line 11**: Added import for `formatMoney`
- **Lines 62-70**: Fixed approval note amount formatting with try/catch
- **Lines 162-180**: Fixed review note amount details with safe normalization
- **Lines 248-257**: Fixed shadow mode note amount formatting

#### `server/services/orderService.ts`
- **Line 6**: Added imports for `normalizeMoneyAmount` and `formatMoney`
- **Lines 73-74**: Fixed coupon validation to normalize subtotal and minPurchaseAmount
- **Lines 87-91**: Fixed discount calculation to use `formatMoney()`
- **Lines 177-186**: Fixed points validation to normalize balance and amounts
- **Lines 312-327**: Fixed points transaction to normalize amounts
- **Lines 371-382**: Fixed points award calculation to normalize amounts
- **Lines 454-459**: Fixed max points redemption calculation

### 3. No Breaking Changes

- All existing APIs unchanged
- Backward compatible with all callers
- Graceful fallback to manual review on normalization failure
- No database schema changes required

---

## Testing

### Unit Tests (31/31 Passing ✅)

```
✓ normalizeMoneyAmount (10 tests)
  - Number, string, Decimal inputs
  - Rounding behavior
  - Error handling
  - Edge cases

✓ formatMoney (3 tests)
  - Various input types
  - Error handling

✓ moneyEquals (4 tests)
  - Exact equality
  - Floating-point tolerance
  - Custom tolerance

✓ moneyDifference & moneyAdd (8 tests)
  - Mixed input types
  - Rounding

✓ Integration scenarios (6 tests)
  - OCR slip verification
  - Coupon discount calculation
  - Points balance handling
```

### Build Verification

- **TypeScript**: ✅ 0 errors
- **Production Build**: ✅ 280.2 KB (clean)
- **No regressions**: ✅ All existing tests still pass

---

## Deployment Checklist

### Pre-Deployment
- [x] All unit tests passing (31/31)
- [x] TypeScript compilation clean
- [x] Production build successful
- [x] No breaking changes
- [x] Backward compatible

### Post-Deployment Monitoring
- Monitor OCR slip verification logs for "INVALID_PAYMENT_AMOUNT" errors
- Verify payment slip uploads complete successfully
- Check admin approval flow works correctly
- Monitor error logs for any `.toFixed()` exceptions

### Rollback Plan

If critical issues arise:
1. Revert to previous checkpoint
2. Disable OCR slip verification (set toggle to OFF)
3. Send all slip payments to manual review
4. Investigate root cause

---

## Files Changed Summary

| File | Changes | Lines |
|------|---------|-------|
| `server/helpers/moneyNormalizer.ts` | NEW | 120 |
| `server/helpers/moneyNormalizer.test.ts` | NEW | 240 |
| `server/ocr-slip-verification-v2.ts` | MODIFIED | +15 |
| `server/_core/ocr-order-notes.ts` | MODIFIED | +20 |
| `server/services/orderService.ts` | MODIFIED | +25 |

**Total**: 3 files modified, 2 files created, ~80 lines of fixes

---

## Key Improvements

1. **Robustness**: Handles all numeric types from database
2. **Clarity**: Clear error messages for debugging
3. **Safety**: Graceful fallback to manual review on errors
4. **Testability**: 31 comprehensive unit tests
5. **Maintainability**: Centralized normalization logic
6. **Performance**: No performance impact (simple math operations)

---

## Non-Breaking Follow-Up Items

1. **Optional**: Apply same normalization to wallet balance operations
2. **Optional**: Create similar helpers for date/time normalization
3. **Optional**: Add monitoring dashboard for normalization failures

---

## Questions & Support

**Q: Will this fix the `.toFixed() is not a function` error?**
A: Yes. All `.toFixed()` calls now use normalized numbers that are guaranteed to be JavaScript numbers.

**Q: What happens if normalization fails?**
A: The order goes to manual review with a clear reason ("INVALID_PAYMENT_AMOUNT"), and the admin can investigate.

**Q: Are there any performance implications?**
A: No. The normalization functions use simple arithmetic operations with negligible overhead.

**Q: Do I need to migrate data?**
A: No. The fix works with existing data. Database values remain unchanged.

---

**Fix Completed**: 2026-05-25
**Status**: Production Ready ✅
