# IpeNovel Notifications — Staging-First Rollout & Rollback Plan

Status: **DRAFT / NOT AUTHORIZED FOR DEPLOYMENT**. Scope PAT-15–30 only. **Owner decision (2026-10-28): Workspace-origin notifications are OUT OF SCOPE because Workspace notification integration has not been implemented. The existing Workspace Publish workflow remains unchanged. Historical Workspace references below describe prior audits only, not an integration requirement.** Admin/Author notifications and ZIP import bulk digest remain in scope. No deployments, live DB migrations, merges, pushes, or real-data deletion are authorized by preparation of this document.

## Identity and integration prerequisites

- Isolated source baseline: `63969540e2ced9a23cb123979dcc00e12d0cbbf0`, tree `7887b52efd7e5d68bd0d86d0afae0c85deaab00f`, branch `feat/ipe-notifications-engagement`.
- Session Controls PAT-5 PR #120 is **MERGED** (2026-10-24 16:43:50 UTC; merge `6c5d9a2554d0b50b1d8f55774306cc3d6418a463`, head `e29515493deb2b8e6806abb273a0bee32e8b3b08`). Its local worktree was clean when inspected on 2026-10-25 05:06 +07; Linear PAT-5 is Done. PAT-5 exact-head PR workflow M29.3 on `e295154` passed ([run 40110429087](https://github.com/pattaramet-tech/ipenovel/actions/runs/40110429087)); local `origin/main` points to the observed merge SHA. This is not evidence that every historical global or Production gate passed. Notifications remains on old HEAD `63969540`; reconcile merged upstream and verify shared-file ownership/locks before editing `drizzle/schema.ts`, `server/routers.ts`, `client/src/App.tsx` or auth routes. Never copy uncommitted PAT-5 state.
- The current upstream PAT-5 merge contains migration `0066_reader_session_controls.sql`. A **local-only, unregistered candidate** `drizzle/0067_notifications_engagement.sql` now declares eight additive Notifications tables and seeds the single sequence row; `server/notifications/migrationContract.test.ts` statically checks table/column/index coverage. **This is NOT a DB qualification or permission to run the migration.** Reconcile with the latest main migration journal before registration, add account lifecycle classifications and disposable-DB tests, then seek Staging-first approval.
- Reconcile `accountRecoveryDataClassification`, `adminUserDeletionClassification`, and account merge/deletion inventory at exact HEAD. User-owned inbox/preferences/bulk operations cannot silently turn into `ignored` references or new merge hard blockers without policy review.
- Keep `NOTIFICATIONS_ENABLED=false`, `NOTIFICATIONS_DELIVERY_ENABLED=false`, `NOTIFICATIONS_CHECKIN_REMINDERS_ENABLED=false`, `NOTIFICATIONS_CATALOG_FANOUT_ENABLED=false` until real feature gates exist and are tested. These are **proposed names**, not existing environment variables.

## R36 direct-audience source identity hardening (2026-10-25)

- The unmounted `sqlAudienceReader.ts` now rejects direct finance, order, episode purchase and check-in event rows whose `sourceType` does not match the notification kind. Numeric business source IDs must be positive safe integers; check-in campaign keys must be bounded identifiers. Unknown direct kinds fail closed. This prevents a malformed stored row from being presented as a different financial/business outcome.
- Added a targeted negative matrix in `sqlAudienceReader.test.ts` (six malformed source combinations) and one valid wallet-topup control. Exact-source focused Vitest **118/118 PASS** (17 files; task `a8cc6cde-cec5-4aa0-b6d6-a06ee53ae912`) and TypeScript **PASS** (task `9a8ce95e-5ea2-4106-8f4f-acbed075fe82`). This is **isolated defense in depth**, not proof that the upstream business producer or DB write path is integrated.
- PAT-5 PR #120 remains merged and its local worktree clean; Notifications branch remains four commits behind `main`. No shared PAT-5 file, migration journal, runtime route, live DB or deployment was changed.

## R34 isolated delivery and audience qualification (2026-10-25)

- Added **unmounted** `server/notifications/sqlDeliveryStore.ts`: MySQL 8 `FOR UPDATE SKIP LOCKED` claim, random lease token, fenced completion/retry/dead-letter, transactional recipient insert and shared `notificationSequence` lock with bulk high-water operations. Existing recipient tombstones are never revived; unsafe sequence values and mismatched targeted recipients fail closed.
- Added **unmounted** `server/notifications/sqlAudienceReader.ts`: bounded ascending user-ID pages, current preference and wishlist membership checks, publication timestamp cutover, author/owner exclusion and no promotion of withdrawn novels. Catalog fanout and check-in categories remain separately disabled by default at the SQL claim/read/insert boundary.
- Added **unmounted** `server/notifications/runtimeGate.ts`: explicit-string feature gates default OFF, local overlapping-tick guard and error-safe release. This does **not** install a timer, register routes, connect to a DB or enable any notification delivery. A future integration must pass both category gates into the SQL store; setting master/delivery flags alone is insufficient for catalog/check-in fanout.
- Repaired `audiencePolicy.ts`: a user who opts out and later opts back in after an event cannot receive that older event on a delayed retry, even for default-on categories.
- MySQL 8.0.46 disposable `ipenovel-notifications-qual-r33`, still `--network none` / no published ports: two concurrent sessions verified `SKIP LOCKED` returns no claimed row while another transaction holds its row lock, and the row reappears after rollback. Fenced update with a wrong token affected **0** rows; the matching token affected **1** inside a rollback-only transaction; original outbox remained `pending`. Container stopped afterward. These prove SQL primitives, **not** that the new TypeScript adapter has passed a real DB end-to-end test.
- Exact R34 local focused tests **117/117 PASS** (17 files; Vitest task `9bd39d7c-ffeb-4d6e-8e57-2730a8c9060e`), TypeScript `tsc --noEmit` **PASS** (task `2a04f746-6c0a-41c6-9194-ccb2f0fe6897`), and tracked `git diff --check` **PASS** (task `884317be-5699-42be-bba7-7868cb0c025b`; line-ending warnings only). Added a connection-free real Drizzle `.toSQL()` assertion that renders the MySQL8 `FOR UPDATE SKIP LOCKED` claim with category filter. Remaining adapter tests use mock database chains; real Node→MySQL worker concurrency, publication fanout, lifecycle and Browser remain **NOT QUALIFIED**.
- A separate loopback-only MySQL8 disposable container `ipenovel-notifications-qual-r34` was created on `127.0.0.1:3316` and verified by `SELECT VERSION()`; the attempted migration application was **blocked by tool safety checks before execution**. No SQL migration was applied in that container. It was stopped and retained; do not count this as TypeScript/DB integration qualification.
- The Notifications branch is still based on `63969540`, 4 commits behind merged PAT-5 `main` `6c5d9a2`; 36 local dirty paths are preserved with no staged diff. No branch reconciliation, commit, push, PR, merge, deployment or live migration occurred in R34.

## R33 isolated DDL smoke (2026-10-25)

- Disposable MySQL 8.0 container: `ipenovel-notifications-qual-r33` (`08f275401438...`), `--network none`, no published ports, separate `ipenovel_test` database; container **stopped**, retained for further tests. No live DB was accessed.
- Ran candidate `0067_notifications_engagement.sql` after stripping Drizzle statement-breakpoint markers **in memory only**. MySQL execution returned exit 0. Verified **8 tables**, **31 index entries**, sequence row `(1,1)`, and no historical recipients.
- Transaction rollback smoke: event+outbox rows after rollback `0/0`. Commit smoke: `1` event, `1` outbox, `1` recipient; duplicate recipient `INSERT IGNORE` did not revive a dismissed row (`1` tombstone preserved).
- Static Vitest suite **89/89 PASS** (14 files), `tsc --noEmit` PASS, `git diff --check` PASS. These prove only the isolated candidate schema and bounded contracts; **NOT** the full app migration, account lifecycle integration, worker, Browser or Staging qualification. Migration remains unregistered and all proposed feature flags remain OFF.

## Source and acceptance matrix

| Producer | Only after successful DB transition | Dedupe key |
|---|---|---|
| Wallet top-up manual/provider/OCR | First settled approval and successful wallet credit; rejection separate | `topupId + firstTransitionId + kind` |
| Manual/provider order | `orderService.approvePaymentInTx` after finalization | `orderId + firstCompletion` |
| Cart paid by wallet | **Separate** `routers.ts:walletCheckout` transaction, after debit + purchase finalization | Same `orderId + firstCompletion` |
| Single chapter wallet purchase | Unique committed debit + entitlement | `episodePurchaseId` |
| Public novel | Proven first-public creation through Admin/Author catalog; uncertain historical update/publish paths fail closed. Workspace excluded. | `novelId + firstPublicIdentity` |
| Wishlist chapter | Proven first-public episode creation via Admin/Author; future ZIP create-new digest after batch safety qualification. Workspace excluded. | `episodeId + firstPublicIdentity`; digest groups at most 50 |
| Check-in | Bangkok day, opt-in and enabled active campaign, skip checked-in user | `userId + campaignKey + BangkokDay` |

Publish/reconcile/restore/rewrite must not reissue historical first-publication notifications. Worker replay must never reapprove money or purchases or repeat Publish.

## PAT-15 source audit — read-only evidence at baseline HEAD

- `server/services/orderService.ts:333–417`: `approvePaymentInTx` holds the payment/order transaction and calls `finalizeOrderCompletion` after approval. A notification must be inserted only after successful finalization in that same `tx`; early `payment.status === "approved"` returns must not produce a new event.
- `server/routers.ts:960–1055`: `checkout.walletCheckout` creates an order, debits wallet, approves payment, finalizes purchases, and clears cart inside a **separate** `dbConnection.transaction`. This route does not call `approvePaymentInTx`; notification integration into that function alone misses wallet checkout.
- `server/db.ts:5322+`: `approveWalletTopup` uses a guarded transaction, locked top-up row and conditional affected-row winner before wallet credit. The notification producer must be after successful credit, inside that guarded transaction, and must also audit `approveWalletTopupWithOCR` at `server/db.ts:7738+` before claiming all approval paths covered.
- `server/services/episodePurchaseService.ts:160+` and `server/routers.ts:3751+`: direct reader wallet purchase is another independent producer; requires exact entitlement/debit commit review before insertion.
- `drizzle/schema.ts:674–689`: wishlist membership is a `wishlists` row keyed by user/novel; audience queries must use **novel** membership and prove membership predates the first-publication event. `drizzle/schema.ts:284` has episode `publishedAt`, but it is not by itself proof of first-ever publication across rewrite/restore.
- `server/services/accountRecoveryDataClassification.ts`, `adminUserDeletionClassification.ts` and `accountMergeInventory.ts` are reflection-tested exhaustive inventories. Adding userId/actorUserId tables without corresponding classifications and account merge/deletion query handling will fail safety gates or leave user data behind. No policy decision to ignore notification ownership has been made.

### Account lifecycle admission matrix (proposal; NOT wired)

At this baseline, `accountRecoveryDataClassification.ts` classifies every user-reference column with an exhaustive reflection test; `adminUserDeletionClassification.ts` independently does the same for hard deletion. `accountMergeInventory.ts` derives direct/indirect table membership from the recovery classification, while the actual DB query registry must be updated and tested separately. The isolated notification tables below are **not** registered in `drizzle/schema.ts` and do not yet exist in the DB.

| Notification table / column | Proposed recovery classification | Proposed hard-delete classification | Merge / query obligation |
|---|---|---|---|
| `notificationRecipients.userId` | `user_owned_hard_block` | `user_owned` | Count and block non-empty source; explicitly handle or block account merge; never revive dismissed rows |
| `notificationPreferences.userId` | `user_owned_hard_block` | `user_owned` | Reconcile per-kind preference conflicts before merge; preserve opt-in provenance |
| `notificationBulkOperations.actorUserId` | `user_owned_hard_block` | `user_owned` | Preserve immutable operation key, cutoff and result; do not re-run bulk actions after merge |
| `notificationEvents.targetUserId` | `user_owned_hard_block` (conservative until event-kind policy reviewed) | `user_owned` | Immutable event identity must not be re-keyed; block source merge until explicit audit-preserving treatment is qualified |

`notificationOutbox`, `notificationDigestEpisodes` and `notificationRecipients` are related by event/recipient IDs; `notificationPublicationMarkers` refers to public catalog entities, not user IDs. Review indirect descendants and global tables before registering them, rather than classifying them as silently ignored. `notificationSequence` is global and is not a user-owned row. For `notificationEvents.targetUserId`, finance-specific records remain protected by the original wallet/order/purchase tables; the conservative category above is a **review proposal**, not authorization to merge or erase immutable event history.

Admission requires updating both classification registries, the real account recovery/delete/merge query paths and their exhaustive tests in the **same reviewed integration**, with disposable-DB evidence. A green reflection test alone does not prove runtime query handling. No lifecycle schema or shared source file was changed in this isolated audit.

- `server/db.ts:7738–7900`: OCR top-up approval conditionally wins pending→approved before credit/ledger/log in the same transaction. `pending_review` returns before credit and must never trigger a notification. Its update is not restricted to pending status, so status alone is not proof of first credit.
- `server/services/episodePurchaseService.ts:160–455`: direct wallet purchase writes debit, ledger and `episodePurchases` in one transaction. Emit only after the entitlement insert in that same transaction; verify the inserted purchase ID from the actual driver result, because the current service return can omit it.
- `server/workspace/ipenovelPublish.provider.ts:525–571`: normal and replacement publication both set `isPublished: true`; `publishedAt` alone cannot establish first-ever publication. `server/workspace/editorialHistoricalPackRepair.service.ts:328–355` reconstructs an already-published package and must be excluded from new-publication fanout.
- `server/routers.ts:1409–1439`: `dailyCheckin.getStatus` is a public read with minimal anonymous response, while `claim` is protected. Reminder generation must separately verify opt-in, campaign state, Bangkok date and checked-in state; it must never invoke `claim`.

- `server/routers.ts:1885–1987`: admin novel create defaults `publicationStatus: "published"`; update and explicit publish both can transition to published. A first-public event must be emitted at the guarded author-owned create/novel-write transaction winner, not only the explicit publish route.
- `server/routers.ts:2019–2090` and `server/db.ts:1056–1125`: admin episode create defaults `isPublished: true`, while `publishedAt` defaults to null in `createEpisode`. Admin update can toggle `isPublished` through guarded `withCatalogEpisodeWrite`; a non-null `publishedAt` is not a valid first-publication detector. Also audit ZIP/bulk import and restore paths for non-first-publication.

- `server/routers.ts:2112–2275`: `importPackageZip` and `importMultiNovelPackageZip` default to `dryRun: true`; previews are read-only. Real imports call `packageZipImportService.importPackageRows` or `importMultiNovelPackageRows`.
- `server/services/packageZipImportService.ts:607–707,1572–1670`: real ZIP imports process rows individually. `upsert` updates existing episodes (including `isPublished`) and `create_only` inserts new episodes; parsed ZIP `isPublished` defaults to true at lines 250/1048. Neither a successful import nor `isPublished=true` alone proves first-ever public publication. For each committed row, detect durable first-public transition inside its own guarded transaction; avoid replay on content-only upserts and do not emit for dry-run, errors or existing published rows.
- `server/workspace/router.ts:1690–1830`: `bulkImportGoogleDocs` and `bulkImportEpisodeFiles` create editorial work items and import source drafts, not public catalog episodes. Their per-row success is **not** a publish event; only the later authoritative Workspace publisher can emit first-public notices.
- `server/services/adminUserDeletionClassification.ts` and `accountRecoveryDataClassification.ts` enumerate every user-referencing schema column; `accountMergeInventory.ts` derives direct/indirect owned tables from recovery classification. Notification recipient/preference/operation rows need explicit `user_owned` treatment, while immutable financial/event/audit ownership requires separate reviewed policy. `adminUserManagementService.ts:420–509` hard-delete is blocked on any user data and is not a general-purpose inbox cleanup path.
- Wishlist 51+ first-public episodes expose a partition-key collision risk if every digest uses the same `novelId/batchKey/transitionKey`. The isolated contract now assigns stable `partIndex` to each **complete immutable batch** partition and includes it in event source identity; a DB worker must prove complete-batch pagination and fixed partition size before activation.

**Qualification still pending:** live row-level first-publication transition markers for ZIP/Admin/Author only (Workspace notifications removed from scope), exhaustive account lifecycle query wiring, full event/digest partition replay on disposable DB and real transaction rollback proof. These references prove entrypoints, **not** integrated producers, successful migration or end-to-end delivery.

## Snapshot / bulk-action proof

- Reserve a monotonic per-inbox delivery sequence under the same transactional lock as recipient insertion. A bulk action's server-created high-water mark must never include a concurrently delayed insertion.
- Persist UNIQUE(`actorUserId`,`operationKey`) and immutable `kind`, `cutoffSequence`, `affected`, `completed` metadata. Retrying a committed operation returns the original result without reapplying to newer rows.
- `mark_all_read` selects self-owned unread recipients at/below cutoff, retaining rows; `delete_all` dismisses both read/unread at/below cutoff only after UI confirmation. No event/outbox/financial ledger/entitlement deletion.
- Distinguish stale client cache from server truth. Cross-tab updates invalidate list/unread/count; a network/DB error is an error, never a reported success with count zero.
- Test actor spoofing, typed errors, multi-page and multi-category ranges, 2-session races, transaction rollback and replay tombstone preservation against a **disposable identity-confirmed test DB**, not against a production DB.

## Qualification before even a Draft PR

1. Inspect exact branch HEAD, tree, base, untracked/staged files and file ownership; stop if PAT-5 active on shared paths.
2. Create full schema+data-classification migration and tests. Verify isolated disposable DB identity and migration journal; no other DB writes.
3. Prove integrated transaction rollback, idempotent replays, outbox lease contention, bounded fanout, crash recovery, opt-outs, Bangkok date boundary and recovery/merge/deletion policy.
4. Prove real authenticated API rejects pending/revoked/expired sessions, other actors, forged cursors/snapshots. Client multi-tab/unread invalidation, keyboard focus, theme/mobiles and Navbar+Reader regressions require Browser tests.
5. Run repo typecheck and build (build requires `VITE_PAYMENT_QR_IMAGE_URL`; CI uses a **test-only** fixture, never accept it as a real checkout QR). Run impacted unit/integration and full repo gate, distinguish pre-existing failures.
6. Independent review remains separate from self-review where policy requires it. Only after final raw evidence is tied to exact head/tree/diff, inspect **current** feature-branch push/PR auto-deploy triggers before any non-force feature push.
7. Draft PR must not be merged merely because CI is green. Its GitHub `pull_request` workflow can run when a PR is created; workflows in baseline `preview-regression.yml` and `production-staging-regression.yml` are dispatch-driven, but **reinspect actual current workflows and external deploy settings** because repo workflows alone cannot rule out a third-party auto-deploy.

## Staging pilot — separate Owner authorization required

1. Verify migration dry-run/scope on disposable DB and reversible deployment artifact; capture SHA, migration hashes and pre-migration schema identity.
2. Request specific Staging authorization to deploy candidate and apply any approved staging migration. Disable optional fanout/check-in and worker processing initially.
3. Expand schema, deploy inactive code, test read-only inbox/permissions; enable internal recipient outbox with a fixed allowlist, limited worker concurrency, replay and observability. Confirm no wallet/order/publish behavior changed.
4. Gradually enable financial order/topup producers, then authenticated inbox; only after verified fanout tests enable catalog/wishlist; check-in reminders opt-in last.
5. Evaluate missing/duplicate notices, stuck outbox, dead-letter counts, rate/backlog, cross-user leakage, account lifecycle and browser acceptance. Record exact Staging runtime SHA and results in Linear.
6. No Production rollout until independent gate (if required) and fresh Owner authorization.

## Emergency rollback (not an authorization to execute)

- First **disable notification producer/fanout and worker** via tested flags; keep financial, purchase, entitlement and publishing flows operating normally.
- Roll app back to an **actual observed previous deployed SHA**, not an invented version; capture current/rollback SHA and migration identity first.
- Newly added schema should be **additive**. Leave inbox/outbox data and dedupe markers untouched during app rollback; do not drop tables or delete customer state without distinct approval and recovery plan.
- On reactivation, enforce activation watermark and stable event keys; do not replay pre-cutover historical events or resurrect dismissed rows.
- If migration caused incompatibility, hold deployment, design an independently reviewed forward-fix/compatibility migration rather than executing destructive down migrations.
- Production promotion workflow `.github/workflows/production-promotion.yml` is explicitly `workflow_dispatch`, requires candidate_sha, rollback_sha and safety confirmations; this document never substitutes for those values or approvals.

## Current evidence (not full release qualification)

- Focused unit `npm run test:unit -- server/notifications client/src/components/NotificationCenter.test.ts`: 30/30 PASS, exit 0, shell task `d5cb69c8-000c-4f9d-8603-cee842751229`.
- Typecheck `npm run check`: PASS, exit 0, shell task `fb8eae9e-ec63-4a33-a4f1-72a52c60e014`.
- Local build with **test-only** repository CI QR fixture: PASS, exit 0, shell task `3bcc0a39-5e30-45eb-998a-8d8493090bfd`; warnings for optional analytics and existing duplicate toolbar case remain unqualified baseline warnings.
- 2026-10-24 05:04 +07, final focused unit `npm run test:unit -- server/notifications client/src/components/NotificationCenter.test.ts client/src/components/NotificationPreferences.test.ts`: **79/79 PASS, 13 files**, task `18bbb39e-956e-45a2-9025-fc0cbc05f4b4`, exit 0. `npm run check`: **PASS**, task `1ae96620-895e-4239-8475-2e1d1c192d55`, exit 0. New `eventOutboxStore.test.ts` negative checks cover invalid recipient, malformed insert ID and missing original on duplicate recovery. These are mocked SQL checks, not real DB rollback proof.
- 2026-10-24 05:58 +07, source audit identified ZIP `upsert`/default-published and Workspace bulk-draft distinctions; isolated digest partition identity repaired with `partIndex` plus 51-episode deterministic/replay tests. Focused **80/80 PASS / 13 files** (task `004d074e-b474-47f3-85fe-b22da2e9775c`), `npm run check` **PASS** (task `6aa5d600-931c-41da-ac29-7a0197213e36`), test-only QR build **PASS** (task `66904290-21dd-4c18-9ec3-ba9df1f5cfae`). Build warnings (analytics placeholders, duplicate toolbar case, large chunk) remain; not a full CI qualification.
- 2026-10-24 07:00 +07, isolated audience eligibility repair: opt-in-only `novel_published` and `daily_checkin_reminder` now reject missing/invalid opt-in timestamps; malformed override values fail closed. This prevents historical backfill when the DB adapter cannot prove prior consent. Focused **81/81 PASS / 13 files** (task `6b664b54-f77e-465d-925f-5088d149af41`), `npm run check` **PASS** (task `f70935bd-a8df-4005-a32d-606cb74efc89`). Source blobs: `audiencePolicy.ts` `35a604492b4c9e3e0027ade92cfece22893ac2a7`, test `43cc8c567aa108d953727f461418d07405b24e3f`. Added account lifecycle admission matrix above; proposed classifications/query work remain unimplemented.
- 2026-10-25 05:07 +07, isolated worker cursor keyset hardening: rejects malformed/backward/cyclic cursors and unordered/duplicate audience IDs before recipient writes; allows forward cursor over filtered-out users. Focused Vitest **85/85 PASS / 13 files** (task `3d548218-ab26-4eea-897b-a0b464ca785f`), TypeScript **PASS** (task `3a45cff1-7249-4783-81cb-dff6982f039d`), `git diff --check` **PASS** (task `d0303686-5fce-48b3-b11e-87e9b9e1ff4c`). Two worker tests added; still mocked-store coverage, not DB proof.
- 2026-10-25 05:10 +07, Notification Center now fails closed on authenticated list-fetch errors instead of rendering potentially stale cached rows. Added one presentation test. Latest focused Vitest **86/86 PASS / 13 files** (task `9982d476-a044-4789-a642-bfb6dcf824de`), TypeScript **PASS** (task `6f1a6c32-4654-4147-86e9-3dd25a2dd25b`), `git diff --check` **PASS** (task `b2ebc09e-4a85-4e02-aff6-002ec9e3d9e8`). Still pure/isolated UI coverage, not authenticated Browser verification.
- Schema/migrations/real API/publish hooks/outbox DB worker/Browser integration: NOT DONE, not inferred from focused tests. **No Notifications push, PR, merge or deploy.**
