# IPE-037: Runtime payment QR settings and recovery

Base: IPE-035 `d82ae4eb498364ae02f55eb0cf6bbe5910ae5604`.
Branch: `feat/payment-qr-settings`. Local implementation; production promotion is separate.

## Admin usage

Open **admin/settings → การชำระเงิน — QR รับเงิน**.
The initial mode is **QR รูปเดิม**. An empty static-image override keeps the existing
`VITE_PAYMENT_QR_IMAGE_URL`; its production HTTPS/CDN validation gate stays in place.

To enable amount QR, paste the decoded, verified merchant template, select
**QR ระบุยอด**, enter a change reason and save. The template must pass IPE-035
validation. Do not paste a Slip2Go secret into this field. Merchant configuration is
admin-only; it is not hardcoded in source.

During a generator outage, click **ใช้ QR เดิมทันที**. This sends only the static
mode, current revision and recovery reason, bypassing the generator and template
validation. It also ignores unsaved edits in the form. Customers using the original
QR must enter the displayed amount themselves.

If another admin has changed settings, reload latest settings before saving.
The last editor and time appear in the card.

## Runtime behavior

- `admin.settings.paymentQr.get/update` reads and writes the DB-backed
  `paymentQr.config` envelope with neutral `mode: static | generated`.
- Saves lock the singleton settings row, compare its revision, then commit the
  config and an append-only application audit entry together in the existing
  settings table. No schema migration. Audit contains actor/time/reason/mode and
  change indicators, not template data. Generic settings writes to `paymentQr.*`
  are rejected.
- Missing DB or failed audit writes cannot report a successful save.
- `paymentQr.get` is authenticated and accepts order ID, cart coupon/points
  choices, or a wallet top-up intent. It never accepts a merchant template or
  client-supplied order total.
- Order QR uses the stored amount after ownership/status checks. Cart QR reads
  a DB snapshot and shares the existing checkout pricing function without order,
  payment or cart writes. Wallet QR validates the selected decimal amount on the
  server; this is a pre-transfer intent, not a persisted top-up. The existing
  slip-first submission flow and financial approval checks remain unchanged.
- Rendering gets integer satang. A zero balance has no transfer QR.
- All three payment screens use the same component. It refreshes on mount/window
  focus and every 15 seconds while active. Admin saves invalidate the same
  client's query cache. Other clients see a switch on their next fetch; no
  restart, rebuild or redeploy is required to change a configured mode.
- A generation error displays retry/contact-admin guidance. It does not silently
  select static mode or approve payment. Failed fetches suppress retained QR data.
  If the displayed expected amount differs from the server result, hide QR and
  request a page refresh.
- The manual fallback requires the application/DB and original QR image to remain
  available. It does not repair a stopped server or unavailable static-image host.
- A cart quote is not a price reservation. Final checkout still recalculates and
  validates its current state. QR generation does not imply transfer or settlement.

## Verification

Targeted tests exercise actual settings service/router paths with in-memory DB
transaction doubles (including rollback), actual application router authorization
and generic-key protection, real QR rendering, server amount resolution and pricing
parity, and React HTML rendering for mode switches/errors/amount mismatches.
Generator and provider regression tests, typecheck, build and diff checks are
required before final verification.

Initial UI test execution exposed a missing React import under Vitest's classic
JSX transform; corrected before review. Existing static CDN safety assertions were
updated to follow the shared component while retaining the canonical-image and
production-build protections.

No production DB, live bank/provider call, transfer, push, merge or deployment is
part of this task. These local checks do not constitute a production browser or
MariaDB concurrency smoke test. User's earlier successful 1 THB scan was reported
for IPE-035 and is not a settlement test for this integration.
