# Configurable Daily Check-in Reward System — Design Document (Phase 1)

Status: **design only — no implementation code in this commit.**
Branch: `feature/daily-checkin-dynamic-rewards`, based on `fix/daily-checkin-safe` @ `b320a3dd11f83e09b65123c357b920727f94e4f5`.

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
  checkout (called from the order flow, not shown above).
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

### `dailyCheckinCampaigns` (new)

```
id            int PK autoincrement
campaignKey   varchar(50) not null           -- admin-assigned slug, e.g. "august-2026"
name          varchar(150) not null          -- display name, e.g. "August Daily Check-in"
description   text nullable
timezone      varchar(50) not null default "Asia/Bangkok"
startDate     varchar(10) not null           -- "YYYY-MM-DD", Bangkok calendar date, inclusive
endDate       varchar(10) not null           -- inclusive
isActive      boolean not null default true  -- admin on/off switch, independent of date range
createdBy     int nullable                   -- admin userId, audit trail
createdAt     timestamp default now() not null
updatedAt     timestamp default now() on update now() not null

UNIQUE (campaignKey)
INDEX  (isActive, startDate, endDate)          -- "find the active campaign for today"
```

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

This is exactly today's `DailyCheckinCampaignConfig` shape, moved from one
global JSON blob into a relational, per-campaign, admin-editable row. A
template is **parameters used to mint a fresh coupon at grant time** — never
a real, pre-existing `coupons.id`. Real `coupons` rows continue to be
created one-per-grant, exactly as today (see PART I).

### `dailyCheckinRewardRules` (new — the configurable reward model)

```
id                int PK autoincrement
campaignId        int not null              -- FK: dailyCheckinCampaigns.id
ruleType          enum("daily","milestone") not null
rewardKind        enum("points","coupon") not null
milestoneDay      int nullable              -- required iff ruleType="milestone"; the streak length that fires it
repeatEvery       int nullable              -- milestone only: if set, fires every N days (e.g. 10) instead of once
pointsAmount      decimal(10,2) nullable    -- required iff rewardKind="points"
couponTemplateId  int nullable              -- FK: dailyCheckinCouponTemplates.id, required iff rewardKind="coupon"
isActive          boolean not null default true  -- disable one rule without touching the whole campaign
sortOrder         int not null default 0    -- admin display ordering only
createdAt/updatedAt timestamps

UNIQUE (campaignId, ruleType, milestoneDay, rewardKind)
INDEX  (campaignId, isActive)
```

Application-level invariants (validated in code, not DB `CHECK` — see PART C
for why):
- `ruleType="daily"` ⇒ `milestoneDay IS NULL AND repeatEvery IS NULL`
- `ruleType="milestone"` ⇒ `milestoneDay IS NOT NULL AND milestoneDay > 0`
- `rewardKind="points"` ⇒ `pointsAmount IS NOT NULL AND pointsAmount > 0`
- `rewardKind="coupon"` ⇒ `couponTemplateId IS NOT NULL`, and that template's
  `campaignId` must equal this rule's `campaignId`

A milestone with both a points bonus *and* a coupon bonus (capability 4 in
combination with 3) is modeled as **two rule rows sharing the same
`milestoneDay`** with different `rewardKind` — permitted by the unique
constraint above since `rewardKind` differs.

### `dailyCheckinRewardGrants` (new — the immutable snapshot / reward ledger)

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
createdAt             timestamp default now() not null

UNIQUE (dailyCheckinId, ruleId)                       -- guarantee 1 (below)
UNIQUE (userId, ruleId, milestoneInstanceNumber)      -- guarantee 2 (below)
INDEX  (campaignId)
INDEX  (pointsTransactionId)
INDEX  (couponId)
```

Every reward-defining field is duplicated here at grant time (not just
referenced via `ruleId`) — this is the literal implementation of "historical
rewards must store immutable snapshots" and "editing a campaign must not
alter rewards already granted": once a grant row exists, nothing about what
the user actually received can change even if the admin later edits or
deactivates the rule.

---

## B. Unique constraints and indexes (consolidated)

| Table | Constraint | Purpose |
|---|---|---|
| `dailyCheckinCampaigns` | `UNIQUE(campaignKey)` | stable admin-facing identity |
| `dailyCheckinCampaigns` | `INDEX(isActive, startDate, endDate)` | "which campaign is active today" lookup |
| `dailyCheckinRewardRules` | `UNIQUE(campaignId, ruleType, milestoneDay, rewardKind)` | prevent duplicate rule definitions |
| `dailyCheckins` (enhanced) | `UNIQUE(userId, checkinDate, campaignId)` *(new, additive alongside the legacy key-based one — see PART L)* | one check-in per user per day per campaign — the primary race arbiter, unchanged in spirit from today |
| `dailyCheckinRewardGrants` | `UNIQUE(dailyCheckinId, ruleId)` | one check-in event cannot grant the same rule twice (same-request/retry safety) |
| `dailyCheckinRewardGrants` | `UNIQUE(userId, ruleId, milestoneInstanceNumber)` | a specific milestone *instance* (the one-time milestone, or one specific repeat boundary) is granted at most once ever, across the user's full history — independent of which day it happened on |

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
    startDate: "2026-08-01", endDate: "2026-08-31", isActive: true }

dailyCheckinRewardRules:
  { ruleType: "daily", rewardKind: "points", pointsAmount: 1.00 }
  { ruleType: "milestone", rewardKind: "points", milestoneDay: 10,
    repeatEvery: NULL, pointsAmount: 2.00 }
```

A campaign combining every listed capability would add rows such as:

```
  { ruleType: "daily", rewardKind: "coupon", couponTemplateId: <5%-off template> }
  { ruleType: "milestone", rewardKind: "coupon", milestoneDay: 7,
    repeatEvery: NULL, couponTemplateId: <bigger one-time template> }
  { ruleType: "milestone", rewardKind: "points", milestoneDay: 10,
    repeatEvery: 10, pointsAmount: 5.00 }   -- fires again at day 20, 30, ...
```

All of this is admin-editable data — zero code changes for a new campaign,
satisfying the core product requirement.

---

## D. Daily reward and streak milestone calculation

### Streak scope decision (flagged in PART N as needing product confirmation)

Streak is computed **per campaign**, not globally across a user's lifetime.
"10 consecutive days" naturally means 10 consecutive days *within that
campaign's own run* — a September campaign's day 10 is independent of
August's. This is the simpler, safer interpretation given the product
brief doesn't specify cross-campaign carryover; see PART N.

### Algorithm (inside the check-in transaction)

1. `checkinDate = getBangkokBusinessDate()`.
2. Look up the single active campaign for `checkinDate`:
   `SELECT * FROM dailyCheckinCampaigns WHERE isActive = true AND startDate
   <= checkinDate AND endDate >= checkinDate ORDER BY startDate DESC LIMIT
   1`. (`ORDER BY ... LIMIT 1` is defense-in-depth; PART F's overlap
   guard is what should make this always return ≤1 row.) If none, behave
   like today's kill-switch path (`campaignActive: false`, no new rewards).
3. Compute the user's streak: read this user+campaign's most recent
   `dailyCheckins` row (`ORDER BY checkinDate DESC LIMIT 1`). If its
   `checkinDate` equals `checkinDate` minus one Bangkok day (a **new**
   helper — see PART E) *and* its `streakCount > 0`, the new
   `streakCount = previous.streakCount + 1`; otherwise (no prior row, or a
   gap) `streakCount = 1`.
4. Determine which rules fire, from the campaign's active
   `dailyCheckinRewardRules`:
   - every `ruleType="daily"` rule fires unconditionally.
   - a `ruleType="milestone"` rule fires when: `repeatEvery IS NULL AND
     streakCount === milestoneDay` (one-time), **or** `repeatEvery IS NOT
     NULL AND streakCount >= milestoneDay AND (streakCount - milestoneDay)
     % repeatEvery === 0` (repeating, first fire at `milestoneDay`, then
     every `repeatEvery` days after).
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
   guarded by the two `dailyCheckinRewardGrants` unique constraints.
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
  UPDATE` on the `users` row) **once per check-in transaction**, before any
  `recordPointsTransaction` call — if a check-in grants both a daily point
  and a milestone point bonus, both `recordPointsTransaction` calls happen
  sequentially inside the same lock, so each correctly reads the
  just-written `balanceAfter` from the previous call within the same `tx`
  (see PART H).
- Coupon grants reuse today's `tx.insert(coupons)` + `extractInsertId`
  pattern per grant — no coupon row is ever shared between grants or users.
- **Campaign overlap enforcement** (admin-side, not check-in-side): MySQL/
  TiDB has no native exclusion constraint (no Postgres-style `EXCLUDE USING
  gist`), so "no two *active* campaigns may overlap" cannot be a plain
  unique index. The create/activate admin endpoint must serialize this
  check-then-write critical section — recommended approach: a MySQL named
  lock (`GET_LOCK('daily_checkin_campaign_activation', <timeout>)` /
  `RELEASE_LOCK(...)`, the same primitive already used for migration-runner
  concurrency elsewhere in this codebase's tooling) wrapped around "query
  active campaigns overlapping the requested range" + "insert/activate" as
  one critical section, so two admins racing to activate overlapping
  campaigns can't both succeed.
- Only **active** campaigns are checked for overlap — an admin may freely
  create/edit a *draft* (`isActive: false`) campaign that overlaps an
  already-running active one, to prepare it ahead of time; the rejection
  only fires at the moment a campaign is (re)activated.

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
   happened to reach it on.
3. **A repeating milestone's Nth boundary is rewarded exactly once**, but
   different boundaries (day 10, day 20, day 30, …) are independently
   grantable — the same constraint, with `milestoneInstanceNumber`
   incrementing per boundary.
4. A retried/failed transaction is always safe to retry from scratch: no
   partial-grant recovery logic is needed because everything commits or
   rolls back atomically as pure DML (PART F).

---

## H. Point reward integration with `pointsTransactions`

No changes to `pointsTransactions`' schema. Each points grant calls the
existing `recordPointsTransaction` with:

- `type: "earn"`
- `amount: rule.pointsAmount` (as recorded on the grant snapshot, not
  re-read from the live rule row)
- `referenceType: "daily_checkin_reward"` (new value, following the
  existing convention alongside `"order"`, `"sports_vote"`, `"refund"`)
- `referenceId: dailyCheckinRewardGrants.id` — **not** `dailyCheckins.id** —
  so that a daily point grant and a same-day milestone point grant produce
  two distinguishable `pointsTransactions` rows, each traceable to exactly
  one grant.

`balanceAfter` correctness across multiple point grants in one check-in:
`lockUserForPoints` holds the row lock for the whole transaction, and each
subsequent `getUserPointsBalance(userId, tx)` call inside that same `tx`
sees the previous `recordPointsTransaction` call's own uncommitted write
(same-transaction read-your-writes) — so a check-in with two point rules
firing produces two `pointsTransactions` rows with correctly chained
`balanceAfter` values, atomically.

---

## I. Coupon reward integration with `coupons`/`couponUsages`

No schema changes to `coupons`/`couponUsages`. Each coupon grant mints a
fresh `coupons` row from its rule's `dailyCheckinCouponTemplates` snapshot —
identical in shape to today's `buildDailyCheckinCouponCode` +
`tx.insert(coupons)` sequence, just parameterized from the template instead
of the global config.

`getRewardCouponOwnership()` (`server/db.ts:1407-1433`) gains a **third**
check (after `sportsMatchRewards` and the legacy `dailyCheckins.couponId`
path): a lookup against `dailyCheckinRewardGrants WHERE couponId = ? AND
rewardKind = 'coupon'`, returning `{userId, status}` sourced from the
grant's parent `dailyCheckins.status` (the check-in row remains the status
owner — `markDailyCheckinCouponUsed` continues to flip it, just now
resolved through the grant instead of the direct `couponId` column for new
rows). `validateAndApplyCoupon` requires **zero changes** — it already
calls `getRewardCouponOwnership` generically and doesn't know or care which
table produced the ownership record.

Per the explicit instruction, `couponId` is never treated as the universal
reward representation elsewhere in the new code — `rewardKind` on
`dailyCheckinRewardGrants` is the actual discriminator every new code path
branches on; points grants never touch `coupons` at all.

---

## J. Admin configuration screens

New server endpoints, following the exact `adminProcedure` pattern used
everywhere else (`server/_core/trpc.ts`):

- `admin.dailyCheckinCampaigns.list/get/create/update/activate/deactivate`
- `admin.dailyCheckinCampaigns.rules.list/create/update/deactivate`
  (nested under a campaign)
- `admin.dailyCheckinCampaigns.grants.list` (read-only audit/history view,
  paginated, for support/debugging — never mutable)

New client page(s), modeled after `AdminCouponsPage.tsx`'s existing
list+form pattern and gated the same way (`user.role === "admin"` client
check, mirrored by server-side `adminProcedure`):

- A campaign list/create/edit form: name, key, Bangkok-date range picker,
  active toggle, description.
- A nested rule editor within a campaign: add daily/milestone rows, choose
  points vs. coupon, milestone day + optional "repeat every N days" toggle,
  and (for coupon rules) the template fields (discount type/value/cap/min
  purchase/validity).

**Immutability enforcement in the admin UI, not just the data layer**: once
any `dailyCheckinRewardGrants` row references a rule, that rule's
reward-defining fields (`rewardKind`, `pointsAmount`, `couponTemplateId`,
`milestoneDay`, `repeatEvery`) become read-only in the form and are
rejected server-side if a change is attempted — only `isActive`/`sortOrder`
remain editable. This is defense-in-depth for "editing a campaign must not
alter rewards already granted": the grant snapshot already guarantees it
structurally, but blocking the edit at the admin layer prevents a confusing
UI state where an edit silently "succeeds" but has no retroactive effect.

---

## K. User-facing profile/check-in display

Extends `DailyCheckinCard.tsx` (or a new, richer component reusing its
patterns) with:

- current streak count for the active campaign
- **a list** of today's reward(s) — no longer a single `reward` object,
  since a daily point *and* a coupon can both fire on the same day
- progress toward the next milestone (e.g. "7/10 days to your next bonus"),
  computed client-side from the campaign's rule list + the user's current
  streak, or server-computed and included in the status response
- the same `authenticated`/`campaignActive`/`checkedInToday` branch
  structure as today, and the same rule of never rendering a raw server
  error message

**Open decision** (flagged in PART N): whether `getDailyCheckinStatus`'s
response shape changes `reward: RewardSummary | null` directly to `rewards:
RewardSummary[]` in the same rollout, versus keeping `reward` for one
deprecation window. Recommendation: change it directly — this is a
pre-existing, low-traffic feature being redesigned, not a public API with
external consumers, so a compatibility shim would add complexity without a
real corresponding benefit.

---

## L. Migration and backward-compatibility plan

Every step below follows this repo's established idempotent,
`information_schema`-guarded `SET`/`PREPARE`/`EXECUTE`/`DEALLOCATE` SQL
pattern (0024/0026/0027/0028) — safe to re-run against a partially-migrated
database, consistent with this repo's whole migration philosophy.

1. **Additive only, zero risk**: create `dailyCheckinCampaigns`,
   `dailyCheckinCouponTemplates`, `dailyCheckinRewardRules`,
   `dailyCheckinRewardGrants`. Backfill exactly one campaign row
   (`campaignKey: "default"`) plus one daily-coupon rule + one coupon
   template, migrated from the current `settings` JSON blob's live values
   — so existing behavior is representable in the new model from day one,
   with no behavior change yet.
2. Add nullable `campaignId int` and `streakCount int not null default 0`
   to `dailyCheckins` (additive, guarded). Backfill `campaignId` for every
   existing row to the migrated "default" campaign's `id`. Backfilling a
   correct historical `streakCount` from `checkinDate` contiguity is a
   one-time data-migration script — flagged as an implementation decision
   in PART N (alternative: leave existing rows at `streakCount = 0` since
   the *old* system never rewarded streaks, so no historical milestone
   should retroactively fire anyway).
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
   I). `couponId` itself is kept, deprecated, for one more release as a
   "first coupon grant, if any" convenience mirror, then dropped in a final
   cleanup migration once nothing reads it.
6. Final cleanup migration + code removal: drop the legacy
   `UNIQUE(userId, checkinDate, campaignKey)` constraint and the
   `dailyCheckinConfig.ts` JSON-blob code path, once step 4 has been
   running in production and nothing depends on the legacy path.

---

## M. Test plan

**Unit (no database)**: `getPreviousBangkokBusinessDate` boundary tests
(mirroring the existing 16:59:59Z/17:00:00Z Bangkok-boundary tests already
in the timezone test suite); milestone-firing/`milestoneInstanceNumber`
calculation as a pure function, covering one-time, repeating, and
"streak jumped past the boundary" edge cases; rule-validation logic
(`ruleType`/`rewardKind` invariants from PART A).

**Integration (real disposable `ipenovel_test` database, following the
exact conventions of `migration-0024-episode-schema-repair.integration.test.ts`
/ `migration-0027-idempotency.integration.test.ts`)**:
- Campaign CRUD, including rejecting an overlapping-active-campaign
  activation attempt.
- A daily-points-only campaign: correct grant + `pointsTransactions` row
  each day, no coupon ever minted.
- A milestone-only campaign: no grant before the milestone day, exactly one
  grant on it, per PART G guarantee 2.
- A combined daily+milestone campaign (the product requirement's worked
  example): both a daily grant and, on day 10, an *additional* milestone
  grant, both under one `dailyCheckinId`.
- A repeating milestone across multiple boundaries (day 10, 20, 30) —
  each boundary grants exactly once, verified via PART G guarantee 3.
- Concurrent double-claim (parallel requests for the same user/day) —
  verify exactly one `dailyCheckins` row and one grant set is produced,
  the loser converges on the winner's grants.
- Editing a campaign/rule after grants exist against it — reward-defining
  fields rejected server-side; existing grants' snapshot values unchanged.
- `validateAndApplyCoupon`/`getRewardCouponOwnership` integration for a
  grant-sourced coupon (ownership, one-time-use, cap enforcement all still
  work through the new path).
- `balanceAfter` correctness across a check-in producing two point grants
  in the same transaction (PART H).
- Migration idempotency: fully-absent → fully-present → partially-present
  → rerun, for every new table/column, matching the exact test pattern
  established for migrations 0024/0026/0027/0028.

---

## N. Recommended implementation commits

Small, independently reviewable commits, not one mega-commit:

1. Schema + migration: the four new tables (additive only) + idempotency
   integration tests for the migration itself.
2. Backfill migration: default campaign/template/rule from the current
   `settings` JSON config; `campaignId`/`streakCount` columns on
   `dailyCheckins` (nullable/defaulted, additive) + backfill.
3. `getPreviousBangkokBusinessDate` + milestone/streak pure-function helpers
   + unit tests.
4. Read-side query functions (`db.ts`): campaign lookup, rule lookup, grant
   history — plus their integration tests, no behavior change yet (old
   `claimDailyCheckin` untouched).
5. Rewritten `claimDailyCheckin`/`getDailyCheckinStatus` on the new model +
   full integration test suite (PART M). This is the actual behavior
   cutover commit.
6. `getRewardCouponOwnership` extension for grant-sourced coupons +
   targeted `validateAndApplyCoupon` integration tests.
7. Admin campaign/rule/template CRUD API endpoints + validation +
   overlap-locking (PART F).
8. Admin campaign/rule management UI pages.
9. User-facing profile/check-in UI: streak + multi-reward display.
10. Cleanup migration: drop legacy `dailyCheckins.couponId` uniqueness,
    the legacy `campaignKey`-based unique constraint, and the
    `dailyCheckinConfig.ts` JSON-blob path, once step 5 has run in
    production long enough to confirm nothing depends on them.

---

## Risks and unresolved decisions (need product/eng confirmation before Phase 2)

1. **Streak scope**: per-campaign reset (recommended, PART D) vs. carrying
   a streak across consecutive campaigns. The product brief doesn't say;
   per-campaign is simpler and matches "10 consecutive days" reading most
   naturally as "within this campaign."
2. **Deactivate-then-reactivate mid-campaign**: does a user's in-progress
   streak survive a temporary admin deactivation, or reset? Recommendation:
   resets — deactivation is treated as an effective campaign pause/end for
   streak purposes, to avoid ambiguous "how many days were paused" logic.
3. **Historical `streakCount` backfill** (PART L step 2): backfill by
   recomputing from `checkinDate` contiguity, or leave existing rows at 0
   since the old system never rewarded streaks? Recommendation: leave at 0
   — no historical milestone should retroactively fire under the new rules
   for check-ins that happened under the old, streak-less system.
4. **Campaign date-range edits after check-ins exist**: should changing a
   live campaign's `endDate`/`startDate` be restricted once any check-in
   has been recorded against it, symmetric to rule-field immutability
   (PART J)? Recommendation: yes, same principle — extending is probably
   safe, shortening or moving the start later is not, and the simplest safe
   rule is "no date-range edits once any check-in exists," with a separate,
   explicit "end the campaign early" action (sets `isActive: false`,
   distinct from editing `endDate`) if admins need to stop a campaign
   immediately.
5. **`getDailyCheckinStatus` response shape change** (PART K): direct
   breaking change vs. deprecation window. Recommendation: direct change
   (no external consumers of this internal API).
6. **`couponId` legacy column removal timing** (PART L step 5/6): kept for
   one release as a convenience mirror before final removal, to reduce the
   blast radius of the cutover commit — flagged as a judgment call that
   could instead be done in the same commit if preferred.
7. **UI copy/i18n** for streak/multi-reward display: out of scope for this
   design document; a follow-up for product/design once Phase 2
   implementation begins.
