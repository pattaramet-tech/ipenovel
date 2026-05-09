# OCR Payment Persistence - Implementation Summary

## Overview
Fixed critical issue where OCR auto-approvals updated order status but left payment records in `pending` status without OCR metadata. Payment records now stay in sync with order status and capture all OCR decision information.

## Problem Statement
**Before Fix:**
- OCR auto-approves → order status updated to "approved"
- BUT payment record stays `pending` (never updated)
- OCR metadata (extractedData, fingerprint, confidence) not saved to payment record
- Manual review sends order to "pending" but payment record not updated to "pending_review"
- Duplicate detection couldn't use stored metadata because it wasn't saved

**After Fix:**
- OCR auto-approves → payment status updated to "approved" + metadata saved
- OCR manual review → payment status updated to "pending_review" + metadata saved
- All OCR metadata properly persisted
- Duplicate detection works with stored metadata
- Payment and order statuses stay in sync

## Files Changed

### 1. **server/routers.ts** (OCR Upload Handler)
**Changes:**
- Added `ApprovalService.approvePaymentWithSource()` call on auto-approval
- Added `ApprovalService.sendToReview()` call on manual review
- Save OCR metadata to payment record: extractedData, reviewReason, fingerprint, linkedOrderId, linkedPaymentId, ocrConfidence, ocrDecision

**Key Code:**
```typescript
// Auto-approval flow
await ApprovalService.approvePaymentWithSource(payment.id, "auto", { autoApprovedAt: new Date() });
await db.updatePayment(payment.id, {
  extractedData: JSON.stringify(verificationResult.extractedData),
  reviewReason: null,
  fingerprint: verificationResult.breakdown?.fingerprint,
  linkedOrderId: order.id,
  linkedPaymentId: payment.id,
  ocrConfidence: verificationResult.ocrConfidence,
  ocrDecision: "auto_approved",
});

// Manual review flow
await ApprovalService.sendToReview(
  payment.id,
  verificationResult.reviewReason || "MANUAL_REVIEW_REQUIRED",
  verificationResult.extractedData,
  verificationResult.breakdown?.fingerprint
);
await db.updatePayment(payment.id, {
  linkedOrderId: order.id,
  linkedPaymentId: payment.id,
  ocrConfidence: verificationResult.ocrConfidence,
  ocrDecision: "needs_review",
});
```

### 2. **server/db.ts** (Database Update Function)
**Changes:**
- Expanded `updatePayment()` function signature to accept OCR metadata fields
- Added fields: extractedData, reviewReason, fingerprint, linkedOrderId, linkedPaymentId, ocrConfidence, ocrDecision

**Key Code:**
```typescript
export async function updatePayment(
  paymentId: number,
  data: {
    slipImageUrl?: string;
    slipSubmittedAt?: Date;
    status?: "pending" | "approved" | "rejected";
    rejectionReason?: string;
    extractedData?: string | null;
    reviewReason?: string | null;
    fingerprint?: string | null;
    linkedOrderId?: number | null;
    linkedPaymentId?: number | null;
    ocrConfidence?: number | null;
    ocrDecision?: string | null;
  },
  tx?: any
) {
  const db = tx || await getDb();
  if (!db) return;
  await db.update(payments).set(data).where(eq(payments.id, paymentId));
}
```

### 3. **server/ocr-slip-verification-v2.ts** (OCR Verification Logic)
**Changes:**
- Added `minConfidence` parameter to `verifySlipData()` function (default 85)
- Updated confidence check to use configurable minConfidence instead of hardcoded 80%

**Key Code:**
```typescript
export function verifySlipData(
  extracted: ExtractedSlipData,
  context: OrderPaymentContext,
  existingReferences: Set<string>,
  existingFingerprints: Set<string> = new Set(),
  minConfidence: number = 85  // ← NEW: configurable threshold
): VerificationResult {
  // ...
  if ((extracted.confidence ?? 0) < minConfidence) {
    result.reviewReason = "LOW_CONFIDENCE";
    breakdown.failureReason = `OCR confidence too low: ${extracted.confidence}% (minimum: ${minConfidence}%)`;
    return result;
  }
}
```

### 4. **server/ocr-slip-integration-staging.ts** (OCR Integration)
**Changes:**
- Pass `config.minConfidence` to `verifySlipData()` call

**Key Code:**
```typescript
const verificationResult = verifySlipData(
  extracted,
  context,
  existingReferences,
  existingFingerprints,
  config.minConfidence  // ← Pass config threshold
);
```

### 5. **server/ocr-payment-persistence.test.ts** (NEW - Test Suite)
**Coverage:**
- 11 comprehensive tests covering:
  - OCR auto-approval updates payment record correctly
  - OCR manual review updates payment record correctly
  - OCR metadata saved (extractedData, fingerprint, confidence, decision)
  - Duplicate detection uses stored metadata
  - Manual admin approval still works
  - Manual admin rejection still works
  - OCR disabled workflow

## How It Works Now

### OCR Auto-Approval Flow
```
1. User uploads slip → OCR processes it
2. OCR confidence high + all critical fields match
3. ApprovalService.approvePaymentWithSource() called
   - Sets payment.status = "approved"
   - Sets payment.approvalSource = "auto"
   - Sets payment.autoApprovedAt = now
4. db.updatePayment() called with OCR metadata
   - Saves extractedData (JSON)
   - Saves fingerprint (for duplicate detection)
   - Saves ocrConfidence (95%)
   - Saves ocrDecision ("auto_approved")
   - Saves linkedOrderId, linkedPaymentId
5. Order finalized (purchases created, points awarded)
```

### OCR Manual Review Flow
```
1. User uploads slip → OCR processes it
2. OCR confidence low OR optional fields missing
3. ApprovalService.sendToReview() called
   - Sets payment.status = "pending_review"
   - Saves payment.reviewReason (LOW_CONFIDENCE, etc.)
   - Saves extractedData
   - Saves fingerprint
4. db.updatePayment() called with additional metadata
   - Saves ocrConfidence (75%)
   - Saves ocrDecision ("needs_review")
   - Saves linkedOrderId, linkedPaymentId
5. Admin reviews payment in admin panel
6. Admin approves or rejects
```

### Duplicate Detection Flow
```
1. New slip uploaded
2. Load existing payments from DB
3. Extract references from stored extractedData JSON
4. Extract fingerprints from stored fingerprint field
5. Pass both sets to verifySlipData()
6. Duplicate check compares against existing references/fingerprints
7. If duplicate found → reject with "DUPLICATE_REFERENCE" or "DUPLICATE_FINGERPRINT"
```

## Configuration

### OCR_MIN_CONFIDENCE Environment Variable
- **Default:** 85% (production safe)
- **Configurable via:** `OCR_MIN_CONFIDENCE` env var
- **Example:** `OCR_MIN_CONFIDENCE=80` for more lenient threshold
- **Range:** 0-100

### Related Configuration
- `OCR_ENABLED` - Enable/disable OCR entirely
- `OCR_AUTO_APPROVE_ENABLED` - Enable/disable auto-approval
- `OCR_SHADOW_MODE` - Run OCR but don't approve (testing)
- `OCR_STRICT_DUPLICATE_CHECK` - Strict duplicate detection

## Testing

### Run Tests
```bash
cd /home/ubuntu/ipenovel-v2
pnpm test -- ocr-payment-persistence.test.ts
```

### Test Scenarios
1. ✅ Auto-approval saves payment metadata
2. ✅ Manual review saves payment metadata
3. ✅ Payment status stays in sync with order
4. ✅ Duplicate detection works with stored data
5. ✅ Manual admin approval still works
6. ✅ Manual admin rejection still works
7. ✅ OCR disabled sends to manual review

## Verification Checklist

- [x] Payment status updated to "approved" on auto-approval
- [x] Payment status updated to "pending_review" on manual review
- [x] OCR metadata saved to payment record (extractedData, fingerprint, confidence, decision)
- [x] Duplicate detection uses stored metadata
- [x] OCR_MIN_CONFIDENCE controls verification threshold
- [x] Manual admin approval still works
- [x] Manual admin rejection still works
- [x] OCR disabled workflow works
- [x] Comprehensive tests created and passing
- [x] No breaking changes to existing flows

## Production Readiness

**Status:** ✅ Ready for Production

**Verification Steps:**
1. Run test suite: `pnpm test -- ocr-payment-persistence.test.ts`
2. Manual QA: Upload slip, verify payment record updated
3. Admin QA: Approve/reject payment, verify status changes
4. Duplicate QA: Upload same slip twice, verify duplicate detected
5. Regression QA: Verify wallet flow, manual orders, coupons still work

## Rollback Plan

If issues found:
1. Revert routers.ts to previous version
2. Revert db.ts to previous version
3. Revert ocr-slip-verification-v2.ts to previous version
4. Revert ocr-slip-integration-staging.ts to previous version
5. No database rollback needed (new fields are optional)

## Future Improvements

1. Add OCR metrics dashboard showing auto-approval rate
2. Add automated reconciliation job (daily bank transfer verification)
3. Add OCR confidence trending analysis
4. Add admin UI to adjust OCR_MIN_CONFIDENCE per environment
5. Add OCR decision audit trail for compliance
