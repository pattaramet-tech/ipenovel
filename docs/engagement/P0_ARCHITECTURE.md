# IpeNovel Feedback, Support & Community — P0 Foundation

**Gate:** `ENGAGEMENT_P0_FOUNDATION_REVIEW_REQUIRED`
**Baseline:** `521f2067bd302bb39936a7beeca1e87b3786a879` (merged PR #124)
**Branch:** `feat/ipe-feedback-support-community-p0`
**Mode:** local-only, isolated worktree, no commit/push/migration/deploy

## Scope and boundary

Five independent user-facing capabilities are proposed:

| Capability | Primary record | Access | P0 behavior |
|---|---|---|---|
| Feedback | `engagementFeedback` | Signed-in user creates; admin triages | Bug/suggestion/usability/other, subject and plain-text description |
| Support Ticket | `supportTickets` + `supportTicketMessages` | Owner and admin read; admin staff replies | Open/waiting_user/waiting_staff/resolved/closed |
| Content Report | `contentReports` + append-only decisions | Signed-in reporter; admin moderation | Novel/episode/comment target, reason, triage, resolution |
| Novel Comment | `novelComments` + append-only moderation audit | Published readable novel, authenticated user | Root comment or one-level reply, soft-delete/hide/restore |
| Novel Star Rating | `novelRatings` | Authenticated eligible reader | One upserted integer 1–5 per user+novel, aggregate sum/count |

"Star" means **rating**, not site points/wallet rewards. If reward points are requested later, create a separate economic ledger and transaction gates.

**P0 implemented:** strict Zod input contracts (no actor identity from the client), pure authorization and state-transition policies, pure event-intent mapper, and focused tests. No UI screens, live routes, SQL, migrations or notification transport are wired.

## Proposed table design — NOT executable DDL

Do **not** create tables or assign a final migration number until the Notifications branch's `0067_notifications_engagement.sql` has been integrated and the live migration journal reconciled.

- `engagementFeedback`: `id` PK, `userId` FK, `category`, `subject`, `message`, `status`, `clientRequestKey`, `createdAt`, `updatedAt`; unique (`userId`,`clientRequestKey`) for non-null keys, user/status/date indexes. No public listing.
- `supportTickets`: `id`, `ownerUserId`, `subject`, `category`, `status`, `assignedAdminId` nullable, `clientRequestKey`, timestamps, version; index (owner,status,updatedAt); unique owner/request key. Priority is **server-only**, not accepted from create input.
- `supportTicketMessages`: `id`, `ticketId`, `actorUserId`, `body`, `clientRequestKey`, `createdAt`; immutable, soft-redaction by staff with audit; unique (ticketId,actorUserId,clientRequestKey).
- `contentReports`: `id`, `reporterUserId`, `targetType`, `targetId`, `reason`, `details`, `status`, `clientRequestKey`, timestamps; admin queue indexes and idempotent submit. Polymorphic targets need explicit target existence/visibility checks; no direct FK implied.
- `contentReportDecisions`: immutable `id`, `reportId`, `adminUserId`, `fromStatus`, `toStatus`, `reasonCode`, `createdAt`. Admin-only; never reveal other reporters' confidential details.
- `novelComments`: `id`, `novelId`, `authorUserId`, `parentCommentId` nullable, `message`, `status`, `clientRequestKey`, timestamps and version; public query only `visible`; unique (authorUserId,clientRequestKey), index (novelId,parentCommentId,status,id). Use one reply level (parent must be a root, visible, same novel).
- `novelCommentModerationAudit`: append-only `id`, `commentId`, `actorUserId`, status before/after and reason code; never silently restore author-deleted text.
- `novelRatings`: `id`, `novelId`, `userId`, `stars` constrained 1–5, timestamps, version; UNIQUE (`userId`,`novelId`), indexed by novel. Updates replace prior stars, never add new votes. Summary from DB aggregate or transactionally maintained totals; never trust user-provided counters.

All proposed user-reference columns must receive explicit account-recovery, hard-delete, account-merge and retention classifications BEFORE migration. User-owned support and reports may require retention/pseudonymization policies and immutable audit retention; no implicit `ON DELETE CASCADE` for evidence until policy approval. Prevent ticket existence leaks, cross-user reads, self-moderation escalation, stored XSS and spam via rate limits, HTML-escaped output and bounded input.

## Auth/authorization evidence from Main

- `drizzle/schema.ts` user roles are `user | author | admin`. Authors are not automatically support/moderation admins.
- `novels.publicationStatus` is `published | archived`; `authorUserId` may be null for legacy novels.
- Reader access checks depend on existing reader entitlement logic; P0 rating gate proposes authenticated + published + readable + not suspended, **not** a client-supplied `canRead` flag.
- Future tRPC endpoints must use the established protected/authenticated procedure chain and derive identity from `ctx.user`. Both record ownership and publishing/entitlement status must be checked in the database transaction with version/fencing to close TOCTOU gaps.
- `accountRecoveryDataClassification.ts`, `adminUserDeletionClassification.ts`, account merge inventory and their reflection/runtime tests enumerate new user-owning tables; no schema may be mounted until lifecycle policy is qualified.

## Future API design (not registered)

- `feedback.create` and `feedback.myList`; `admin.feedback.list/review`
- `support.create/listMine/getMine/reply/reopen/close`; `admin.support.list/get/reply/resolve`
- `reports.create/listMine`; `admin.reports.list/review/resolve/dismiss`
- `comments.listVisible/create/deleteMine`; `admin.comments.hide/restore`
- `ratings.getSummary/getMine/upsert`

Every mutation requires authenticated identity, bounded payload, idempotency and per-user/IP/target rate limiting. Admin routes validate role independently, CSRF/session gate defaults, and immutable decision audit. Public reads must never return pending/hidden/deleted comments or private ticket/report content. Prefer cursor pagination with server-issued cursors and consistent ordering.

## Notification separation

Notifications currently lives at `feat/ipe-notifications-engagement` (local base `63969540`) with **uncommitted work**, including `drizzle/schema.ts`, `server/db.ts`, `server/routers.ts`, `drizzle/meta/_journal.json`, account lifecycle services and proposed migration `0067`.

The currently declared `shared/notificationKindCatalog.ts` supports wallet, order, publication, wishlist and check-in events — **no ticket/comment/report kinds**. P0's `server/engagement/notificationIntent.ts` is pure and inert: `ticket_staff_reply`, `report_resolved`, `comment_reply` become stable identifiers and recipient IDs only; no raw text, no delivery and no imports from Notifications. No event fires until the underlying write is **committed**, the notification consumer supports the kind, and delivery independently revalidates visibility/user/opt-in. Do not duplicate a second outbox or inbox.

## Ownership and integration gates

| Ownership | P0 | Later integration |
|---|---|---|
| `shared/engagement/*`, `server/engagement/*`, this doc | EXCLUSIVE: new files only | Review contracts before widening |
| `drizzle/schema.ts`, `drizzle/meta/_journal.json`, migrations | NO TOUCH | Allocate next unused migration after Notifications merge; disposable MySQL/MariaDB proof |
| `server/db.ts`, `server/routers.ts` | NO TOUCH | Narrow, ownership-fenced adapters and tRPC wiring |
| `server/services/accountRecoveryDataClassification.ts`, `adminUserDeletionClassification.ts`, merge inventory | NO TOUCH | Explicit per-column and runtime lifecycle qualification |
| `shared/notificationKindCatalog.ts`, `server/notifications/*` | NO TOUCH | After Notifications merges: event kinds, opt-in defaults, recipient checks, dedupe and anti-spam |
| `client/src/*` existing pages | NO TOUCH | Separate UI slices for support portal, moderation queue and novel comments/ratings |

### Next gates

1. Independent P0 review: focused Vitest, TypeScript check, scope and clean baseline tests, no shared-file changes.
2. Product moderation and retention decisions: ticket visibility/audit, report triage, rating eligibility, comment edits and appeals, customer support SLAs.
3. API/DB integration admission: resolve Notifications' 0067 migration, main drift, all lifecycle/reflection tests; create fresh isolated candidate; disposable DB and authorization races.
4. Client/UI acceptance: author/admin permissions, mobile comments and reader UI, accessibility, anti-spam, moderation and data privacy.
5. Separate PR/Exact-Head CI and **manual** staging; production only after user acceptance and explicit approval.

## Deliberate limitations

Pure policy functions accept DB-derived state; they **do not prove** the state is authentic. Client input cannot set user/admin identity, public data must be escaped when rendered, and these tests do not establish an operational feature. There is no migration/deploy authorization in this document.
