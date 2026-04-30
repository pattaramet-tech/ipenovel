# OCR Auto-Approve System - Staging Rollout Guide

## Overview

This document provides a comprehensive guide for deploying the OCR Auto-Approve system to staging for 1-2 weeks of real-world testing with actual Thai payment slips. The rollout prioritizes fraud prevention and observability while maintaining safe, controlled testing.

---

## Architecture

### Components

**Configuration Layer** (`server/_core/ocr-config.ts`)

- Centralized OCR environment flags

- Production-safe defaults

- Staging-specific overrides

**Metrics Layer** (`server/_core/ocr-metrics.ts`)

- In-memory metrics tracking

- 11 event types (processing, extraction, approval, failures, confidence, banks)

- Metrics summary generation for admin dashboard

**Integration Layer** (`server/ocr-slip-integration-staging.ts`)

- Shadow mode support (OCR runs but doesn't approve)

- Metrics recording at each decision point

- Configurable thresholds

- Detailed logging option

**Admin API** (`server/routers/ocrMetricsRouter.ts`)

- Metrics summary endpoint

- Detailed metrics endpoint

- Configuration inspection endpoint

- Metrics reset endpoint (staging only)

**Main Router** (`server/routers.ts`)

- Updated `uploadPaymentSlip` route

- Uses staging-enhanced integration

- Records OCR metadata in order history

---

## Environment Flags

### Production Defaults (Conservative)

```bash
OCR_ENABLED=true                          # OCR active
OCR_AUTO_APPROVE_ENABLED=true             # Auto-approval active
OCR_SHADOW_MODE=false                     # Real mode (not simulated)
OCR_MIN_CONFIDENCE=85                     # 85% confidence threshold
OCR_MAX_TIME_WINDOW_MINUTES=120           # 2 hours for full datetime
OCR_STRICT_DUPLICATE_CHECK=true           # Strict duplicate detection
OCR_METRICS_ENABLED=true                  # Track metrics
OCR_DETAILED_LOGGING=false                # No verbose logging
OCR_SHOW_BREAKDOWN=true                   # Show verification breakdown
OCR_SHOW_METADATA=true                    # Show OCR metadata
```

### Recommended Staging Values

**Phase 1: Shadow Mode Only (Days 1-3)**

```bash
NODE_ENV=staging
OCR_ENABLED=true
OCR_AUTO_APPROVE_ENABLED=false            # Disabled (shadow mode)
OCR_SHADOW_MODE=true                      # Simulated decisions only
OCR_MIN_CONFIDENCE=75                     # Lower threshold for testing
OCR_MAX_TIME_WINDOW_MINUTES=120
OCR_STRICT_DUPLICATE_CHECK=true
OCR_METRICS_ENABLED=true
OCR_DETAILED_LOGGING=true                 # Verbose for debugging
OCR_SHOW_BREAKDOWN=true
OCR_SHOW_METADATA=true
```

**Phase 2: Limited Real Approval (Days 4-7)**

```bash
NODE_ENV=staging
OCR_ENABLED=true
OCR_AUTO_APPROVE_ENABLED=true             # Enable real approvals
OCR_SHADOW_MODE=false                     # Real mode
OCR_MIN_CONFIDENCE=85                     # Back to production threshold
OCR_MAX_TIME_WINDOW_MINUTES=120
OCR_STRICT_DUPLICATE_CHECK=true
OCR_METRICS_ENABLED=true
OCR_DETAILED_LOGGING=false                # Reduce noise
OCR_SHOW_BREAKDOWN=true
OCR_SHOW_METADATA=true
```

**Phase 3: Full Testing (Days 8-14)**

```bash
NODE_ENV=staging
OCR_ENABLED=true
OCR_AUTO_APPROVE_ENABLED=true
OCR_SHADOW_MODE=false
OCR_MIN_CONFIDENCE=85
OCR_MAX_TIME_WINDOW_MINUTES=120
OCR_STRICT_DUPLICATE_CHECK=true
OCR_METRICS_ENABLED=true
OCR_DETAILED_LOGGING=false
OCR_SHOW_BREAKDOWN=true
OCR_SHOW_METADATA=true
```

---

## Staging Rollout Plan

### Phase 1: Shadow Mode Testing (Days 1-3)

**Goal:** Validate OCR extraction and verification logic without risking approvals

**Configuration:**

- Shadow mode enabled (OCR runs but doesn't approve)

- Lower confidence threshold (75%) to test edge cases

- Detailed logging enabled

**Activities:**

1. Upload 20-30 real Thai payment slips

1. Monitor extraction success rate

1. Review OCR confidence distribution

1. Check duplicate detection

1. Verify order history records simulated decisions

**Success Criteria:**

- Extraction success rate > 80%

- No crashes or errors

- Metrics tracking working correctly

- Admin can see OCR decisions in order history

**Go/No-Go Decision:**

- If success rate < 70%: Debug extraction issues, extend Phase 1

- If success rate > 80%: Proceed to Phase 2

---

### Phase 2: Limited Real Approval (Days 4-7)

**Goal:** Test real auto-approval with careful monitoring

**Configuration:**

- Shadow mode disabled

- Real auto-approval enabled

- Production confidence threshold (85%)

- Detailed logging disabled

**Activities:**

1. Upload 50-100 payment slips

1. Monitor auto-approval rate

1. Review failure reasons

1. Verify manual review queue

1. Check for false positives

1. Monitor duplicate detection

**Success Criteria:**

- Auto-approval rate 40-60% (reasonable balance)

- No duplicate approvals

- Failure reasons make sense

- Manual review queue has appropriate items

**Go/No-Go Decision:**

- If auto-approval rate < 30%: Thresholds too strict, adjust

- If auto-approval rate > 70%: Thresholds too loose, tighten

- If duplicates detected: Debug fingerprint logic

- If all metrics healthy: Proceed to Phase 3

---

### Phase 3: Full Testing (Days 8-14)

**Goal:** Validate system stability and gather production readiness metrics

**Configuration:**

- Production defaults

- Real auto-approval enabled

- Standard confidence threshold

**Activities:**

1. Continue normal staging traffic

1. Monitor all metrics continuously

1. Review top failure reasons

1. Verify bank detection accuracy

1. Test edge cases (old slips, unusual amounts, etc.)

1. Prepare production deployment plan

**Success Criteria:**

- Consistent auto-approval rate (40-60%)

- No crashes or errors

- Failure reasons align with business rules

- Duplicate detection working

- Metrics stable over time

**Go/No-Go Decision:**

- If all criteria met: Ready for production

- If issues found: Document and fix before production

---

## Metrics & Monitoring

### Key Metrics to Track

**Processing Metrics:**

- Total slips processed

- Successful extractions (%)

- Failed extractions (%)

**Decision Metrics:**

- Auto-approved count

- Manual review count

- Shadow-approved count (Phase 1)

**Failure Reasons (Top 5):**

- Missing amount

- Amount mismatch

- Missing transaction date

- Outside time window

- Duplicate reference

**Bank Distribution:**

- BBL (Bangkok Bank)

- KBANK (Kasikornbank)

- SCB (Siam Commercial Bank)

- PROMPTPAY (PromptPay transfers)

- Others

**Confidence Distribution:**

- Very low (0-25%)

- Low (25-50%)

- Medium (50-75%)

- High (75-85%)

- Very high (85-100%)

### Admin Dashboard Access

**Metrics Summary Endpoint:**

```
GET /api/trpc/ocrMetrics.getSummary
```

Returns:

```json
{
  "totalProcessed": 150,
  "successRate": "85.3%",
  "autoApprovalRate": "52.1%",
  "topFailureReasons": [
    { "reason": "Missing Amount", "count": 8 },
    { "reason": "Duplicate Reference", "count": 5 }
  ],
  "topBanks": [
    { "bank": "BBL", "count": 65 },
    { "bank": "KBANK", "count": 45 }
  ],
  "averageConfidence": "82.3%",
  "uptime": "72.5h"
}
```

**Detailed Metrics Endpoint:**

```
GET /api/trpc/ocrMetrics.getDetailed
```

Returns full metrics object with all counters.

**Configuration Info Endpoint:**

```
GET /api/trpc/ocrMetrics.getConfigInfo
```

Returns current configuration and which env vars are set.

---

## Admin Visibility

### Order History Records

Each slip submission now includes OCR metadata in order history:

**Real Approval:**

```
"Payment auto-approved via OCR verification (confidence: 92%, bank: BBL)"
```

**Manual Review (Shadow Mode):**

```
"Payment slip submitted for manual review (OCR shadow mode - simulated decision: approved). Reason: DUPLICATE_REFERENCE"
```

**Manual Review (Real Mode):**

```
"Payment slip submitted for manual review. Reason: LOW_CONFIDENCE"
```

### Payment Response

The `uploadPaymentSlip` endpoint now returns:

```json
{
  "success": true,
  "isAutoApproved": false,
  "isShadowMode": true,
  "reviewReason": "LOW_CONFIDENCE",
  "ocrConfidence": 72,
  "detectedBank": "BBL",
  "duplicateStatus": {
    "isDuplicateReference": false,
    "isDuplicateFingerprint": false
  }
}
```

---

## Testing Checklist

### Pre-Staging Deployment

- [ ] All 23 OCR configuration tests passing

- [ ] TypeScript compilation clean

- [ ] No console errors in dev server

- [ ] Shadow mode behavior verified

- [ ] Metrics tracking verified

- [ ] Admin endpoints responding

### Staging Deployment

- [ ] Environment flags set correctly

- [ ] Dev server running without errors

- [ ] Admin can access metrics endpoints

- [ ] Test slip upload works

- [ ] Order history records OCR metadata

- [ ] Metrics dashboard accessible

### Phase 1 Testing

- [ ] Upload 20-30 slips in shadow mode

- [ ] Verify extraction success rate > 80%

- [ ] Check metrics accumulation

- [ ] Review order history for simulated decisions

- [ ] Verify no actual approvals occurred

### Phase 2 Testing

- [ ] Upload 50-100 slips with real approval

- [ ] Monitor auto-approval rate (40-60%)

- [ ] Check for false positives

- [ ] Verify duplicate detection

- [ ] Review failure reasons

- [ ] Confirm manual review queue appropriate

### Phase 3 Testing

- [ ] Continue normal staging traffic

- [ ] Monitor metrics stability

- [ ] Test edge cases

- [ ] Prepare production deployment plan

- [ ] Document any issues found

---

## Failure Reason Reference

| Reason | Meaning | Action |
| --- | --- | --- |
| MISSING_AMOUNT | OCR couldn't extract amount | Check slip image quality |
| AMOUNT_MISMATCH | Extracted amount doesn't match order | Verify order total |
| MISSING_TRANSACTION_DATE | OCR couldn't extract date/time | Check slip image quality |
| TRANSACTION_OUTSIDE_TIME_WINDOW | Slip is older than 2 hours | Adjust time window or reject |
| MISSING_REFERENCE | No reference number found | Check slip format |
| DUPLICATE_REFERENCE | Reference already used | Prevent duplicate approvals |
| DUPLICATE_FINGERPRINT | Fingerprint already used | Prevent duplicate approvals |
| LOW_CONFIDENCE | OCR confidence < 85% | Manual review required |
| INSUFFICIENT_STRUCTURED_DATA | Missing critical fields | Check slip format |
| MERCHANT_CODE_MISMATCH | Merchant code doesn't match | Verify merchant setup |
| SHOP_NAME_MISMATCH | Shop name doesn't match | Verify shop setup |

---

## Known Limitations

1. **In-Memory Metrics:** Metrics reset on server restart. For production, consider persisting to database.

1. **Thai Bank Support:** Currently supports 9 major Thai banks. Additional banks may need configuration.

1. **Time Window:** Fixed at 2 hours for full datetime, 24 hours for date-only. May need adjustment per bank.

1. **Fingerprint Strategy:** Uses reference → bank+account → shop fallback. Some slips may not have all fields.

---

## Rollback Plan

If issues are discovered during staging:

1. **Phase 1 Issues:** Extend Phase 1, debug extraction logic

1. **Phase 2 Issues:** Revert to Phase 1, adjust thresholds

1. **Critical Issues:** Disable OCR (`OCR_ENABLED=false`), revert to manual-only approval

---

## Production Readiness Checklist

Before deploying to production:

- [ ] Staging testing completed (1-2 weeks)

- [ ] All metrics healthy

- [ ] No false positives detected

- [ ] Duplicate detection working

- [ ] Failure reasons understood

- [ ] Admin trained on OCR system

- [ ] Monitoring plan in place

- [ ] Rollback plan documented

- [ ] Performance impact acceptable

---

## Support & Debugging

### Enable Verbose Logging

```bash
OCR_DETAILED_LOGGING=true
```

Check server logs for detailed OCR decision information.

### Reset Metrics

```
POST /api/trpc/ocrMetrics.resetMetrics
```

Clears all accumulated metrics (staging only).

### Inspect Configuration

```
GET /api/trpc/ocrMetrics.getConfigInfo
```

Shows current configuration and which env vars are set.

---

## Next Steps

1. Set environment flags for Phase 1 (shadow mode)

1. Deploy to staging

1. Upload test slips and monitor metrics

1. Follow rollout plan phases

1. Document findings and prepare production deployment

---

**Document Version:** 1.0**Last Updated:** April 29, 2026**Status:** Ready for Staging Deployment

