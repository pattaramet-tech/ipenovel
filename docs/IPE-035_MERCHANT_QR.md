# IPE-035 — Merchant payment QR generator

Local component on the verified P2 base `59766315a06503acb8a3383249b81bb5b54cd004`. No deployment or checkout integration.

## Contract

`server/payments/merchantQr.ts` accepts a trusted merchant template and positive integer satang. `generateMerchantQrPayload` returns Thai QR payload; `generateMerchantQr` additionally returns PNG and SVG. Merchant settings and order totals must be resolved server-side by the future checkout integration. Never accept a browser-supplied receiver or authoritative amount. No store template, bank account or provider key is hardcoded in application code.

Supported profile: printable ASCII, ordered unique TLV fields, format 01, static initiation 11, domestic PromptPay Bill Payment AID A000000677010112, 15-digit biller ID, alphanumeric references, TH/764, final uppercase CRC. Other merchant rails are preserved opaquely. Dynamic/bank-issued tokens, tips/VAT, duplicate or malformed fields and invalid CRC fail closed. This is an intentionally bounded profile, not a universal EMV validator. CRC verifies integrity, not merchant ownership or authenticity.

Only amount tag 54 and CRC change. Amounts use integer arithmetic and two decimal places, from 1 to 999999999999 satang (QR format ceiling; future order policy must impose business limits). Existing amount is replaced once. The initiation mode and all references remain unchanged. This does not provide QR expiry, single-use enforcement, order-specific bank references, payment notification or proof of payment. Slip verification and canonical transaction dedupe remain required.

## Local CLI

`pnpm exec tsx scripts/generate-merchant-qr.ts <trusted-template.txt> <integer-satang> <new-output-directory>`

Example: `pnpm exec tsx scripts/generate-merchant-qr.ts tmp/merchant-qr/template.txt 100 tmp/merchant-qr/sample-1baht`

Creates payment-qr.png and payment-qr.svg exclusively in a new directory. No network or provider API calls. Keep real input/output in ignored tmp or an approved private storage location. Synthetic committed fixtures must never be used to receive money.

## Evidence and verification

The two user-supplied K SHOP images were decoded locally, with Reed-Solomon correction and CRC verification. Their payloads differ only at amount and CRC. Adding 54041.00 to the original and recomputing CRC produces the bank-app 1 THB sample byte for byte. Actual biller, references and QR images remain outside Git; committed golden fixtures are synthetic, with CRC produced independently using Python binascii.crc_hqx.

`MERCHANT_QR_FIXTURE_FILE` optionally points tests to private JSON containing template and oneBaht. The private test is explicitly skipped when missing; final local verification requires it. No fixture content is logged on private assertion failures.

Commands:

- `pnpm exec vitest run server/payments/merchantQr.test.ts`
- `pnpm check`
- `pnpm build` with the existing non-secret build-only QR image URL prerequisite
- `git diff --check`

Tests cover CRC check vector, fixed golden equality, receiver/opaque-field preservation, replacement/idempotency, invalid amounts, malformed/duplicate templates, wrong recipient profile/currency, dynamic templates, and independent PNG/SVG decoding through jsQR (SVG rasterized with sharp). Implementation verification: 43 QR tests including the private K SHOP comparison plus 69 existing provider contract/adapter/router/runtime tests passed (112 total). Project TypeScript, separate CLI/test TypeScript, production build and diff checks passed. An initial TypeScript Buffer iteration incompatibility was corrected before the passing run. Review and final verification outcomes are recorded separately in AI Coding Operations at the exact commit.

Bank-app scanning and real payment settlement have NOT been performed. Before live integration, verify generated QR displays the expected receiver and amount in supported banking apps, then conduct an explicitly authorized end-to-end payment/slip test. Production remains on the user-reported recovery baseline; this feature branch is not a production promotion instruction.

References: https://github.com/soldair/node-qrcode ; https://github.com/cozmo/jsQR ; https://www.bot.or.th/content/dam/bot/documents/th/our-roles/payment-systems/about-payment-systems/ThaiQRCode_Payment_Standard.pdf
