# IPE-040 — Provider Auto Approve

Context: IPE-040-C01. Base: 6b6d54795a25ba3b0c7654d01aa761ff1c893b37.
Branch: feat/provider-auto-approve. ChatGPT implementation and same-run review.

## Behavior
- Admin Settings exposes DB-backed provider_auto_approve, default OFF, revision-checked with actor, timestamp and required reason.
- Only VERIFIED / 200200, matching amount and applied recipient checks, decoded date and transaction reference are eligible. Existing HTTP 200/201 handling is retained.
- Verification runs outside the financial transaction. Current submission, amount, terminal state and auto policy are rechecked under locks.
- Original order service grants purchases/points; original wallet service grants credited amount including bonus. Manual and automatic flows share transaction claims and account guards.
- A unique bank-transaction claim prevents reuse across orders and wallets, including approved provider snapshots predating migration.
- Failure rolls back financial effects and stores safe approval diagnostics separately from the provider verification verdict.
- Approved rows cannot be reset by late uploads/rejections. Checkout returns current payment status.
- No retroactive batch processing when the toggle is enabled. A later explicit verification follows the current setting.

## Database and Preview
Migration 0038 creates paymentProviderClaims and adds provider_auto to walletTopups.approvalSource.
Use the existing committed-migration runner (pnpm db:migrate) against the intended Preview database before exercising approval. Do not use db:push or test:db:prepare on Preview/Production.
Keep auto approval OFF initially. Configure the receiver and provider secret using the existing mechanisms.
In Preview, enable via Admin Settings with a reason; verify a fresh eligible order/top-up; confirm entitlement/credit and approval diagnostics; retry without duplicate credit; disable and confirm the next verification remains reviewable.
A failure can be contained by disabling the runtime setting. Keep the claim registry and audit records.

## Evidence and scope
Development checks: targeted unit/metadata/QR tests passed; real MariaDB 11.4.10 tests cover concurrent retries, manual/auto race, cross-subject duplicate, historical duplicate, purchases/loyalty, disabled policy, late rejection/upload and injected ledger rollback.
All database tests use the sanctioned verified ipenovel_test connection, with a disposable loopback-only Docker database. No live provider or production database calls.
A legacy approval-metadata.test.ts requires ambient DATABASE_URL and hardcoded pre-existing payment IDs; its database setup failed in the unit run. It is not counted as passing. The new integration fixtures verify manual/auto behavior on real MariaDB. admin-order-approval.test.ts now isolates its metadata-only guard double; real guards are tested separately.
Exact commit SHA, final counts, process IDs, review and Final Verify outcomes are recorded separately in AI Coding Operations TASKS/RUNS/ACTIVITY_LOG after committing this report.
No full-repository-suite or browser smoke-test claim. Production deployment, merge/main mutation and enabling production auto approval are outside this execution.
