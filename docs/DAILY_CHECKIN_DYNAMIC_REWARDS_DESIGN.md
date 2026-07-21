# Configurable Daily Check-in Reward System — Design Document (Phase 1)

Status: **design only — no implementation code in this commit.**
Branch: `feature/daily-checkin-dynamic-rewards`, based on `fix/daily-checkin-safe` @ `b320a3dd11f83e09b65123c357b920727f94e4f5`.

**Amendment 1** (this revision, starting commit `ba2d885b19678e084df73472029c4261f1d7fa00`):
five corrections applied before implementation begins — reward-level
coupon status (not parent-row status), a server-generated `dedupeKey` for
rule deduplication (replacing a unique index that NULLs would defeat),
strict in-memory point-balance sequencing, a `draft`/`active`/`ended`
campaign lifecycle (replacing the ambiguous `isActive` boolean), and
immutability of dates/rules/templates once a campaign has any check-in.
Eleven product decisions that were previously open are now locked (see
"Locked product decisions" below). The implementation plan is regrouped
into five major stages.

This document audits the existing hardcoded, coupon-only daily check-in
system and proposes a fully admin-configurable replacement supporting
points, coupons, streak milestones (one-time and repeating), and immutable
historical reward snapshots — without code changes for future campaigns.

---

## PART 0 — Audit of the existing implementation

### `dailyCheckins` (drizzle/schema.ts:825-851)

```
id            int PK autoincrement
userId        int not null
checkinDate   varchar(10) not null   -- "YYYY-MM-DD", Bangkok business date
campaignKey   varchar(50) not null default "default"
couponId      int not null            -- exactly one coupon, always required
status        enum("issued","used","void") default "issued" not null
issuedAt      timestamp default now() not null
usedAt        timestamp nullable
createdAt/updatedAt timestamps

UNIQUE (userId, checkinDate, campaignKey)  -- the only idempotency guard
UNIQUE (couponId)                          -- rigid 1:1 with one coupon
INDEX  (userId)
```

The hardcoded assumption this whole feature must remove: **one check-in
always produces exactly one coupon.** There is no concept of points, no
streak, no milestone, and `campaignKey` is a free-text string that is never
actually varied — every row today has `campaignKey = "default"`
(`server/db.ts:4398`, `const DAILY_CHECKIN_CAMPAIGN_KEY = "default"`).

**Amendment 1 finding**: this table's `status`/`usedAt` describe the fate of
the check-in's *one* coupon, which is exactly why keeping status here breaks
once a check-in can issue multiple coupons — redeeming one must not look
like redeeming all of them. See Correction 1 (PART A/I) below.

### `coupons` / `couponUsages` (drizzle/schema.ts:431-482)

`coupons` is a generic discount-code table (`flat`/`percentage`,
`maxDiscountAmount` cap, `minPurchaseAmount`, `maxUsageCount`/`usageCount`,
`isActive`, `expiresAt`). `maxDiscountAmount` was added specifically for
this feature in migration 0027 and is nullable everywhere else — safe
precedent for additive, nullable columns.

`couponUsages` tracks redemption per order (`unique(couponId, orderId)`).
Reward-coupon **ownership** (who is allowed to redeem which coupon, and
whether it's already been used) is *not* stored on `coupons` itself — it is
resolved by `getRewardCouponOwnership()` (`server/db.ts:1407-1433`), a
single shared lookup that currently checks two source tables in sequence:
`sportsMatchRewards` and `dailyCheckins`. **This function is the exact
extension point** the new reward-grant model must plug into — adding a
third check (`dailyCheckinRewardGrants`) instead of inventing a parallel
mechanism.

`validateAndApplyCoupon()` (`server/services/orderService.ts:27-111`) is the
single point where a coupon code becomes a discount amount at checkout. It
already handles the `maxDiscountAmount` cap and ownership/status
enforcement generically — nothing here needs to change for the new system
as long as newly-minted coupons are ordinary `coupons` rows.

### `pointsTransactions` (drizzle/schema.ts:489-512) and balance/concurrency

Points have **no running-balance column on the user** — the balance is
derived as the `balanceAfter` of the user's most recent `pointsTransactions`
row (`getUserPointsBalance`, `server/db.ts:1605-1617`, `ORDER BY createdAt
DESC LIMIT 1`). Writing a new transaction (`recordPointsTransaction`,
`server/db.ts:1619-1640`) requires the caller to have already computed the
correct new `balanceAfter` — it does no locking itself.

Concurrency safety is achieved elsewhere via a documented, reused pattern:
`lockUserForPoints(userId, tx)` (`server/db.ts:4144-4152`) issues `SELECT id
FROM users WHERE id = ? FOR UPDATE` inside the caller's transaction *before*
`getUserPointsBalance`/`recordPointsTransaction` are called — see
`castSportsVote` (`server/db.ts:4154-4199`) for the reference
implementation. **The new point-reward grants must reuse this exact
lock-then-read-then-write sequence inside the check-in's own transaction —
it must not invent a new concurrency mechanism.**

**Amendment 1 finding**: `getUserPointsBalance`'s `ORDER BY createdAt DESC
LIMIT 1` has no tie-breaker. `timestamp` columns can share the same value
across two rows inserted in rapid succession within one transaction (the
exact situation a check-in granting two point rewards creates), making
"most recent" ambiguous without a secondary sort key. See Correction 3
(PART H) — the new claim engine avoids this entirely by never re-reading
balance between grants, and this audit separately recommends fixing the
general-purpose query too.

### Daily check-in API (`server/db.ts:4396-4640`, `server/routers.ts:816-853`)

- `getEffectiveDailyCheckinConfig()` / `DEFAULT_DAILY_CHECKIN_CONFIG`
  (`server/_core/dailyCheckinConfig.ts`) — **one global JSON blob**
  (`isActive`, `rewardPercent`, `maxDiscountAmount`, `minPurchaseAmount`,
  `validityDays`) stored under a single key (`"daily_checkin_campaign"`) in
  the generic `settings` table (`key varchar unique, value text` —
  `drizzle/schema.ts:556-563`). There is exactly one campaign, ever, and it
  is JSON-only configuration with zero relational constraints — the
  precise pattern this task explicitly forbids going forward.
- `claimDailyCheckin(userId)` (`server/db.ts:4519-4622`) — the full
  claim flow: kill-switch check, fast-path re-check, then one
  `db.transaction()` that inserts a fresh `coupons` row followed by the
  `dailyCheckins` row. **The `dailyCheckins` unique constraint is the real
  race arbiter**: a losing concurrent transaction hits `ER_DUP_ENTRY`
  (errno 1062), rolls back entirely (including its just-inserted coupon —
  no orphan coupon is ever left behind), and re-reads the winner's row.
  This exact idempotency pattern (insert-then-catch-duplicate,
  re-read-the-winner) is the one the new reward-grant tables must extend,
  not replace.
- `getDailyCheckinStatus(userId)` — read-only status/reward-summary query.
- `markDailyCheckinCouponUsed(couponId, userId, tx)` — flips
  `dailyCheckins.status` to `"used"` when the coupon is redeemed at
  checkout (called from the order flow, not shown above). **Amendment 1**:
  this must move to updating the matched grant row instead — see PART I.
- tRPC (`server/routers.ts:822-853`): `dailyCheckin.getStatus` is
  `publicProcedure` (returns `{authenticated: false}` for anonymous
  visitors instead of throwing); `dailyCheckin.claim` is `protectedProcedure`.
  Both **already** catch every error and throw a fixed, generic
  `TRPCError` message — raw SQL/DB errors are never forwarded to the
  client. **This pattern must be preserved unchanged** for any new
  endpoint.

### Bangkok calendar-date handling (`server/_core/timezone.ts`)

Exactly two functions exist: `getBangkokBusinessDate(at?)` → `"YYYY-MM-DD"`
via `Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Bangkok", ...})`, and
`getNextBangkokDayStart(businessDate)` → the UTC instant of the *next*
Bangkok midnight, built from the fixed `+07:00` ISO offset (Thailand has no
DST, so this is exact with no seasonal edge case). **No date-subtraction or
date-diff helper exists yet** — the new streak/campaign-range logic needs
one (see PART E).

### Profile check-in UI (`client/src/components/DailyCheckinCard.tsx`, mounted on `ProfilePage`)

Renders exactly one of: login prompt, error+retry, "campaign off and
nothing issued today" (renders `null`), "already checked in today" (shows
the single coupon's code/expiry), or the claim button. **No streak display,
no milestone concept, no multi-reward display exist anywhere in the
client.** The component is careful to never render `error.message` from the
server — a second, independent layer on top of the server never leaking
raw errors.

### Admin routing and permissions

Server: a single `adminProcedure` (`server/_core/trpc.ts:30-36`) wraps
`protectedProcedure` and rejects unless `ctx.user.role === "admin"`. Client:
every `Admin*Page.tsx` independently re-checks `user?.role !== "admin"`
before rendering (e.g. `AdminCouponsPage.tsx:75`) and routes are registered
as plain `<Route path="/admin/...">` entries in `client/src/App.tsx` — there
is no nested-role/permission-group system, just the one `admin` role.
`admin.dailyCheckin.getConfig`/`updateConfig` **already exist** as tRPC
procedures (`server/routers.ts:1899-1927`) reading/writing the same JSON
blob — but **no admin UI page currently calls them**; `AdminSettingsPage.tsx`
has no daily-check-in section. This is a real, currently-dead-code gap the
new design should replace rather than build on top of.

### Migration 0027 (`drizzle/0027_add_daily_checkin_and_coupon_cap.sql`)

Creates `dailyCheckins` and adds `coupons.maxDiscountAmount`, both
guarded/idempotent (`information_schema`-checked `SET`/`PREPARE`/`EXECUTE`/
`DEALLOCATE`, the same pattern used by 0024/0026/0028). **This is the
pattern every new migration for this feature must follow** — verified
working and already fixed for idempotency-under-test-rewind in the two
prior recovery-branch commits on this history.

### Summary of what must change (not "extend")

The product requirement's ten capabilities (multi-campaign, points *and*
coupon rewards, multiple/repeating milestones, activation windows,
immutable snapshots) cannot be layered on top of the existing
`dailyCheckins.couponId NOT NULL UNIQUE` + single JSON-blob-config design —
that design structurally assumes exactly one campaign and exactly one
coupon per check-in, forever. Per the task instructions, **this is a
replacement of the reward-issuance model, not an extension of it** — the
existing `checkinDate`/timezone/unique-constraint/transaction/
error-hiding *patterns* are all sound and are reused as-is; the *coupon-only,
single-campaign* parts are what get replaced.

---

## A. Proposed database tables and columns

### `dailyCheckinCampaigns` (new) — Correction 4 applied

```
id            int PK autoincrement
campaignKey   varchar(50) not null           -- admin-assigned slug, e.g. "august-2026"
name          varchar(150) not null          -- display name, e.g. "August Daily Check-in"
description   text nullable
timezone      varchar(50) not null default "Asia/Bangkok"
startDate     varchar(10) not null           -- "YYYY-MM-DD", Bangkok calendar date, inclusive
endDate       varchar(10) not null           -- inclusive
status        enum("draft","active","ended") not null default "draft"
createdBy     int nullable                   -- admin userId, audit trail
createdAt     timestamp default now() not null
updatedAt     timestamp default now() on update now() not null

UNIQUE (campaignKey)
INDEX  (status, startDate, endDate)          -- "which campaign is active today" lookup
```

The previous `isActive boolean` is **replaced**, not supplemented, by
`status`. A boolean cannot distinguish "never launched" from "launched and
later paused" from "finished on schedule" — all three need different
editability rules (PART J) and none of them should ever look like the
others in an audit trail. Lifecycle:

- `draft` — fully editable (dates, rules, templates, name, description).
  Can transition to `active` exactly once.
- `active` — inside its Bangkok date range, claimable. Can transition to
  `ended` ("end early"). Cannot transition back to `draft`.
- `ended` — terminal. Never reactivated, never transitions anywhere else.
  This is Locked decision 6 (below): deactivation is permanent.

Only `status = "active"` campaigns whose Bangkok date range contains
`checkinDate` are claimable — a `draft` campaign (even one whose dates
technically overlap "today") is never claimable, and neither is an `ended`
one whose dates haven't technically elapsed yet (e.g. ended early).

`timezone` is stored but the application enforces `"Asia/Bangkok"` only in
v1 (rejects any other value) — this avoids a schema change if multi-region
campaigns are ever needed, while keeping the actual product requirement
("use Asia/Bangkok for campaign dates") as a hard application-level
invariant today, not a soft convention.

`startDate`/`endDate` reuse the exact `varchar(10)` Bangkok-date convention
`dailyCheckins.checkinDate` already established (PART 0) — no second date
representation is introduced.

### `dailyCheckinCouponTemplates` (new — supporting table for coupon-kind rules)

```
id                int PK autoincrement
campaignId        int not null              -- FK: dailyCheckinCampaigns.id
discountType      enum("flat","percentage") not null
discountValue     decimal(10,2) not null
maxDiscountAmount decimal(10,2) nullable
minPurchaseAmount decimal(10,2) not null default 0
validityDays      int not null              -- days from grant time until the minted coupon expires
createdAt/updatedAt timestamps

INDEX (campaignId)
```

Unchanged by this amendment, except its editability is now explicitly tied
to the owning campaign's lifecycle (Correction 5, PART J/L): a template may
be created/edited freely while its campaign is `draft`, and becomes
permanently frozen the moment that campaign has any `dailyCheckins` row —
regardless of the campaign's own `status`.

This is exactly today's `DailyCheckinCampaignConfig` shape, moved from one
global JSON blob into a relational, per-campaign, admin-editable row. A
template is **parameters used to mint a fresh coupon at grant time** — never
a real, pre-existing `coupons.id`. Real `coupons` rows continue to be
created one-per-grant, exactly as today (see PART I).

### `dailyCheckinRewardRules` (new — the configurable reward model) — Correction 2 applied

```
id                int PK autoincrement
campaignId        int not null              -- FK: dailyCheckinCampaigns.id
ruleType          enum("daily","milestone") not null
rewardKind        enum("points","coupon") not null
milestoneDay      int nullable              -- required iff ruleType="milestone"; the streak length that fires it
repeatEvery       int nullable              -- milestone only: if set, fires every N days (e.g. 10) instead of once
pointsAmount      decimal(10,2) nullable    -- required iff rewardKind="points"
couponTemplateId  int nullable              -- FK: dailyCheckinCouponTemplates.id, required iff rewardKind="coupon"
dedupeKey         varchar(120) not null     -- SERVER-GENERATED ONLY, see below
isActive          boolean not null default true  -- disable one rule without touching the whole campaign
sortOrder         int not null default 0    -- admin display ordering AND point-grant sequencing tiebreaker (Correction 3)
createdAt/updatedAt timestamps

UNIQUE (campaignId, dedupeKey)
INDEX  (campaignId, isActive)
```

**Correction 2 — why the old constraint is wrong and what replaces it**:
the original `UNIQUE(campaignId, ruleType, milestoneDay, rewardKind)` is
unsound because `milestoneDay` is `NULL` for every `ruleType="daily"` rule,
and MySQL/TiDB unique indexes treat each `NULL` as distinct from every other
`NULL` — two "daily points" rules in the same campaign would both insert
successfully, silently double-granting points every day. A `NULL`-bearing
column can never be load-bearing in a uniqueness constraint here.

The replacement is a single **server-computed, deterministic** string
column, never accepted from a client request body (the server recomputes it
from the validated rule fields and discards any client-supplied value —
this is a hard rule, not a convenience):

```
daily:points
daily:coupon
milestone:<milestoneDay>:once:<rewardKind>
milestone:<milestoneDay>:repeat:<repeatEvery>:<rewardKind>
```

Examples: `daily:points`, `daily:coupon`, `milestone:10:once:points`,
`milestone:10:repeat:10:points`, `milestone:7:once:coupon`.

`UNIQUE(campaignId, dedupeKey)` then directly enforces v1's exact limits:

- at most **one** daily points rule per campaign (`daily:points` collides)
- at most **one** daily coupon rule per campaign (`daily:coupon` collides)
- at most **one** rule for each exact `(milestoneDay, once-or-repeat-N,
  rewardKind)` combination — e.g. `milestone:10:once:points` and
  `milestone:10:repeat:10:points` are *different* keys and could both be
  inserted; this is caught separately (see validation below), not by the
  unique index.

Application-level invariants (validated in code, not DB `CHECK` — see PART C
for why):
- `ruleType="daily"` ⇒ `milestoneDay IS NULL AND repeatEvery IS NULL`
- `ruleType="milestone"` ⇒ `milestoneDay IS NOT NULL AND milestoneDay > 0`
- `rewardKind="points"` ⇒ `pointsAmount IS NOT NULL AND pointsAmount > 0`
- `rewardKind="coupon"` ⇒ `couponTemplateId IS NOT NULL`, and that template's
  `campaignId` must equal this rule's `campaignId`
- **new**: a given `(milestoneDay, rewardKind)` pair must not be configured
  as *both* a one-time (`repeatEvery IS NULL`) and a repeating
  (`repeatEvery IS NOT NULL`) rule at the same time — the unique index
  alone does not catch this (their `dedupeKey`s differ by design), so it is
  an explicit extra validation check at rule-creation time (PART C).

A milestone with both a points bonus *and* a coupon bonus (capability 4 in
combination with 3) is modeled as **two rule rows sharing the same
`milestoneDay`** with different `rewardKind` — permitted since their
`dedupeKey`s differ only in the trailing `<rewardKind>` segment.

### `dailyCheckinRewardGrants` (new — the immutable snapshot / reward ledger) — Correction 1 applied

This is the single, universal reward representation the task requires
instead of reusing `couponId`:

```
id                    int PK autoincrement
dailyCheckinId        int not null           -- FK: dailyCheckins.id (this specific check-in day)
userId                int not null           -- denormalized, see PART D for why
campaignId            int not null           -- denormalized, survives rule edits/deactivation
ruleId                int not null           -- FK: dailyCheckinRewardRules.id (never hard-deleted, see PART L)
rewardKind            enum("points","coupon") not null    -- SNAPSHOT
grantReason           enum("daily","milestone") not null  -- SNAPSHOT of ruleType
milestoneDay          int nullable                        -- SNAPSHOT, for milestone grants
milestoneInstanceNumber int nullable         -- see PART D; NULL for daily-reason grants
streakCountAtGrant    int not null           -- the user's streak count at the moment of this grant
pointsAmount          decimal(10,2) nullable -- SNAPSHOT: immutable, independent of later rule edits
pointsTransactionId   int nullable           -- FK: pointsTransactions.id, set iff rewardKind="points"
couponId              int nullable           -- FK: coupons.id, set iff rewardKind="coupon"
discountType          enum("flat","percentage") nullable  -- SNAPSHOT of the minted coupon's terms
discountValue         decimal(10,2) nullable               -- SNAPSHOT
maxDiscountAmount     decimal(10,2) nullable               -- SNAPSHOT
minPurchaseAmount     decimal(10,2) nullable               -- SNAPSHOT
status                enum("granted","used","void") not null default "granted"  -- NEW, reward-level
usedAt                timestamp nullable     -- NEW
voidedAt              timestamp nullable     -- NEW, optional, for future audit tooling
createdAt             timestamp default now() not null

UNIQUE (dailyCheckinId, ruleId)                       -- guarantee 1 (below)
UNIQUE (userId, ruleId, milestoneInstanceNumber)      -- guarantee 2 (below)
UNIQUE (couponId)                                     -- nullable one-to-one hardening, see below
UNIQUE (pointsTransactionId)                          -- nullable one-to-one hardening, see below
INDEX  (campaignId)
INDEX  (status)
```

**Nullable one-to-one hardening**: `couponId` and `pointsTransactionId` are
each guarded by their own **unique** index, not a plain one. Each minted
coupon and each points transaction belongs to exactly one grant — a real,
non-NULL `couponId` or `pointsTransactionId` must never be attributable to
two different grant rows, since that would mean two reward snapshots both
claim ownership of the same underlying coupon or ledger entry. MySQL/TiDB
unique indexes permit multiple `NULL`-containing rows (the same property
Correction 2 relies on for `dedupeKey` avoidance elsewhere in this
document), which is exactly what makes a plain unique index the right tool
here rather than a problem: every points grant has `couponId = NULL` and
every coupon grant has `pointsTransactionId = NULL`, and those NULLs must
never collide with each other or themselves — only the real, non-NULL
values on each column are ever compared for uniqueness.

**Correction 1 — reward-level status, not parent-row status**: the previous
design left `used`/`void` status on the parent `dailyCheckins` row, which
is wrong the moment a single check-in can issue more than one coupon (a
daily coupon *and* a milestone coupon on the same day) — marking the check-in
"used" when only one of its two coupons is redeemed would incorrectly mark
both. Status now lives on the grant itself:

- Point grants are always created with `status = "granted"` and never
  transition — points have no "used" concept at the grant level (spending
  points is tracked entirely by `pointsTransactions`, unaffected by this
  change).
- Coupon grants start as `status = "granted"`.
- Redeeming a coupon at checkout updates **only the one
  `dailyCheckinRewardGrants` row** matched by `couponId` — never any
  sibling grant from the same check-in, and never the parent
  `dailyCheckins` row.
- Multiple coupons granted by the same check-in are therefore
  **independently redeemable**: using the daily coupon has no effect on
  the milestone coupon's status, and vice versa.

Every reward-defining field is duplicated here at grant time (not just
referenced via `ruleId`) — this is the literal implementation of "historical
rewards must store immutable snapshots" and "editing a campaign must not
alter rewards already granted": once a grant row exists, nothing about what
the user actually received can change even if the admin later edits or
deactivates the rule (and, per Correction 5, the admin cannot edit it at all
once any grant exists — PART J/L).

---

## B. Unique constraints and indexes (consolidated)

| Table | Constraint | Purpose |
|---|---|---|
| `dailyCheckinCampaigns` | `UNIQUE(campaignKey)` | stable admin-facing identity |
| `dailyCheckinCampaigns` | `INDEX(status, startDate, endDate)` | "which campaign is active today" lookup |
| `dailyCheckinRewardRules` | `UNIQUE(campaignId, dedupeKey)` | prevent duplicate rule definitions, NULL-safe (Correction 2) |
| `dailyCheckins` (enhanced) | `UNIQUE(userId, checkinDate, campaignId)` *(new, additive alongside the legacy key-based one — see PART L)* | one check-in per user per day per campaign — the primary race arbiter, unchanged in spirit from today |
| `dailyCheckinRewardGrants` | `UNIQUE(dailyCheckinId, ruleId)` | one check-in event cannot grant the same rule twice (same-request/retry safety) |
| `dailyCheckinRewardGrants` | `UNIQUE(userId, ruleId, milestoneInstanceNumber)` | a specific milestone *instance* (the one-time milestone, or one specific repeat boundary) is granted at most once ever, across the user's full history — independent of which day it happened on |
| `dailyCheckinRewardGrants` | `UNIQUE(couponId)` *(nullable one-to-one — NULL-permissive, non-NULL-unique)* | each minted coupon belongs to exactly one grant; every points grant has `couponId = NULL` |
| `dailyCheckinRewardGrants` | `UNIQUE(pointsTransactionId)` *(nullable one-to-one — NULL-permissive, non-NULL-unique)* | each points transaction belongs to exactly one grant; every coupon grant has `pointsTransactionId = NULL` |
| `dailyCheckinRewardGrants` | `INDEX(status)` | redemption-state queries (e.g. admin support lookups) without a full scan |

No table needs a cross-column `CHECK` constraint enforced by the database:
this repo targets MySQL/TiDB via Drizzle, and TiDB's `CHECK` constraint
support/enforcement has historically been inconsistent across versions in
this project's own experience (see the TLS/hostname surprises already
documented for TiDB Cloud in `server/test-helpers/testDatabaseGuard.ts`) —
every invariant above that would otherwise be a `CHECK` is instead enforced
in application code at write time (rule validation, campaign overlap
checks), consistent with how `orderService.validateAndApplyCoupon` already
enforces its own business rules in code rather than in the schema.

---

## C. Reward rule model

Explicitly **relational, not JSON** — the task instruction "no JSON-only
configuration if relational constraints are needed" applies directly here:
uniqueness (no duplicate rule for the same milestone+kind), foreign-key
integrity (a coupon-kind rule must reference a real template), and
per-rule activation all require row-level constraints a JSON blob cannot
express or enforce.

Worked example — the campaign from the product requirement:

```
dailyCheckinCampaigns:
  { campaignKey: "august-2026", name: "August Daily Check-in",
    startDate: "2026-08-01", endDate: "2026-08-31", status: "draft" }

dailyCheckinRewardRules:
  { ruleType: "daily", rewardKind: "points", pointsAmount: 1.00,
    dedupeKey: "daily:points" }
  { ruleType: "milestone", rewardKind: "points", milestoneDay: 10,
    repeatEvery: NULL, pointsAmount: 2.00,
    dedupeKey: "milestone:10:once:points" }
```

A campaign combining every listed capability would add rows such as:

```
  { ruleType: "daily", rewardKind: "coupon", couponTemplateId: <5%-off template>,
    dedupeKey: "daily:coupon" }
  { ruleType: "milestone", rewardKind: "coupon", milestoneDay: 7,
    repeatEvery: NULL, couponTemplateId: <bigger one-time template>,
    dedupeKey: "milestone:7:once:coupon" }
  { ruleType: "milestone", rewardKind: "points", milestoneDay: 10,
    repeatEvery: 10, pointsAmount: 5.00,
    dedupeKey: "milestone:10:repeat:10:points" }   -- fires again at day 20, 30, ...
```

### Validation rules (server-side, at rule create/update time)

1. `dedupeKey` is **always** computed by the server from the rule's own
   validated fields, using the exact four formats above — a client-supplied
   `dedupeKey` in the request body is ignored/overwritten, never trusted or
   persisted as given. This is a hard rule: trusting a client value would
   let a malicious or buggy admin-tool request bypass the uniqueness
   guarantee entirely (e.g. by sending two different, non-colliding
   synthetic keys for what should be the same duplicate rule).
2. Inserting a rule whose computed `dedupeKey` already exists for that
   `campaignId` is rejected with a clear validation error (surfaced via the
   admin API, never a raw DB duplicate-key error — same "never expose raw
   SQL errors" rule as everywhere else in this codebase).
3. **New cross-rule check**: rejecting a rule whose `(milestoneDay,
   rewardKind)` pair already has a rule with the *opposite* `repeatEvery`
   nullability in the same campaign (i.e. can't configure day 10 as both
   "once" and "repeat every 10") — this is checked explicitly, since (per
   above) the two configurations produce different `dedupeKey`s and the
   unique index does not catch it.
4. Test cases required (PART M): creating a second `daily`/`points` rule in
   the same campaign is rejected; creating a second `daily`/`coupon` rule is
   rejected; creating a second rule at the same `(milestoneDay, once,
   rewardKind)` is rejected; creating a second rule at the same
   `(milestoneDay, repeat:N, rewardKind)` is rejected; creating a rule at
   the same `milestoneDay` with a *different* `repeatEvery` (e.g. `once` vs
   `repeat:10`) is rejected by the cross-rule check even though the
   `dedupeKey`s differ; two rules at the *same* `milestoneDay` with
   *different* `rewardKind` (points + coupon) **succeed** (this is the
   intended "both a point and a coupon bonus at day 10" case).

All of this is admin-editable data — zero code changes for a new campaign,
satisfying the core product requirement.

---

## D. Daily reward and streak milestone calculation

### Streak scope — Locked decision 1 (was previously flagged as open)

Streak is computed **per campaign**, not globally across a user's lifetime.
"10 consecutive days" means 10 consecutive days *within that campaign's own
run* — a September campaign's day 10 is independent of August's. This is no
longer a recommendation; it is resolved (see "Locked product decisions").

### Algorithm (inside the check-in transaction)

1. `checkinDate = getBangkokBusinessDate()`.
2. Look up the single campaign claimable for `checkinDate`:
   `SELECT * FROM dailyCheckinCampaigns WHERE status = 'active' AND
   startDate <= checkinDate AND endDate >= checkinDate ORDER BY startDate
   DESC LIMIT 1`. (`ORDER BY ... LIMIT 1` is defense-in-depth; PART F's
   overlap guard is what should make this always return ≤1 row.) If none,
   behave like today's kill-switch path (`campaignActive: false`, no new
   rewards).
3. Compute the user's streak: read this user+campaign's most recent
   `dailyCheckins` row (`ORDER BY checkinDate DESC LIMIT 1`). If its
   `checkinDate` equals `checkinDate` minus one Bangkok day (a **new**
   helper — see PART E) *and* its `streakCount > 0`, the new
   `streakCount = previous.streakCount + 1`; otherwise (no prior row, or a
   gap) **`streakCount = 1`** — Locked decision 2: missing one day resets
   the streak to 1 on the next claim, it does not resume from where it left
   off and does not go to 0.
4. Determine which rules fire, from the campaign's active
   `dailyCheckinRewardRules`:
   - every `ruleType="daily"` rule fires unconditionally.
   - a `ruleType="milestone"` rule fires when: `repeatEvery IS NULL AND
     streakCount === milestoneDay` (one-time — Locked decision 3: granted
     once per user per campaign, full stop), **or** `repeatEvery IS NOT
     NULL AND streakCount >= milestoneDay AND (streakCount - milestoneDay)
     % repeatEvery === 0` (repeating — Locked decision 5: fires at
     uninterrupted streak boundaries such as 10, 20, 30).
   - Locked decision 4: reaching the same threshold again *after* a broken
     streak does **not** re-grant a one-time milestone — this falls out of
     guarantee 2 below (the uniqueness is on `(userId, ruleId,
     milestoneInstanceNumber)`, not on the specific `dailyCheckinId` the
     streak happened to reach it on), not from any special-case check in
     this step.
5. For a firing milestone rule, compute
   `milestoneInstanceNumber = repeatEvery ? ((streakCount - milestoneDay) /
   repeatEvery) + 1 : 1` — this is the value `UNIQUE(userId, ruleId,
   milestoneInstanceNumber)` (PART B) actually arbitrates: instance `1` for
   a one-time milestone (so it can only ever be granted once, full stop),
   instance `1, 2, 3, …` for each successive repeat boundary (each boundary
   grantable once, but different boundaries don't collide).
6. Insert the enhanced `dailyCheckins` row (arbiter: `UNIQUE(userId,
   checkinDate, campaignId)`, unchanged in spirit from today).
7. For each firing rule, attempt the corresponding grant (PART F/G/H/I) —
   guarded by the two `dailyCheckinRewardGrants` unique constraints, with
   point-kind rules applying the strict in-memory sequencing from
   Correction 3 (PART H).
8. On a duplicate-key at step 6 (a concurrent request won first): roll back
   fully, re-read the winner's `dailyCheckins` row *and* its associated
   `dailyCheckinRewardGrants` rows, and return those — exactly today's
   "loser converges on the winner's result" behavior, extended from one
   coupon to a list of grants.

---

## E. Bangkok calendar-date handling

Reuses `getBangkokBusinessDate()`/`getNextBangkokDayStart()` unchanged.
**One new helper is required**, symmetric to the existing one:

```ts
// server/_core/timezone.ts (new addition, not a replacement)
export function getPreviousBangkokBusinessDate(businessDate: string): string {
  const startOfDay = new Date(`${businessDate}T00:00:00+07:00`);
  const previousInstant = new Date(startOfDay.getTime() - 24 * 60 * 60 * 1000);
  return getBangkokBusinessDate(previousInstant);
}
```

Built the same way as `getNextBangkokDayStart` (fixed `+07:00` offset, no
DST edge case in Thailand) — used for both streak-contiguity checks (PART
D step 3) and could double as a general "N days before" helper via a loop
if campaign-range validation ever needs it. Campaign `startDate`/`endDate`
comparisons (`startDate <= checkinDate <= endDate`) work as plain string
comparisons because `"YYYY-MM-DD"` sorts lexicographically identically to
chronologically — no date parsing needed for that check, consistent with
how `checkinDate` string equality is already used today.

---

## F. Transaction and concurrency design

- The entire claim (campaign lookup → streak computation → `dailyCheckins`
  insert → all rule grants) runs inside **one** `db.transaction()`, exactly
  as `claimDailyCheckin` does today. Since every statement inside is plain
  DML (INSERT/UPDATE/SELECT ... FOR UPDATE) — never DDL — there is no
  implicit-commit risk mid-transaction (the DDL-specific gotcha called out
  in this repo's own migration-runner comments does not apply to check-in
  DML); a failure at any point rolls back everything cleanly, and a client
  retry is always safe by construction.
- Point grants reuse `lockUserForPoints(userId, tx)` (`SELECT ... FOR
  UPDATE` on the `users` row) **exactly once per check-in transaction**,
  and all point-kind grants within that check-in are sequenced strictly
  in-memory afterward — see Correction 3 / PART H for the full algorithm.
  `getUserPointsBalance` is **not** called again between grants.
- Coupon grants reuse today's `tx.insert(coupons)` + `extractInsertId`
  pattern per grant — no coupon row is ever shared between grants or users.
  Each coupon grant's `dailyCheckinRewardGrants.status` starts at
  `"granted"` independently of any other grant from the same check-in
  (Correction 1).
- **Campaign activation-overlap enforcement** (admin-side, not
  check-in-side) — Correction 4: MySQL/TiDB has no native exclusion
  constraint (no Postgres-style `EXCLUDE USING gist`), so "no two `active`
  campaigns may overlap" cannot be a plain unique index. The
  create-then-activate admin action must serialize this check-then-write
  critical section using a **TiDB named lock**:

  ```sql
  SELECT GET_LOCK('daily_checkin_campaign_activation', 1) -- timeout ≥ 1 second
  -- ... query campaigns WHERE status = 'active' AND date range overlaps ...
  -- ... if none overlap: UPDATE the target campaign SET status = 'active' ...
  SELECT RELEASE_LOCK('daily_checkin_campaign_activation')
  ```

  Two hard requirements on this critical section:
  1. **Timeout is at least 1 second** (`GET_LOCK(name, 1)` or higher) — long
     enough that a legitimate concurrent admin request isn't spuriously
     rejected, short enough that a stuck/crashed holder doesn't wedge every
     future activation attempt indefinitely.
  2. **Acquire and release on the same, single dedicated connection**, and
     **always release in a `finally` block**, even if the overlap check or
     the activation update throws. `GET_LOCK`/`RELEASE_LOCK` are
     session-scoped in MySQL/TiDB — if the connection used to acquire the
     lock is not the exact same connection used to release it (e.g. a
     pooled connection silently handing the release call to a different
     underlying session), the release is a silent no-op and the lock stays
     held until that other session ends, wedging every subsequent
     activation attempt for up to the lock's own timeout, repeatedly. This
     is the same "dedicated connection, never a pool, for session-scoped
     state" precedent already established for `SET`/`PREPARE`/`EXECUTE`
     variables in this repo's migration test files (PART 0).
- Only campaigns with `status = "active"` (never `draft`, never `ended`)
  are checked for overlap — an admin may freely create/edit a `draft`
  campaign that overlaps an already-`active` one, to prepare it ahead of
  time; the rejection only fires at the moment a campaign is activated.
  Since `ended` is terminal (no reactivation, Locked decision 6), an ended
  campaign can never re-enter the overlap check either.

---

## G. Idempotency guarantees

Formal restatement of PART B/D/F as the guarantee this design provides:

1. **One check-in request never grants rewards twice**, even under
   concurrent/duplicate requests on the same calendar day —
   `UNIQUE(dailyCheckinId, ruleId)` plus the parent `UNIQUE(userId,
   checkinDate, campaignId)` together mean a losing concurrent transaction
   never partially commits any grant.
2. **A one-time milestone is rewarded exactly once, ever** — even if a
   user's streak resets and later climbs back to the same `milestoneDay`
   within the same campaign — enforced by `UNIQUE(userId, ruleId,
   milestoneInstanceNumber)` with `milestoneInstanceNumber` always `1` for
   non-repeating rules, independent of *which* `dailyCheckinId` the streak
   happened to reach it on. (Locked decisions 3 and 4.)
3. **A repeating milestone's Nth boundary is rewarded exactly once**, but
   different boundaries (day 10, day 20, day 30, …) are independently
   grantable — the same constraint, with `milestoneInstanceNumber`
   incrementing per boundary. (Locked decision 5.)
4. A retried/failed transaction is always safe to retry from scratch: no
   partial-grant recovery logic is needed because everything commits or
   rolls back atomically as pure DML (PART F).
5. **Reward redemption status is independently idempotent per grant**
   (Correction 1): redeeming one coupon grant from a check-in that produced
   several never changes any sibling grant's `status`; the redemption
   update is always scoped to the one `dailyCheckinRewardGrants` row
   matched by `couponId`.

---

## H. Point reward integration with `pointsTransactions` — Correction 3 applied

No changes to `pointsTransactions`' schema. **The previous design's mistake
was implying a `getUserPointsBalance` re-read between each point grant** —
this is unsafe because two `pointsTransactions` rows inserted moments apart
inside the same transaction can share the same `createdAt` `timestamp`
value, making "the most recent one" ambiguous to a query with no
tie-breaker (PART 0 finding). The corrected algorithm never re-reads
balance mid-transaction:

1. `lockUserForPoints(userId, tx)` — **once**, at the start of the
   check-in's points-granting phase.
2. Read the initial balance **once**: `let runningBalance =
   Number(await getUserPointsBalance(userId, tx))`.
3. Sort the check-in's firing point-kind rules deterministically:
   `ORDER BY sortOrder ASC, id ASC` (the same `sortOrder` column rules
   already have for admin display, reused here as the actual grant
   sequencing key — daily rules and milestone rules can be interleaved by
   an admin's chosen `sortOrder`, e.g. always granting the daily point
   before a same-day milestone bonus).
4. For each point rule, in that order:
   a. Insert the `dailyCheckinRewardGrants` snapshot row first (with
      `pointsTransactionId` initially `NULL`) and obtain its `grantId`
      (`extractInsertId`).
   b. `runningBalance += Number(rule.pointsAmount)` — **in memory only**,
      never via another `getUserPointsBalance` call.
   c. Insert `pointsTransactions` with `type: "earn"`, `amount:
      rule.pointsAmount`, `balanceAfter: runningBalance.toFixed(2)`,
      `referenceType: "daily_checkin_reward_grant"` (Amendment 1: renamed
      from the previous design's `"daily_checkin_reward"` to point at the
      grant, not the parent check-in), `referenceId: grantId`.
   d. Update the grant row: `pointsTransactionId = <the just-inserted
      pointsTransactions.id>`.
5. Never call `getUserPointsBalance` again for the remainder of this
   check-in's transaction — `runningBalance` is the single source of truth
   for the whole grant loop.

This guarantees `balanceAfter` is correct and monotonic across any number
of same-transaction point grants regardless of `createdAt` timestamp
collisions, because the chain is built entirely from one initial read plus
in-memory arithmetic, never from re-querying a table whose ordering can be
ambiguous.

**Separately recommended (general hardening, not specific to this
feature)**: `getUserPointsBalance`'s existing `ORDER BY createdAt DESC
LIMIT 1` (`server/db.ts:1605-1617`) and any similarly-ordered balance read
elsewhere should add `id DESC` as an explicit tie-breaker —
`ORDER BY createdAt DESC, id DESC LIMIT 1` — so that even code paths
*outside* this feature that do re-read balance between writes get a
deterministic "most recent" row. This is a small, additive, backward-compatible
change (same result whenever timestamps are already unique) recommended as
part of Stage 3 (PART N) but is not itself a blocker for this feature's own
correctness, since this feature no longer depends on that read being
repeated.

---

## I. Coupon reward integration with `coupons`/`couponUsages` — Correction 1 applied

No schema changes to `coupons`/`couponUsages`. Each coupon grant mints a
fresh `coupons` row from its rule's `dailyCheckinCouponTemplates` snapshot —
identical in shape to today's `buildDailyCheckinCouponCode` +
`tx.insert(coupons)` sequence, just parameterized from the template instead
of the global config.

`getRewardCouponOwnership()` (`server/db.ts:1407-1433`) gains a **third**
check (after `sportsMatchRewards` and the legacy `dailyCheckins.couponId`
path): a lookup against `dailyCheckinRewardGrants WHERE couponId = ? AND
rewardKind = 'coupon'`, returning `{userId, status}` sourced **from the
grant row's own `status` column** — not the parent `dailyCheckins.status`.
This is the direct fix for Correction 1: ownership/one-time-use enforcement
must reflect the fate of the *specific coupon in question*, not the
check-in event that happened to produce it alongside others.

`markDailyCheckinCouponUsed(couponId, userId, tx)` is rewritten to update
**only the matched grant row**:

```
UPDATE dailyCheckinRewardGrants
SET status = 'used', usedAt = NOW()
WHERE couponId = :couponId AND userId = :userId AND status = 'granted'
```

— never the parent `dailyCheckins` row. `dailyCheckins.status`/`usedAt`
remain in the schema **as legacy-only fields during the transition**
(PART L): they keep whatever meaning they had for pre-cutover rows, but new
code never writes to them, and `getRewardCouponOwnership`/
`markDailyCheckinCouponUsed` never read/write them for grant-sourced
coupons. This is exactly why a check-in producing two coupons (a daily one
and a milestone one) is safe: redeeming the daily coupon runs the `UPDATE`
above scoped to that one `couponId`, and the milestone coupon's grant row —
a different row entirely — is untouched, remaining independently
redeemable.

`validateAndApplyCoupon` requires **zero changes** — it already calls
`getRewardCouponOwnership` generically and doesn't know or care which table
produced the ownership record, or that "status" now lives one join further
away than it used to.

Per the explicit instruction, `couponId` is never treated as the universal
reward representation elsewhere in the new code — `rewardKind` on
`dailyCheckinRewardGrants` is the actual discriminator every new code path
branches on; points grants never touch `coupons` at all, and their
`status` column, while present on every grant row for schema uniformity,
is meaningless for `rewardKind = "points"` rows and always stays
`"granted"` (there is nothing to "use" or "void" at the grant level for
points — spending is tracked entirely by `pointsTransactions`).

---

## J. Admin configuration screens

New server endpoints, following the exact `adminProcedure` pattern used
everywhere else (`server/_core/trpc.ts`):

- `admin.dailyCheckinCampaigns.list/get/create/update` (draft-only fields),
  `.activate` (draft → active, GET_LOCK-guarded overlap check, PART F),
  `.endEarly` (active → ended)
- `admin.dailyCheckinCampaigns.rules.list/create/update/deactivate`
  (nested under a campaign; create/update/deactivate all rejected once the
  campaign has any `dailyCheckins` row — see Correction 5 below)
- `admin.dailyCheckinCampaigns.templates.create/update` (same
  once-frozen-after-first-check-in rule)
- `admin.dailyCheckinCampaigns.grants.list` (read-only audit/history view,
  paginated, for support/debugging — never mutable)

There is deliberately **no** `deactivate`/`reactivate` pair — Correction 4
replaces that ambiguous toggle with the one-way `draft → active → ended`
lifecycle; the only admin actions on a live campaign are "end it early" and
edit its still-mutable fields (name/description, and anything at all, if
still `draft`).

New client page(s), modeled after `AdminCouponsPage.tsx`'s existing
list+form pattern and gated the same way (`user.role === "admin"` client
check, mirrored by server-side `adminProcedure`):

- A campaign list/create/edit form: name, key, Bangkok-date range picker,
  status badge (`draft`/`active`/`ended`), description, an "Activate"
  button (draft only) and an "End early" button (active only).
- A nested rule editor within a campaign: add daily/milestone rows, choose
  points vs. coupon, milestone day + optional "repeat every N days" toggle,
  and (for coupon rules) the template fields (discount type/value/cap/min
  purchase/validity). The whole rule editor becomes **read-only** the
  moment the campaign has any check-in (see below), not just the
  reward-defining fields.

### Immutability after first check-in — Correction 5 (Locked decision 8)

The moment a campaign has **any** `dailyCheckins` row (i.e. at least one
user has checked in under it — this can only happen while `status =
"active"`, so in practice this means "since it was activated and at least
one claim succeeded"):

- `startDate` and `endDate` become permanently frozen — no extension, no
  shortening via direct edit. (Ending the campaign early remains available
  as a distinct, explicit action — see PART F/D — that changes `status`,
  not the dates.)
- Reward rules cannot be added, deleted, activated, or deactivated, and no
  rule's fields (`rewardKind`, `pointsAmount`, `couponTemplateId`,
  `milestoneDay`, `repeatEvery`, `dedupeKey`, `isActive`) can be changed.
- Coupon templates referenced by any rule in the campaign cannot be
  changed.
- `name` and `description` remain editable at any time (display-only
  fields with no bearing on reward computation).

This guarantees every user who checks in under a given campaign — on day 1
or day 30 — sees and receives exactly the same configured reward schedule,
which is the actual product guarantee "editing a campaign must not alter
rewards already granted" is protecting: it is not enough that *already
granted* rewards keep their snapshot values (PART A already guarantees
that structurally) — the *schedule itself* must stop moving once real users
are depending on it, so that a user on day 3 and a user on day 25 of the
same campaign were both playing by the same rules the whole time.

This is enforced at **both** layers, per the original design's
defense-in-depth principle: the admin API rejects the mutation attempt with
a clear validation error (never a raw DB error) before it reaches the
database, and the admin UI disables/hides the corresponding form fields
once it detects the campaign has any recorded check-in.

---

## K. User-facing profile/check-in display

Extends `DailyCheckinCard.tsx` (or a new, richer component reusing its
patterns) with:

- current streak count for the active campaign
- **a list** of today's reward(s) — no longer a single `reward` object,
  since a daily point *and* a coupon can both fire on the same day. This
  is Locked decision 9: `getDailyCheckinStatus` changes directly to
  `rewards: RewardSummary[]`, no deprecation window (no external consumers
  of this internal API).
- each coupon reward in the list carries **its own** redemption state
  (`status: "granted" | "used" | "void"`, sourced from its own
  `dailyCheckinRewardGrants` row, Correction 1) — the UI must render each
  coupon's usability independently; a used daily coupon and a still-valid
  milestone coupon from the same day must never be conflated into one
  "used" state for the whole check-in.
- progress toward the next milestone (e.g. "7/10 days to your next bonus"),
  computed client-side from the campaign's rule list + the user's current
  streak, or server-computed and included in the status response
- the same `authenticated`/`campaignActive`/`checkedInToday` branch
  structure as today, and the same rule of never rendering a raw server
  error message
- Locked decision 11: all Profile-page and Admin-page copy introduced by
  this feature is written in **Thai** during their respective
  implementation stages (Stage 5 for Profile, Stage 4 for Admin) — this
  replaces the previous design's "UI copy/i18n deferred to product/design"
  open item.

---

## L. Migration and backward-compatibility plan

Every step below follows this repo's established idempotent,
`information_schema`-guarded `SET`/`PREPARE`/`EXECUTE`/`DEALLOCATE` SQL
pattern (0024/0026/0027/0028) — safe to re-run against a partially-migrated
database, consistent with this repo's whole migration philosophy.

1. **Additive only, zero risk**: create `dailyCheckinCampaigns` (with
   `status enum`, not `isActive`), `dailyCheckinCouponTemplates`,
   `dailyCheckinRewardRules` (with `dedupeKey`, not the old composite
   unique), `dailyCheckinRewardGrants` (with `status`/`usedAt`/`voidedAt`
   from day one — these are not a later add-on). Backfill exactly one
   campaign row (`campaignKey: "default"`, `status: "active"`) plus one
   daily-coupon rule (`dedupeKey: "daily:coupon"`) + one coupon template,
   migrated from the current `settings` JSON blob's live values — so
   existing behavior is representable in the new model from day one, with
   no behavior change yet.
2. Add nullable `campaignId int` and `streakCount int not null default 0`
   to `dailyCheckins` (additive, guarded). Backfill `campaignId` for every
   existing row to the migrated "default" campaign's `id`. Per Locked
   decision 7, existing rows keep `streakCount = 0` and are never
   retroactively recomputed — the old system never rewarded streaks, so no
   historical milestone should ever fire for check-ins that happened under
   it.
3. Add `UNIQUE(userId, checkinDate, campaignId)` **alongside** the existing
   `UNIQUE(userId, checkinDate, campaignKey)` — both coexist during the
   transition; nothing is dropped yet.
4. Cut the application over: rewrite `claimDailyCheckin`/
   `getDailyCheckinStatus` to read the active campaign + its rules instead
   of `getEffectiveDailyCheckinConfig()`. Per the task instruction to not
   continue the old hardcoded design, this is a direct replacement, not a
   long-lived feature-flagged dual system.
5. Loosen `dailyCheckins.couponId` to nullable and drop its
   `UNIQUE(couponId)` constraint (a check-in that only grants points has no
   coupon at all) — only after confirming `getRewardCouponOwnership`/
   `markDailyCheckinCouponUsed` no longer require the old invariant (PART
   I). Per Locked decision 10, `couponId` itself is kept, deprecated, for
   exactly **one transitional release** as a "first coupon grant, if any"
   convenience mirror, then dropped in a final cleanup migration once
   nothing reads it.
6. Final cleanup migration + code removal: drop the legacy
   `UNIQUE(userId, checkinDate, campaignKey)` constraint, the legacy
   `dailyCheckins.couponId`/`status`/`usedAt` columns, and the
   `dailyCheckinConfig.ts` JSON-blob code path, once step 4 has been
   running in production for the one transitional release and nothing
   depends on the legacy paths.

---

## M. Test plan

Do not reduce coverage from the original design — every item below either
carries forward a prior test case unchanged or extends it for the five
corrections; nothing is removed.

**Unit (no database)**: `getPreviousBangkokBusinessDate` boundary tests
(mirroring the existing 16:59:59Z/17:00:00Z Bangkok-boundary tests already
in the timezone test suite); milestone-firing/`milestoneInstanceNumber`
calculation as a pure function, covering one-time, repeating, and
"streak jumped past the boundary" edge cases; rule-validation logic
(`ruleType`/`rewardKind` invariants from PART A); **`dedupeKey` generation**
as a pure function for all four formats, including that it is
recomputed/overwritten even when a caller supplies one; the point-grant
sequencing algorithm (PART H) as a pure function over an in-memory list of
rules + a starting balance, independent of the database.

**Integration (real disposable `ipenovel_test` database, following the
exact conventions of `migration-0024-episode-schema-repair.integration.test.ts`
/ `migration-0027-idempotency.integration.test.ts`)**:
- Campaign CRUD: create as `draft`, edit freely while `draft`, activate
  once (second activation attempt rejected), reject activating a campaign
  whose date range overlaps an already-`active` one, `endEarly` transitions
  `active → ended`, and reactivating an `ended` campaign is rejected.
- **Duplicate rule validation** (Correction 2): a second `daily`/`points`
  rule in the same campaign is rejected; a second `daily`/`coupon` rule is
  rejected; a second rule at the same `(milestoneDay, once, rewardKind)` is
  rejected; a second rule at the same `(milestoneDay, repeat:N,
  rewardKind)` is rejected; a rule at the same `milestoneDay` with a
  different `repeatEvery`-nullability (once vs. repeat) is rejected by the
  cross-rule check; two rules at the same `milestoneDay` with different
  `rewardKind` (points + coupon) both succeed.
- A daily-points-only campaign: correct grant + `pointsTransactions` row
  each day, no coupon ever minted.
- A milestone-only campaign: no grant before the milestone day, exactly one
  grant on it, per PART G guarantee 2.
- A combined daily+milestone campaign (the product requirement's worked
  example): both a daily grant and, on day 10, an *additional* milestone
  grant, both under one `dailyCheckinId`.
- A repeating milestone across multiple boundaries (day 10, 20, 30) —
  each boundary grants exactly once, verified via PART G guarantee 3.
- **Broken-streak milestone non-repetition** (Locked decisions 3/4):
  streak reaches a one-time milestone, resets (missed day), climbs back to
  the same `milestoneDay` a second time within the same campaign — verify
  no second grant is produced.
- Concurrent double-claim (parallel requests for the same user/day) —
  verify exactly one `dailyCheckins` row and one grant set is produced,
  the loser converges on the winner's grants.
- **Campaign activation overlap under concurrency** (Correction 4): two
  parallel activation attempts for overlapping campaigns — verify exactly
  one succeeds, the `GET_LOCK` is always released (a subsequent, unrelated
  activation attempt is never blocked by a leaked lock), and the loser
  receives a clear rejection, not a raw DB/lock error.
- **Immutability after first check-in** (Correction 5): attempting to edit
  `startDate`/`endDate`, add/remove/change a rule, or change a coupon
  template on a campaign that already has a `dailyCheckins` row — all
  rejected server-side; `name`/`description` edits on the same campaign
  still succeed.
- Editing a campaign/rule *before* any check-in exists — still fully
  permitted (draft-stage editability is not weakened by the immutability
  rule).
- `validateAndApplyCoupon`/`getRewardCouponOwnership` integration for a
  grant-sourced coupon (ownership, one-time-use, cap enforcement all still
  work through the new path).
- **Independent multi-coupon redemption** (Correction 1): a check-in
  produces both a daily coupon grant and a milestone coupon grant; redeem
  one via `markDailyCheckinCouponUsed` and verify only that grant's
  `status`/`usedAt` change — the sibling grant's `status` stays `"granted"`
  and it remains independently redeemable; verify the parent
  `dailyCheckins.status`/`usedAt` are untouched by either redemption
  (legacy-only fields).
- **`balanceAfter` correctness across two point grants in the same
  transaction** (Correction 3): a check-in firing both a daily points rule
  and a milestone points rule — verify both `pointsTransactions` rows have
  correctly chained `balanceAfter` values (initial + first amount, then +
  second amount) even when their `createdAt` values are identical (forcing
  the test to prove correctness independent of timestamp ordering, exactly
  the scenario the corrected algorithm exists to make safe), and that each
  grant's `pointsTransactionId` points at its own distinct
  `pointsTransactions` row with `referenceType = "daily_checkin_reward_grant"`.
- Migration idempotency: fully-absent → fully-present → partially-present
  → rerun, for every new table/column, matching the exact test pattern
  established for migrations 0024/0026/0027/0028.

---

## Locked product decisions

These were open recommendations in the prior revision of this document;
they are now resolved and must be implemented as stated, not revisited
during Phase 2 without a new product decision:

1. Streak scope is **per campaign** (PART D).
2. Missing one day resets `streakCount` to `1` on the next claim — it does
   not resume, and it does not go to `0` (PART D step 3).
3. A one-time milestone is granted **once per user per campaign** (PART G
   guarantee 2).
4. Reaching the same threshold again after a broken streak does **not**
   grant a one-time milestone again (PART D/G, enforced structurally by
   `UNIQUE(userId, ruleId, milestoneInstanceNumber)`).
5. Repeating milestones grant at **uninterrupted** streak boundaries such
   as 10, 20, and 30 (PART D step 4/5) — a broken streak that later climbs
   back up restarts the boundary sequence from the first one again (streak
   `1` → `10` still hits `milestoneInstanceNumber = 1` the next time it
   reaches 10, which is a *new*, previously-ungranted instance only if the
   first instance was never granted before the break; if it *was* already
   granted, the same instance-1 constraint from decision 4 still applies).
6. **Deactivation means permanently ending the campaign** — `status:
   "ended"` is terminal; there is no reactivation path, ever (PART A/F/J).
7. Historical legacy check-ins (rows that existed before this feature)
   keep `streakCount = 0` and receive no retroactive milestones (PART L
   step 2).
8. Campaign dates, rules, and coupon templates become **immutable** after
   the first check-in against that campaign — only `name`/`description`
   remain editable, and only "end early" remains available as a lifecycle
   action (PART J, Correction 5).
9. `getDailyCheckinStatus` changes **directly** to `rewards:
   RewardSummary[]` — no deprecation window, no compatibility shim (PART K).
10. Legacy `dailyCheckins.couponId` is made nullable and kept for
    **exactly one transitional release** before final cleanup removal
    (PART L step 5/6).
11. Profile and Admin UI copy introduced by this feature will be
    **Thai** during their implementation phases (PART K, Stage 4/5).

---

## N. Implementation plan — five major stages

Regrouped from the prior revision's flat ten-item list into five major
stages, per this amendment's instruction. Each stage still proceeds as
several small, independently reviewable commits — the grouping is for
sequencing and review-batching, not a reduction in granularity, and no test
coverage from the prior revision (or this amendment's additions) is
dropped.

### Stage 1 — Schema, migration, backfill, and migration idempotency tests
1. Create the four new tables (`dailyCheckinCampaigns` with `status` enum,
   `dailyCheckinCouponTemplates`, `dailyCheckinRewardRules` with
   `dedupeKey`, `dailyCheckinRewardGrants` with `status`/`usedAt`/
   `voidedAt`) — additive only, plus their own idempotency integration
   tests (PART M).
2. Backfill migration: default campaign (`status: "active"`)/template/rule
   from the current `settings` JSON config; `campaignId`
   (nullable)/`streakCount` (default 0) columns on `dailyCheckins` +
   backfill; the additive `UNIQUE(userId, checkinDate, campaignId)`
   constraint alongside the legacy one (PART L steps 1-3).

### Stage 2 — Bangkok date, streak, milestone, rule-validation, and read-side helpers
3. `getPreviousBangkokBusinessDate` + milestone/streak pure-function
   helpers (`milestoneInstanceNumber` calculation) + unit tests.
4. `dedupeKey` generation (all four formats) + rule-validation logic
   (including the new cross-rule once-vs-repeat check, Correction 2) +
   unit tests, including the duplicate-rule rejection cases (PART C/M).
5. Read-side query functions (`db.ts`): active-campaign lookup, rule
   lookup, grant history — plus their integration tests, no behavior
   change yet (old `claimDailyCheckin` untouched).

### Stage 3 — Transactional claim engine, points, coupons, grants, concurrency tests
6. Rewritten `claimDailyCheckin`/`getDailyCheckinStatus` on the new model,
   implementing the exact point-grant sequencing algorithm from Correction
   3 (PART H) and the reward-level status model from Correction 1
   (PART I) — the actual behavior cutover commit, with the full
   integration test suite (PART M), including the two-point-grants and
   multi-coupon-independent-redemption cases.
7. `getRewardCouponOwnership` extension for grant-sourced coupons (reading
   `status` from the grant, not the parent row) + targeted
   `validateAndApplyCoupon` integration tests.
8. General hardening follow-up: add the `id DESC` tie-breaker to
   `getUserPointsBalance`'s `ORDER BY` (PART H's separately-recommended
   fix) + its own regression test.

### Stage 4 — Admin Campaign/Rule/Template API and UI
9. Admin campaign CRUD + `activate` (GET_LOCK-guarded overlap check,
   Correction 4) + `endEarly` endpoints, with validation, and their
   concurrency integration tests (parallel activation attempts, lock
   release verification).
10. Admin rule/template CRUD endpoints, enforcing the Correction 5
    immutability rule (rejecting mutations once any check-in exists against
    the campaign) + integration tests for both the allowed (draft-stage)
    and rejected (post-check-in) cases.
11. Admin campaign/rule/template management UI pages (Thai copy, Locked
    decision 11), modeled on `AdminCouponsPage.tsx`'s existing patterns,
    with immutable fields disabled/hidden once a campaign has any
    check-in.

### Stage 5 — Profile UI, complete integration tests, test:ci, test:repeat, and release gate
12. User-facing profile/check-in UI: streak + multi-reward display, each
    coupon reward showing its own independent redemption state (Thai copy,
    Locked decision 11).
13. Full integration test suite finalized end-to-end (every case in PART M
    passing together, not just individually) + `pnpm test:ci` full flow
    (migrate → unit → integration) verified green.
14. `pnpm test:repeat 3` determinism check and `pnpm test:gate` release-gate
    comparison against the existing known-failure baseline, both passing,
    before this feature is considered ready to ship.
15. Cleanup migration (PART L step 6): drop legacy `dailyCheckins.couponId`
    uniqueness/column, the legacy `campaignKey`-based unique constraint,
    the legacy `status`/`usedAt` columns, and the `dailyCheckinConfig.ts`
    JSON-blob path — only after Stage 3's cutover has run in production for
    the one transitional release required by Locked decision 10.

---

## Remaining implementation-detail follow-ups (not product decisions)

Everything that was an open product/business-rule question in the prior
revision is now resolved above ("Locked product decisions"). What remains
are pure implementation judgment calls, deliberately left for the engineer
implementing each stage rather than fixed here:

1. The exact `GET_LOCK` timeout value above the required 1-second floor
   (e.g. 1s vs. 3s vs. 5s) — tune based on observed admin-tool latency once
   Stage 4 is in review, not speculatively now.
2. Whether the `id DESC` tie-breaker fix to `getUserPointsBalance` (PART H)
   ships in Stage 3 alongside this feature's own cutover, or as an
   independent, slightly earlier hardening commit — either is acceptable;
   Stage 3 lists it last specifically so it can be pulled forward without
   reordering anything else.
3. Exact Thai copy strings for the Profile/Admin UI (Locked decision 11
   fixes the *language*, not the specific wording) — a follow-up for
   product/design once Stage 4/5 implementation begins.
4. Whether `admin.dailyCheckinCampaigns.grants.list`'s pagination/filtering
   shape needs anything beyond a basic paginated list for the initial
   support/debugging use case — expand only if a real support workflow
   needs it.
