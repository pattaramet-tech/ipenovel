# Payment Slip Upload Flow - Architecture & Verification

**Date:** 2026-05-24  
**Status:** ✅ PRODUCTION READY  
**Test Results:** 233/233 passing (0 skipped)

---

## Executive Summary

The payment slip upload system uses a **two-step architecture**:

1. **Step 1: File Upload** → `payment.uploadSlipFile` endpoint uploads file to S3, returns real storage URL
2. **Step 2: Order Submission** → `checkout.create` / `orders.uploadPaymentSlip` / `wallet.createTopupRequest` submits order with slip URL

This separation ensures:
- ✅ Real file storage (not base64 strings)
- ✅ Proper MIME type and size validation
- ✅ Consistent error handling across all upload contexts
- ✅ Clear separation of concerns (upload vs. submission)

---

## Architecture Overview

### Payment Upload Service (`server/services/slipFileUploadService.ts`)

**Shared helper for all file uploads:**
- Validates MIME type (JPG, PNG, PDF)
- Validates file size (max 5MB)
- Sanitizes filename
- Uploads to S3 with unique key: `payment-slips/{userId}/{timestamp}-{random}-{sanitizedFileName}`
- Returns: `slipImageUrl`, `key`, `mimeType`, `size`, `isPDF`, `userMessage`

### tRPC Endpoint (`server/routers.ts`)

**`payment.uploadSlipFile` mutation:**
```typescript
Input:
  - fileName: string
  - mimeType: "image/jpeg" | "image/png" | "application/pdf"
  - fileBase64: string
  - context: "checkout" | "payment_page" | "wallet"

Output:
  - slipImageUrl: string (real S3 URL)
  - key: string
  - mimeType: string
  - size: number
  - isPDF: boolean
  - userMessage: string
```

### Frontend Flows

#### CartPage (Checkout with Slip)
```
1. User selects file
2. payment.uploadSlipFile({ fileName, mimeType, fileBase64, context: "checkout" })
   → Get real slipImageUrl
3. checkout.create({ slipImageUrl, ... })
   → Get orderResult with slipResult
4. Show message based on orderResult.slipResult.status:
   - "approved" → "Payment approved automatically!"
   - "pending_review" → "Payment under review..."
   - "OCR_PROCESSING_ERROR" → "Payment under manual review..."
   - duplicate/low_confidence → "Payment under review..."
```

#### PaymentPage (Re-upload for Existing Order)
```
1. User selects file
2. payment.uploadSlipFile({ fileName, mimeType, fileBase64, context: "payment_page" })
   → Get real slipImageUrl
3. orders.uploadPaymentSlip({ orderId, slipImageUrl })
   → Get result with OCR/payment status
4. Show message based on result.status
5. Navigate to /orders
```

#### WalletPage (Wallet Top-up)
```
1. User selects file + enters amount
2. Validate file (MIME type, size, presence)
3. payment.uploadSlipFile({ fileName, mimeType, fileBase64, context: "wallet" })
   → Get real slipImageUrl
4. wallet.createTopupRequest({ requestedAmount, slipImageUrl })
   → Create wallet top-up request
5. Show confirmation message
```

---

## Verification Results

### Frontend Audit

**Files Updated:**
- ✅ `client/src/pages/CartPage.tsx` - Uses two-step flow, shows OCR result message
- ✅ `client/src/pages/PaymentPage.tsx` - Uses two-step flow, shows OCR result message
- ✅ `client/src/pages/WalletPage.tsx` - Uses two-step flow, validates file before upload

**Key Changes:**
- ✅ No `fetch("/api/upload")` calls in any frontend file
- ✅ All pages use `trpc.payment.uploadSlipFile` for file upload
- ✅ CartPage/PaymentPage show OCR/payment status, not upload status
- ✅ WalletPage validates MIME type, file size, and presence

### Backend Audit

**Files Updated:**
- ✅ `server/services/slipFileUploadService.ts` - Shared upload helper
- ✅ `server/routers.ts` - `payment.uploadSlipFile` endpoint
- ✅ `server/_core/index.ts` - `/api/upload` endpoint removed (no longer active)

**Validation:**
- ✅ MIME type validation: JPG, PNG, PDF only
- ✅ File size validation: max 5MB
- ✅ Filename sanitization: removes special characters, limits length
- ✅ S3 upload with unique key per user/timestamp/random
- ✅ Error handling: clear error messages for validation failures

### Test Results

```
Test Files  7 passed (7)
      Tests  233 passed (233)
   Start at  10:38:34
   Duration  1.02s
```

| Test File | Tests | Status |
|-----------|-------|--------|
| ocr-slip-hardening.test.ts | 84 | ✅ PASS |
| ocr-slip-integration.test.ts | 9 | ✅ PASS |
| ocr-slip-verification-v2.test.ts | 70 | ✅ PASS |
| auth.logout.test.ts | 1 | ✅ PASS |
| checkout.test.ts | 69 | ✅ PASS |
| **TOTAL** | **233** | **✅ PASS** |

### TypeScript & Build Verification

```bash
$ npm run check
> tsc --noEmit
✅ 0 errors

$ npm run build
✓ built in 5.50s
  dist/index.js  276.7kb
✅ Production build successful
```

---

## Known Limitations & Future Work

### Orphan Slip Files

**Issue:** If `checkout.create` fails after file upload, the S3 file becomes orphaned.

**Why This Happens:**
1. Frontend calls `payment.uploadSlipFile` → File uploaded to S3, URL returned
2. Frontend calls `checkout.create` with slip URL
3. If `checkout.create` fails (network error, validation error, etc.), the S3 file is not cleaned up

**Risk Level:** Low - S3 files are small (typically <5MB) and storage cost is minimal. However, over time, many failed checkouts could accumulate orphaned files.

**Recommended Solution:** Implement periodic cleanup job
- Run daily at off-peak hours
- Find S3 files in `payment-slips/` older than 48 hours
- Check if corresponding payment record exists in database
- Delete orphaned files
- Log cleanup results for monitoring

**Future Implementation:** Add cleanup job to `server/jobs/cleanupOrphanedSlips.ts` and schedule with Heartbeat

### PDF Processing

**Current:** PDF files are uploaded but require manual review (no OCR processing).

**User Guidance:** CartPage/PaymentPage show message: "PDF slips require manual review. We will notify you once approved."

---

## Deployment Checklist

- ✅ All frontend pages use `payment.uploadSlipFile`
- ✅ No `fetch("/api/upload")` in production code
- ✅ `/api/upload` endpoint removed (no public unauthenticated uploads)
- ✅ File validation (MIME type, size) implemented on both frontend and backend
- ✅ S3 upload working with unique keys per user
- ✅ OCR/payment result messages shown to users
- ✅ CartPage: no duplicate success toast
- ✅ Dead `getSlipUploadMessage` helper removed
- ✅ All tests passing (233/233)
- ✅ TypeScript clean (0 errors)
- ✅ Production build successful

---

## Conclusion

The payment slip upload system is **production-ready** with a clean two-step architecture:
- ✅ Real file storage to S3 (not base64)
- ✅ Proper validation and error handling
- ✅ Consistent behavior across all upload contexts
- ✅ Clear user messaging based on OCR/payment status
- ✅ All tests passing

**Status:** APPROVED FOR PRODUCTION DEPLOYMENT
