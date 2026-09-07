# IPE-039: KSHOP receiver settings and provider diagnostics

Base: 7afb7a1a5a3da27e50ba45eae5e0450f83877b68.
Scope: isolated hotfix; no merge, push, deployment, production data change or live provider calls.

## Problem and evidence
The base accepts digits only in receiverAccountNumber, rejecting KB-prefixed KSHOP merchant identifiers.
A valid provider code alone does not establish that the application requested recipient verification.
At the base, HTTP 200/code 200200 with recipientCheckApplied=false produces REVIEW_REQUIRED.
HTTP other than 200 can instead produce ERROR with the retained valid code and reference.
Tests reproduce this distinction; the incident's actual HTTP status and running image remain unverified.
No evidence supports blaming the static QR or OCR; the provider service does not invoke OCR.

## Change
- Type-aware validation allows alphanumeric merchant identifiers only for type 03000; existing numeric validation remains for other account types.
- Admin Settings has a separate payment receiver form with explicit account type, number and reason.
- A single JSON settings row paymentVerification.receiverConfig atomically stores the pair, revision, actor and time.
  Existing two-key receiver settings are read in one query until an admin explicitly saves the new configuration.
- Saves lock the singleton row, reject stale revisions, and atomically append a redacted receiverAudit entry.
  Generic settings.set cannot change receiver current/legacy/audit keys.
- Image API continues to send multipart file and JSON payload containing checkDuplicate, exact amount and explicit checkReceiver.
- Diagnostics add bounded reason codes, HTTP status and check time; no raw response, sender PII, merchant ID or credential is stored by this addition.
  Admin order and wallet detail show provider diagnostics and references.
- Missing recipient configuration remains review-required; invalid settings remain fail-closed.
  Provider verification never credits a wallet or marks an order paid. Existing manual approval and auto-approval policy are unchanged.
- No Payment Approval V2, evidence V2, OCR gate, storage-identity gate, migration, or QR generator changes.

## Operator instructions after a separately approved promotion
1. In admin/settings, open the API payment receiver section.
2. For KSHOP, enter account type 03000 and the shop's verified merchant code from its original QR.
   This is not the entire QR payload, sender account, biller ID or the secret.
3. Enter a reason, save and read back. Runtime verification uses the new configuration on its next call; no restart is needed.
4. Retrying an already checked slip may return the provider's duplicate code: do not disable duplicate checks or auto-credit it.
   Reconcile the original payment with the existing manual process.
5. On failure collect reason, HTTP status, provider code/reference and check time from admin details for provider support.
   Old snapshots do not retroactively acquire HTTP diagnostics.
6. QR display settings and receiver verification settings are independent. Do not replace the merchant's static QR to fix recipient policy.
Do not promote this hotfix merely by redeploying the old SHA.

## Validation and limits
Targeted tests execute real settings service/router code over an in-memory transactional database double,
mocked image API request/response paths for order and wallet, and server-rendered admin diagnostics.
Production browser, real MariaDB concurrency, live provider and bank settlement tests are NOT RUN.
The pre-existing admin-order-approval suite has five failures (readDb.select is not a function);
the same five failures were reproduced at pristine base 7afb7a1 in a separate baseline worktree.
Approval implementation and database files are untouched.
Initial build without VITE_PAYMENT_QR_IMAGE_URL failed at the existing config gate;
build with a non-secret example QR URL passes, with existing analytics/chunk warnings.
Review and exact-HEAD final results are recorded in AI Coding Operations, not inferred from this document.

Official contract inspected: https://www.slip2go.com/guide/rest-api/image
POST /api/verify-slip/qr-image/info; multipart file; payload.checkReceiver array;
accountType 03000 for merchant accounts. No live API call was used.
