# P2R3B-R8A — Engagement Foundation: Classification Matrix & Decisions

**Status:** CANDIDATE (uncommitted, worktree `engagement-integration`, branch `feat/ipe-engagement-integration` @ `8ce45eb`)
**Migration candidate:** `drizzle/0068_engagement_foundation.sql` — **NOT applied to any database**
**Journal:** idx 68, tag `0068_engagement_foundation`, when 1794400000000 (after idx 67 notifications)

## Owner Decisions applied (approved in R8A work order)

1. **Central idempotency table** — `engagementIdempotencyRecords` (UNIQUE entity+userId+clientRequestKey; canonicalPayload TEXT + resultJson for replay)
2. **Transactionally maintained rating aggregate table** — `novelRatingAggregates` (novelId PK, sum, count; adjusted in the same tx as the rating row)
3. **Report visibility fail-closed (V1)** — enforced in the service layer (`targetVisibleToReporter`); no schema impact
4. **Approved rate limits only** — `rateLimitWindows` (UNIQUE scopeKey+windowStart; atomic upsert increment)
5. Notification kinds/preferences: **NOT touched** in this round (requires separate approval)
6. CI coverage: separate PR (not in this round)

## 13 tables

`engagementFeedback`, `supportTickets`, `supportTicketMessages`, `supportTicketStatusEvents`, `supportTicketMessageRedactions`, `contentReports`, `contentReportDecisions`, `novelComments`, `novelCommentModerationAudit`, `novelRatings`, `novelRatingAggregates`, `engagementIdempotencyRecords`, `rateLimitWindows`

Integrity policy: **no FOREIGN KEY, no CASCADE anywhere** (0067 additive pattern; lifecycle registries govern recovery/delete/merge). All user-referencing columns indexed. Unique keys: per-user idempotency (`userId, clientRequestKey` per domain table + central ledger `entity, userId, clientRequestKey`), `novelRatings_user_novel_uq`, `rateLimitWindows_scope_windowStart_uq`.

## Lifecycle Classification Matrix (registered in this round)

**accountRecoveryDataClassification.ts** (categories: recovery safety):

| Table.Column | Category | Rationale (summary) |
|---|---|---|
| engagementFeedback.userId | user_owned_hard_block | account's own feedback submissions |
| supportTickets.ownerUserId | user_owned_hard_block | private conversation ownership |
| supportTicketMessages.actorUserId | user_owned_hard_block | authorship of conversation content (customer requests / staff work records); never re-parented |
| contentReports.reporterUserId | user_owned_hard_block | reporter-owned confidential records |
| novelComments.authorUserId | user_owned_hard_block | public speech attribution (novels.authorUserId precedent) |
| novelRatings.userId | user_owned_hard_block | per-user opinion state feeding the aggregate |
| engagementIdempotencyRecords.userId | user_owned_hard_block | per-user retry tokens/replay results |
| supportTickets.assignedAdminId | deliberately_ignored | assignment stamp on third-party ticket |
| supportTicketStatusEvents.actorUserId | deliberately_ignored | actor stamp in append-only audit |
| supportTicketMessageRedactions.redactedByAdminUserId | deliberately_ignored | admin actor stamp in append-only audit |
| contentReportDecisions.adminUserId | deliberately_ignored | decision-maker stamp in append-only audit |
| novelCommentModerationAudit.actorUserId | deliberately_ignored | moderator actor stamp in append-only audit |

**adminUserDeletionClassification.ts** (hard-delete safety): the same 7 user-owned columns = `user_owned` (block deletion — must be pseudonymized/reparent by a future reviewed flow, never silently deleted); the same 5 actor columns = `audit_or_actor` (block deletion so who-did-what evidence survives).

## Decision Required — BLOCKED outside R8A allowlist

Registering the 7 `user_owned_hard_block` tables makes the two no-drift tests fail BY DESIGN (they exist to catch exactly this):

1. `accountRecoveryDataClassification.test.ts` → `ACCOUNT_RECOVERY_USER_OWNED_TABLE_NAMES` (server/db.ts) missing: contentReports, engagementFeedback, engagementIdempotencyRecords, novelComments, novelRatings, supportTickets, supportTicketMessages
2. `accountMergeInventory.test.ts` → `ACCOUNT_MERGE_TABLE_NAMES` (server/db.ts `ACCOUNT_MERGE_TABLE_CHECKS`) missing the same tables (they derive from the recovery classification automatically)

**Follow-up work order required:** extend allowlist to `server/db.ts` and add the corresponding recovery check-list entries + merge table checks (with conflictKeyColumns — e.g. comments have no natural per-user conflict key; ratings dedupe strategy on merge needs a decision: keep target / keep latest). Until then, these 2 failing tests are the documented, intentional blocked state of this worktree.

## DECISION REQUIRED (open, recorded — not guessed)

- **Report historical visibility** (from R1/R2): fail-closed kept; whether users may report content they saw before it was unpublished — still pending Owner decision.
- **Comments/ratings merge semantics**: with `user_owned_hard_block`, merge re-parents rows (public authorship of comments would move to the target account). The alternative is `UNSUPPORTED`-style refusal (novels precedent). Current classification follows the derived-inventory mechanism; Owner may override.
- **Retention executor**: LEGAL HOLD (unchanged).

## Verification (this round)

- Migration contract test: **5/5 PASS** (schema↔SQL tables/columns/indexes, journal sequence, no-FK/no-CASCADE DDL)
- Engagement suite: **122/122 PASS** (12 files)
- TypeScript: 0 errors · Build: PASS
- Lifecycle registry suites: recovery 13/14 (1 fail = db.ts registry, see above) · deletion 12/12 PASS · merge inventory 15/16 (1 fail = db.ts registry, same root cause)
- **No migration applied anywhere.**


## R1 (Registry Integrity Repair) — registered registries & recorded decisions

**server/db.ts registries updated (R1 allowlist extension):**

| Registry | Engagement entries |
|---|---|
| `ACCOUNT_RECOVERY_USER_OWNED_DATA_CHECKS` | +7 (feedback.userId, tickets.ownerUserId, messages.actorUserId, reports.reporterUserId, comments.authorUserId, ratings.userId, idempotency.userId) |
| `ACCOUNT_MERGE_TABLE_CHECKS` | +7 direct `user_owned` (conflict keys: feedback/tickets/reports/comments = clientRequestKey; ratings = novelId; idempotency = entity+clientRequestKey; messages = ticketId+clientRequestKey) |
| `ADMIN_USER_DELETE_CHECKS` | +12 (7 user_owned block + 5 audit_or_actor block) |

**Deliberately NOT merge-inventoried (recorded decision):** supportTicketStatusEvents / supportTicketMessageRedactions / contentReportDecisions / novelCommentModerationAudit hang off their parent entity id (which never changes on merge — merge updates only the parent's user column) and their user column is an actor stamp (deliberately_ignored in recovery). Adding them to the merge registry would break the derived-inventory no-drift contract; audit evidence stays attached to the moved parent.

**Risks recorded:**
- **Merge preview transfer_only risk:** ACCOUNT_MERGE_TABLE_CHECKS is a PREVIEW/count registry — merge EXECUTION for engagement tables is not implemented in this round. Preview may list engagement rows as transferable while no execution path moves them. Follow-up work order required before any real merge touches accounts with engagement data.
- **Merge actorUserId rewriting decision (pending):** customer-authored messages/comments/ratings re-parenting onto the target account rewrites public/conversation attribution — needs product sign-off with merge execution, per work order "ห้ามเดา Conflict Resolution".

**Schema contract hardening (R1):** engagementFeedback.category now carries the same DEFAULT 'bug' in both drizzle and SQL; migration contract extended to two-directional column-set checks + NOT NULL alignment per column + `novelRatings_stars_range_chk CHECK (stars BETWEEN 1 AND 5)` added to 0068 SQL (enforced by MySQL >= 8.0.16 / MariaDB >= 10.2; Zod contract remains primary validation on older engines).

**Lifecycle/Privacy decision (rateLimitWindows.scopeKey):** scopeKey embeds the user id shape ("feedback.create:u7") but is deliberately NOT lifecycle-registered — rows are ephemeral counters expiring with their fixed window (max 1 hour), carrying no durable user content; hard delete may leave expired-window rows that age out naturally.

**Indirect ownership (recorded):** supportTicketMessages / supportTicketStatusEvents / supportTicketMessageRedactions hang off supportTickets (classified via tickets.ownerUserId); contentReportDecisions hang off contentReports; novelCommentModerationAudit hangs off novelComments. Merge moves the parent's user column only; descendants keep their parent id. Recovery: direct actor columns registered as above.

## R2 (Final Contract & Registry Repair) — updates

- **Registry suites are GREEN**: recovery/deletion/merge-inventory suites all pass (42/42 → now 46/46 with the new no-drift tests). The R1 "db.ts registry" failures are closed by registering the 7 direct engagement tables in all three server/db.ts registries (recovery user-owned checks, merge table checks, admin hard-delete checks).
- **Changed files = 9** (5 modified + 4 new): drizzle/schema.ts, drizzle/meta/_journal.json, server/db.ts, accountRecoveryDataClassification.ts, adminUserDeletionClassification.ts, drizzle/0068_engagement_foundation.sql, server/engagement/tables.ts, server/engagement/migrationContract.test.ts, docs/engagement/R8A_CLASSIFICATION_AND_DECISIONS.md. (R2 additionally touches the allowlisted adminUserDeletionClassification.test.ts for the no-drift suite.)
- **ADMIN_USER_DELETE_CHECKS no-drift test (new)**: exported the runtime registry and added introspectable coversColumns metadata to the 12 engagement entries; the test proves table/column/category/reference mapping 1:1 against the classification (7 user_owned + 5 audit_or_actor) and that OR-grouped multi-column entries remain supported generically.
- **rateLimitWindows has NO automatic cleanup/TTL**: rows expire logically by fixed window (max 1 hour) but no executor deletes them; the lifecycle/privacy decision is PENDING (recorded above) — whether to add a TTL/cleanup task, classify, or leave until retention work.
- **Merge preview transfer_only is NOT evidence that merge execution supports engagement** — preview counts registry rows only; merge execution for engagement tables is unimplemented and requires its own work order (plus the actorUserId rewriting policy decision).
- **Comments, Ratings, and Staff-authored Messages wait for Merge Policy** before any execution is enabled: public authorship/attribution (novelComments), per-user opinion state (novelRatings) and staff-authored support conversation content (supportTicketMessages.actorUserId) must not be silently re-parented onto a merge target.
- **Migration contract R2**: SQL↔drizzle column parity is two-directional and indentation-aware; negative tests prove the contract fails on ghost SQL columns, drizzle-only columns, flipped nullability, enum drift and dropped indexes; the rating stars CHECK is recorded with its MySQL/MariaDB version limitation.

## R3 (Final Safety Proof) — verification record

- **Real results (verified R3→R4): Engagement suite 134/134 (12 files) / Registry suites 51/51 (3 files) / Total 185/185 — every exit code 0.**
- **R3 hard-delete runtime proof added:** getAdminUserDeleteAssessment() driven through an injected mock DB (the tx parameter); proves the REAL WHERE conditions for all 12 engagement references (coversColumns == captured SQL, e.g. `supportTickets`.`assignedAdminId` = ?), user-owned case -> canDelete=false, audit/actor case -> canDelete=false, empty state -> canDelete=true.
- **Migration contract completeness (R3):** DEFAULT VALUE equality (not just hasDefault) including SQL-wrapped defaultNow() normalization (now() == CURRENT_TIMESTAMP), SQL type equality per column, PRIMARY KEY definitions matched SQL-vs-drizzle, plus negative tests proving the contract fails on DEFAULT drift, SQL type drift and PRIMARY KEY drift.
- **RELEASE ORDERING RISK: deploying the application code BEFORE migration 0068 is applied will crash the lifecycle queries** (account recovery assessment, admin hard-delete assessment, merge inventory all query the engagement tables; the tables do not exist pre-0068). Migration MUST be applied before (or atomically with) any deployment that includes the engagement registries.
- **Apply prerequisites:** disposable-DB qualification (concurrency + rollback evidence) and explicit Staging approval BEFORE any production migration. No migration has been applied in this round.
- **Rate-limit cleanup and retention executor remain HOLD** (no TTL/cleanup task, no deletion flow).
- **Snapshot/Mock tests do NOT prove database concurrency/atomicity** — mock DB is in-memory; real evidence requires disposable-DB integration runs.

## R4 (Final Test Coverage & Controlled Local Commit) — updates

- **Registry Blocker from R8A/R1 is RESOLVED**: the server/db.ts recovery user-owned checks (+7), merge table checks (+7 direct) and admin hard-delete checks (+12) are registered, and ALL no-drift cross-check suites pass (recovery/deletion/merge-inventory 51/51).
- **R4 table-driven hard-delete proof added**: all 12 engagement references tested through getAdminUserDeleteAssessment() with an injected mock DB — each case simulates a hit ONLY on its own (table, column) reference by inspecting the captured WHERE SQL; every case yields canDelete=false with exactly one blocker carrying the classification's category and reference label. supportTickets.ownerUserId (user_owned) and supportTickets.assignedAdminId (audit_or_actor) verified as separate cases from the same table.
- **Verified counts: Engagement 134/134 / Registry 51/51 / Total 185/185 — all exit codes 0.**
- PENDING decisions and holds are unchanged: report historical visibility (DECISION REQUIRED), merge actorUserId rewriting policy, rateLimitWindows no automatic cleanup/TTL (lifecycle/privacy decision PENDING), rate-limit numbers beyond PD-04 (PENDING CONFIGURATION), retention executor (LEGAL HOLD), merge execution work order (required before any real merge touches engagement data).
- Migration 0068_engagement_foundation remains a CANDIDATE — not applied to any database; disposable-DB qualification and Staging approval required before any apply.
