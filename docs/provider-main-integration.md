# Provider payment integration into main history

User-approved conflict resolution on integrate/provider-payments-main only.
Parents: provider release 8b0731db00dd110f251473024231bf67f0791405 and main 7381280e600e8ae447a63f0e18da4d2af990b638.

The merge deliberately uses the reviewed Provider reconstruction for payment, schema, migration chain, account recovery adaptations, Sports Vote and Admin UI. IpeNovel Workspace documents are retained from that reconstruction. The attached JSON manifest lists each restored path and ten independent authentication paths retained from main.

Removed from the resulting runtime relative to main: Payment V2 foundations, immutable slip upload/binding gates, legacy slip claim/backfill and file identity approval dependencies. Provider transaction claims, dynamic settings, merchant QR, order numbers, 180-second order eligibility, and audited exceptional order approval remain.

Preserved independent main improvements: optional Manus URL on Google-enabled Preview, read-only routine authentication, bounded deadlock retries for Google identity linkage, associated tests.

Database scope: no live database was changed and no DROP migration is introduced. This candidate uses the existing Provider reconstruction migration lineage, not main's old V2 migration lineage. Local integration tests use the isolated Provider test schema. A database carrying the old main migration history requires separate reconciliation before deployment; do not infer compatibility from source merge success.

Next gate: Preview smoke test on the current Provider Preview database, including login, recovery, Sports Vote, checkout QR, order number, ordinary/exceptional approval and duplicate idempotency. Main and Production remain unchanged.
