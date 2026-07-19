# Phase 5 — Daily Check-in Coupon Rewards

## PART A — Audit of the existing system (answers, from real code)

1. **Does a coupon system already exist?** Yes. `coupons` (generic coupon
   definitions: `code`, `discountType` (`flat`|`percentage`),
   `discountValue`, `minPurchaseAmount`, `maxUsageCount`, `usageCount`,
   `isActive`, `expiresAt`) and `couponUsages` (redemption tracking,
   `UNIQUE(couponId, orderId)`) in `drizzle/schema.ts`. Validation and
   discount math live in `server/services/orderService.ts`'s
   `validateAndApplyCoupon()`.
2. **Can a coupon be bound to a specific user?** Not on the `coupons`
   table itself (it's a shared code with a usage count, not
   user-scoped) - but there is an established **ownership-tracking
   pattern** for exactly this need: `sportsMatchRewards` (football
   prediction winnings) wraps a normal `coupons` row with a linking
   table that adds `userId`, `couponId`, and a `status`
   (`issued`|`used`|`expired`|`void`), created inside the same
   transaction as the coupon (`server/db.ts`'s `settleSportsMatch`).
   `validateAndApplyCoupon` and `getActiveCouponsForCart` both already
   check `sportsMatchRewards` to enforce "this reward coupon belongs to
   this user" and to hide other users' reward coupons from the coupon
   picker. This phase follows the exact same pattern for check-in
   rewards instead of inventing a new one.
3. **How is a coupon applied at checkout?** `CartPage.tsx` calls
   `checkout.activeCoupons` (→ `getActiveCouponsForCart`) to list
   coupons available to the current user/cart, and
   `checkout.validateCoupon` (→ `validateAndApplyCoupon`) to preview the
   discount for an entered code. `orderService.createOrderFromCart`
   re-validates and snapshots the normalized code onto the order
   (`couponCodeSnapshot`). Actual usage is only recorded at payment
   completion, in `finalizeOrderCompletion` (the single source of truth
   for both slip-upload and wallet payment flows): it calls
   `db.recordCouponUsage()` (idempotent insert into `couponUsages`,
   increments `coupons.usageCount`) and `db.markSportsRewardCouponUsed()`
   (flips the reward's `status` to `used`).
4. **Expiry and usage-count?** Yes, both already exist on `coupons`:
   `expiresAt` (nullable timestamp) and `maxUsageCount`/`usageCount`.
   `validateAndApplyCoupon` checks both.
5. **Is there a transaction that issues a coupon and creates a
   check-in-like record together?** Yes - `settleSportsMatch` is the
   precedent: `db.transaction(async (tx) => { ...insert coupon...;
   ...insert reward-tracking row...; })`, with an idempotency check
   ("does a reward already exist for this vote?") done *before* the
   coupon insert, all inside one transaction. This phase's `claimDailyCheckin`
   follows the same shape.
6. **Database**: MySQL via `mysql2` (`^3.15.0`) + `drizzle-orm`
   (`^0.44.5`), `mysqlTable` schema definitions in `drizzle/schema.ts`,
   migrations generated with `drizzle-kit generate` (established in
   Phases 3-4 of this project).
7. **UTC or local time in the DB?** All existing `timestamp` columns are
   plain UTC instants (no timezone-aware column type is used anywhere in
   this schema) - the app process itself also runs as UTC in production
   (confirmed via `NODE_ENV=production` server logs during Phase 3/4
   verification). Nothing in this repo currently derives a *business
   date* (as opposed to an instant) from a timestamp.
8. **Is there already an Asia/Bangkok helper?** No - grepped
   `server/**` for `Bangkok`/`timezone`/`Intl.DateTimeFormat`/
   `date-fns-tz`/`moment-timezone`: no matches. This phase adds the
   first one (`server/_core/timezone.ts`), and it is the *only* place
   in the codebase allowed to compute a Bangkok business date.
9. **Best UI location?** Home page (`client/src/pages/Home.tsx`) - it's
   the highest-traffic page, already has a `useAuth()`-aware layout and
   an established "section" structure to insert into (banner carousel →
   featured/popular → new → free → ...). A new `DailyCheckinCard`
   section is inserted right after the banner carousel, before Popular
   Novels, so it's above the fold for both logged-in and logged-out
   visitors without displacing existing content order.
10. **Risks to address before starting**:
    - `validateAndApplyCoupon`'s reward-ownership check and
      `getActiveCouponsForCart`'s reward-filter both query
      `sportsMatchRewards` **directly and by name** - adding a second
      reward-tracking table (for check-ins) without touching these two
      call sites would mean check-in coupons silently bypass ownership
      enforcement (any user could redeem anyone else's check-in coupon
      by code) and never appear in the cart's coupon picker. Both are
      generalized in this phase via one shared `db.getRewardCouponOwnership()`
      helper that checks every known reward-tracking table, so adding a
      third reward type later only requires extending that one helper.
    - The existing `coupons` table has **no discount cap** field -
      `validateAndApplyCoupon`'s percentage branch computes
      `subtotal * discountValue / 100` with no ceiling. The business
      rule for this phase ("5% off, capped at ฿10") cannot be expressed
      with the existing schema. A nullable `maxDiscountAmount` column is
      added to `coupons` (see PART C) - NULL preserves the exact
      existing behavior for every current coupon, so this is additive,
      not a breaking change.
    - `users` has no `isDisabled`/`banned` column - there is currently
      no account-disable mechanism anywhere in this codebase to check
      against, so PART I's "disabled account" concern has nothing to
      wire into. Noted as a limitation, not implemented as a new
      feature (out of scope for this phase).
    - There is no rate-limiting infrastructure anywhere in this
      codebase (grepped for `rateLimit`/`rate-limit`: no matches). Per
      this task's own instruction ("rate limit หาก repo มี infrastructure
      เดิม"), none is added - the DB-level UNIQUE constraint is the
      actual, authoritative defense against repeated claims, not a
      rate limiter.
    - The generic admin config framework (`settings` key/value table +
      `admin.settings.get`/`admin.settings.set`, already used by
      `server/_core/ocr-effective-config.ts` for OCR settings) is
      reused as-is for the check-in campaign config and kill switch -
      no new settings storage mechanism, no new large admin page.

## PART B — Business rules (v1), stored as one typed config

All numeric/behavioral rules live in exactly one place:
`server/_core/dailyCheckinConfig.ts`'s `DEFAULT_DAILY_CHECKIN_CONFIG`,
overridable at runtime via the existing `settings` table (key
`daily_checkin_campaign`) through `admin.dailyCheckin.updateConfig` -
no rule is hardcoded in the router, service, or UI layer.

| Rule | v1 value | Configurable? |
|---|---|---|
| Must be logged in | required | fixed (protectedProcedure) |
| Check-ins per day | 1 | fixed (the DB unique constraint) |
| Business date | Asia/Bangkok | fixed (single utility) |
| Reward | 1 coupon | fixed shape |
| Discount | 5% | `rewardPercent` |
| Max discount | ฿10 | `maxDiscountAmount` |
| Minimum purchase | ฿50 | `minPurchaseAmount` |
| Coupon validity | 7 days from issuance | `validityDays` |
| Uses per coupon | 1 (`maxUsageCount: 1` on the issued coupon) | fixed shape |
| Multiple days' coupons stack in the wallet | yes (each day issues a separate coupon row) | inherent to the design |
| One order uses at most 1 check-in coupon | yes - checkout already only accepts a single `couponCode` per order (existing `createOrderFromCart` signature takes one `couponCode: string`, not an array) | inherent, unchanged |
| Cannot be used on a ฿0 net order | yes - discount is computed against `subtotal` before the coupon is applied, and `validateAndApplyCoupon`'s existing `minPurchaseAmount` + percentage-cap math cannot itself produce a coupon that reduces a positive subtotal to a negative total (`Math.max(0, ...)` in `createOrderFromCart`); additionally, a coupon can only be *offered* against a subtotal that already clears `minPurchaseAmount` (฿50), so a ฿0 cart can never have a check-in coupon applied to begin with | inherited from existing checkout math, no new code needed |
| Cannot become cash/Wallet balance | yes - a coupon only ever reduces `discountAmount` on an order; nothing in this phase touches `walletAccounts`/`walletTransactions` | inherent, unchanged |
| Cannot be applied retroactively to an existing order | yes - `validateAndApplyCoupon` only runs during `createOrderFromCart` (order creation) and the cart-side preview; there is no "apply coupon to an existing order" endpoint anywhere in this codebase | inherent, unchanged |

## PART C — Data model

New table `dailyCheckins` (see `drizzle/schema.ts`):

```
id            int PK autoincrement
userId        int not null
checkinDate   varchar(10) not null   -- "YYYY-MM-DD", Bangkok business date, server-computed only
campaignKey   varchar(50) not null default "default"
couponId      int not null            -- FK-like: coupons.id, the issued coupon
status        enum("issued","used","void") default "issued" not null
issuedAt      timestamp default now() not null
usedAt        timestamp nullable
createdAt     timestamp default now() not null
updatedAt     timestamp default now() on update now() not null

UNIQUE (userId, checkinDate, campaignKey)   -- the idempotency guard
UNIQUE (couponId)                            -- 1:1 with the issued coupon
INDEX  (userId)
```

`checkinDate` is a `varchar(10)`, not MySQL's `DATE` type: this repo has
no existing `date`-type column anywhere (only `timestamp`), and a plain
"YYYY-MM-DD" string sidesteps any driver-level `DATE → JS Date` round-trip
reinterpretation entirely - what goes in is exactly what comes back out,
with no timezone reinterpretation possible at the storage layer. The
value is written **only** by `getBangkokBusinessDate()` (PART D) -
never accepted from the client.

`coupons` gets one new nullable column: `maxDiscountAmount` (decimal,
same precision as `discountValue`). `NULL` for every existing coupon
row (including every sports-match reward coupon already issued) - the
percentage-discount branch in `validateAndApplyCoupon` only applies the
cap `if (maxDiscountAmount != null)`, so this is purely additive and
changes the computed discount for **zero** existing coupons.

Migration: `drizzle/00XX_add_daily_checkin_and_coupon_cap.sql`,
generated with `drizzle-kit generate` (no live `DATABASE_URL` needed for
generation, only for `drizzle-kit migrate` - see Phase 3/4's established
workaround). Two `ALTER TABLE`/`CREATE TABLE` statements, both
additive - no column is dropped, resized, or retyped, no default is
changed on any existing column, no data backfill/rewrite of existing
rows is required. **Table lock risk**: `CREATE TABLE dailyCheckins` is
instantaneous (new table, no existing rows); `ALTER TABLE coupons ADD
COLUMN maxDiscountAmount ...` is an online DDL operation in MySQL
8/InnoDB (`ALGORITHM=INSTANT` is used automatically by MySQL 8.0.12+
for a nullable column append with no default requiring rewrite) - no
meaningful lock on a table of this size is expected. **Rollback plan**:
both changes are additive-only; reverting is `DROP TABLE dailyCheckins`
+ `ALTER TABLE coupons DROP COLUMN maxDiscountAmount` (a matching
down-migration is not auto-generated by drizzle-kit, but both
statements are trivial and safe to run by hand if ever needed - dropping
a nullable, all-NULL column loses no data that existed before this
phase).

**No duplicate/overlapping index was added.** Checked existing
`coupons`/`couponUsages` indexes before adding anything - `coupons_code_idx`
(unique on `code`) and `couponUsages_couponId_orderId_unique` already
cover their respective lookup patterns; nothing new was needed there.

Atomicity/idempotency (PART C items 2-5): `claimDailyCheckin` runs
entirely inside one `db.transaction()`. The coupon row is inserted
*before* the `dailyCheckins` row, in the same transaction; if the
`dailyCheckins` insert then fails on the `UNIQUE(userId, checkinDate,
campaignKey)` constraint (`errno 1062` / `ER_DUP_ENTRY` - the exact
error-detection pattern already used in `getOrCreateWalletAccount` and
elsewhere in `server/db.ts`), the whole transaction is rolled back,
which also undoes the just-inserted coupon - no orphan coupon is ever
left behind for a losing concurrent request. After rollback, a fresh
(non-transactional) read fetches the row the *winning* request created,
and that winner's coupon/status is returned to the loser as
`alreadyClaimed: true` - both concurrent callers converge on the same
single issued coupon, never two. See PART F for the full sequence.

## PART D — Timezone correctness

`server/_core/timezone.ts` exports exactly one function relevant to
business-date logic:

```ts
export function getBangkokBusinessDate(at: Date = new Date()): string // "YYYY-MM-DD"
```

Implemented with `Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok",
year: "numeric", month: "2-digit", day: "2-digit" })` - Node's built-in
ICU (no `date-fns-tz`/`moment-timezone` dependency needed; verified in
this sandbox that arbitrary IANA zones resolve correctly, not just
`en-US`/UTC). `en-CA`'s locale formatting is already `YYYY-MM-DD`, so no
manual field reordering/string surgery is needed - one library call, one
sanity-checked format.

This is deliberately **not** `new Date().toISOString().slice(0, 10)`
(which is UTC, not Bangkok - the failure mode called out in the task
brief) and **not** a manually-computed `+7` hour offset anywhere (a
scattered-guess pattern this task explicitly forbids) - every caller
that needs "today" in Bangkok terms calls this one function, including
the test suite. Verified boundaries (in
`server/daily-checkin.test.ts`, pure function tests, no DB needed):

- `16:59:59Z` → previous Bangkok day (23:59:59 Thai time)
- `17:00:00Z` → next Bangkok day (00:00:00 Thai time) - the exact
  UTC↔Bangkok (+7, no DST) boundary
- A UTC-process assumption is never made anywhere else: the function
  takes a `Date` (always a true instant, not a wall-clock string) and
  delegates all zone math to `Intl`, so it is correct regardless of
  what timezone the Node process itself runs in (verified via
  `TZ=UTC` explicitly in the test run, matching this repo's actual
  production process).

Thailand has no DST, so no seasonal-transition edge case exists to test
- the only boundary that matters is the fixed +7:00 offset, covered
  above.

## PART E/F — API and coupon integration

See `server/routers.ts`'s `dailyCheckin` router and
`server/services/dailyCheckinService.ts`. `getDailyCheckinStatus` and
`claimDailyCheckin` are both `protectedProcedure` (no `userId` ever
accepted from the client - always `ctx.user.id`). `claimDailyCheckin`
is idempotent in its *result*: calling it twice on the same Bangkok day
returns `{ claimed: false, alreadyClaimed: true, ... }` the second time,
never a second coupon, never an error for the "already done today" case
(that's an expected, successful outcome, not a client error).

Coupon validation/redemption reuses the existing engine untouched in its
math: `validateAndApplyCoupon` (percentage-with-cap logic added, see
PART C) and `finalizeOrderCompletion` (extended with one more
`markDailyCheckinCouponUsed` call, mirroring the existing
`markSportsRewardCouponUsed` call already there) - no discount formula
is duplicated in the daily-checkin service, the router, or the frontend.
The frontend never computes a discount; it only displays the reward
summary text the server returns.

## PART G — UI

`client/src/components/DailyCheckinCard.tsx`, mounted in
`client/src/pages/Home.tsx` right after the banner carousel. States:
unauthenticated (login CTA, reuses `getLoginUrl()`), loading, claimable,
already-checked-in-today (shows the coupon just claimed/claimed earlier
today, its expiry, and its code), error+retry. Double-click is guarded
client-side (button disables itself immediately on click, `isPending`
from the mutation) as a UX nicety only - the actual correctness
guarantee is 100% server-side (the transaction + unique constraint in
PART C), matching this task's explicit instruction not to rely on the
frontend for correctness.

## PART H — Configuration and kill switch

Reuses the existing generic `settings` table + `admin.settings.get`/
`admin.settings.set` (already present, already admin-gated) exactly the
way `server/_core/ocr-effective-config.ts` already does for OCR
settings - same shape: a typed interface, one JSON blob under one
settings key (`daily_checkin_campaign`), a `DEFAULT_...` fallback, a
`getEffective...Config()` resolver, and a `validate...Config()` guard.
Two small `adminProcedure` mutations/queries
(`admin.dailyCheckin.getConfig`/`updateConfig`) are added, mirroring
the existing `admin.settings.getOCRSettings`/`updateOCRSettings` pair -
this is a couple of procedures, not a new admin page.

**Kill switch**: `isActive: boolean` in the config, default `true`.
Setting it to `false` (via `admin.dailyCheckin.updateConfig` or a
direct `admin.settings.set` call with the same key) makes
`claimDailyCheckin` reject *new* claims with a clear "campaign is
currently disabled" result - it does **not** touch any
already-issued coupon's `status`/`expiresAt`, so coupons already in a
user's hands keep working exactly as issued until their normal expiry.
To change it: call the existing `admin.settings.set` mutation with
`key: "daily_checkin_campaign"` and a JSON `value` (or use the two new
typed `admin.dailyCheckin.*` procedures for validated updates).

## PART I — Security / abuse prevention

See the full list cross-referenced against this implementation in the
deliverable report below. Summary of the controls: DB unique constraint
(not a rate limiter, not a frontend disable) is the sole arbiter of
"one check-in per user per Bangkok day"; `userId` is always
`ctx.user.id`, never client input; reward-coupon ownership is enforced
server-side on every redemption attempt via `getRewardCouponOwnership`;
coupon codes are unguessable random tokens (mirrors the existing
`buildRewardCouponCode` pattern, not a sequential/predictable ID);
`maxUsageCount: 1` + the transactional `status` flip at redemption time
bound double-spend risk to the same pre-existing, documented race window
that already exists for *any* single-use coupon in this codebase (not
newly introduced by this phase - see the note in the deliverable); IP
address is never used as an identity/authorization signal anywhere in
this feature.

## Deliverable report

1. **Audit of the existing coupon/order system**: see PART A above -
   `coupons`/`couponUsages` engine already existed, along with an
   established "reward-coupon ownership" pattern (`sportsMatchRewards`)
   that this phase's `dailyCheckins` table follows, and a
   settings-table-backed admin config pattern
   (`server/_core/ocr-effective-config.ts`) that this phase's
   `dailyCheckinConfig.ts` follows.
2. **Business rules actually implemented**: exactly the v1 table in
   PART B - login required, 1 check-in/Bangkok-day, 1 coupon (5% off,
   capped at ฿10, ฿50 minimum purchase, 7-day expiry, single use),
   multiple days' coupons stack, one coupon per order (inherited from
   the existing single-`couponCode`-per-order checkout shape), never
   usable on a already-zero/negative order, never convertible to
   cash/Wallet balance, never retroactive.
3. **Data model**: new `dailyCheckins` table (see PART C) +
   `coupons.maxDiscountAmount` (new nullable column). No other schema
   changes.
4. **UNIQUE constraints/indexes**: `UNIQUE(userId, checkinDate,
   campaignKey)` on `dailyCheckins` (the idempotency guard),
   `UNIQUE(couponId)` on `dailyCheckins` (1:1 with the issued coupon),
   `INDEX(userId)`. Checked existing `coupons`/`couponUsages` indexes
   first - nothing overlapping was added.
5. **Transaction boundary**: `claimDailyCheckin` - one
   `db.transaction()` spanning the coupon insert and the `dailyCheckins`
   insert; a duplicate-key error on the second insert rolls back both.
6. **Timezone strategy**: one function, `getBangkokBusinessDate()`
   (`server/_core/timezone.ts`), `Intl.DateTimeFormat` with
   `timeZone: "Asia/Bangkok"` - never a manual offset, never called from
   more than this one place plus its sibling `getNextBangkokDayStart()`.
7. **Idempotency strategy**: fast-path SELECT (optimization only) +
   DB unique-constraint-as-arbiter + catch-1062-and-re-read-the-winner
   (the same `errno === 1062 || code === "ER_DUP_ENTRY"` detection
   already used elsewhere in `server/db.ts`, e.g.
   `getOrCreateWalletAccount`). Verified under real concurrent load in
   `server/daily-checkin.test.ts`'s "concurrent claims... resolve to
   exactly one issued coupon" test (DB-guarded).
8. **Coupon validation/redeem flow**: unchanged existing engine
   (`orderService.validateAndApplyCoupon` /
   `orderService.finalizeOrderCompletion`), extended in two additive
   ways - a `maxDiscountAmount` cap on percentage coupons (NULL-safe for
   every pre-existing coupon), and reward-ownership checks/used-marking
   generalized to also cover `dailyCheckins` (via the new shared
   `db.getRewardCouponOwnership()`) alongside the existing
   `sportsMatchRewards` path. No discount math was duplicated anywhere
   else (not in the router, not in the frontend).
9. **Security/abuse protections**: see PART I below for the full
   checklist.
10. **UI added**: `client/src/components/DailyCheckinCard.tsx`, mounted
    on `Home.tsx` right after the banner carousel. States: loading,
    error+retry, unauthenticated (login CTA), claimable, already-checked-
    in-today (coupon code + expiry shown). Verified all 6 states plus
    accessibility/mobile via Playwright (PART K below).
11. **Configuration/kill switch**: `server/_core/dailyCheckinConfig.ts`,
    stored under the existing generic `settings` table (key
    `daily_checkin_campaign`), editable via two new `adminProcedure`s
    (`admin.dailyCheckin.getConfig`/`updateConfig`) that mirror the
    existing OCR-settings pair - no new admin page. `isActive: false`
    stops new claims without touching already-issued coupons (verified
    in `server/daily-checkin.test.ts`).
12. **Migration files**: `drizzle/0027_add_daily_checkin_and_coupon_cap.sql`
    (`CREATE TABLE dailyCheckins`, `ALTER TABLE coupons ADD
    maxDiscountAmount`, one new index) - generated via `drizzle-kit
    generate` (offline, no live `DATABASE_URL` needed for generation,
    matching the Phase 3/4 workflow), then the auto-generated filename
    and journal tag were renamed to match this repo's descriptive-name
    convention.
13. **Migration risk / table lock risk**: both statements are additive
    only (new table; nullable column append with no default requiring a
    rewrite - `ALGORITHM=INSTANT`-eligible on MySQL 8.0.12+). No column
    dropped/resized/retyped, no existing-row backfill, no meaningful
    lock expected on a table this size. See PART C for the rollback
    plan (both changes are trivially reversible - `DROP TABLE`/`DROP
    COLUMN` - since nothing is backfilled or destructive).
14. **Tests added**: `server/daily-checkin.test.ts` - 25 tests total.
    11 run unconditionally (no DB needed): timezone boundary
    correctness (4), `getNextBangkokDayStart` (1), campaign config
    validation (4), unauthenticated `claim` rejection + public
    `getStatus` (2). 14 are DB-guarded (`if (!db) return`, no-op
    without `DATABASE_URL`, run for real wherever one is configured):
    first claim succeeds, duplicate same-day claim doesn't double-issue,
    concurrent claims resolve to one coupon, two users check in
    independently, a prior day's check-in doesn't block today's, the
    kill switch blocks new claims without a DB write, coupon ownership
    enforcement, ฿50 minimum purchase, 5% discount math, the ฿10 cap,
    rounding, expired-coupon rejection, used-coupon rejection, and
    discount-never-exceeds-subtotal.
15. **`pnpm check`**: passed, no errors.
16. **`pnpm test`**: 897 passed / 200 failed / 224 skipped - the 200
    failures are identical in count and identity to the pre-existing
    Phase 4 baseline (all pre-existing DB-connectivity failures in
    files unrelated to this phase, confirmed by diffing the total
    against the Phase 4 run); the +25 passing tests are exactly this
    phase's new file. Isolated run of `daily-checkin.test.ts` alone:
    25/25 passed.
17. **`pnpm build`**: succeeded (same pre-existing analytics-env-var and
    >500kB-chunk warnings as every prior phase, unrelated to this
    change).
18. **Playwright / production-like verification**: production build +
    `NODE_ENV=production node dist/index.js`, curl-verified: anonymous
    `dailyCheckin.getStatus` → `{"authenticated":false}` (200, no
    error); anonymous `dailyCheckin.claim` → 401 UNAUTHORIZED with a
    generic message (no DB internals in the error body); `/`, `/novels`,
    `/novels?page=2`, `/sitemap.xml`, `/robots.txt` all 200. Dev-server
    Playwright run (mocked tRPC, since no live DB in this sandbox):
    **12/12 checks passed** - unauthenticated login CTA + working login
    link, claim button visible and accessible by its own visible text
    (no aria-label mismatch, applying the exact lesson learned in
    Phase 4), successful claim transitions to the already-checked-in
    card with the coupon code shown, already-checked-in-on-load state,
    error+retry state (waited out react-query's real default retry
    backoff, not a shortcut), rapid double-click produces at most one
    claim request, and the card renders correctly with no horizontal
    overflow at a 375px mobile viewport. The Phase 3/4 regression script
    (Home/Novel-Detail/My-Novels/Admin) was re-run against the same dev
    server with this card mounted: **10/10 still pass**, unchanged.
19. **Deliberately not implemented** (explicitly out of scope per the
    task brief): 7-day streak tracking, calendar animations, lucky
    draw, push notifications, referral rewards, multi-tier missions,
    IP-based rate limiting (no such infrastructure exists in this repo,
    and the task explicitly says not to use IP as a primary authority
    anyway), any new large admin page (the two new admin procedures
    reuse the existing generic settings admin surface), and an
    account-disable check (this codebase has no `isDisabled`/`banned`
    column on `users` to check against - noted as a limitation in PART
    A rather than invented as a new feature this phase didn't ask for).
    Also explicitly **not** fixed: the pre-existing, architecture-wide
    TOCTOU race for *any* single-use coupon in this codebase (a coupon
    is validated at order-creation time but its `usageCount` is only
    incremented at payment-approval time, so two concurrent orders
    could theoretically both pass validation before either is approved)
    - this predates this phase, applies equally to sports-match reward
    coupons, and fixing it would mean touching the shared payment-
    approval pipeline broadly, which is out of scope for "don't affect
    the payment system."
20. **Compatibility confirmation**: `getActiveCouponsForCart` and
    `validateAndApplyCoupon`'s reward-ownership checks were generalized
    (not rewritten) to also check `dailyCheckins` - existing behavior
    for every sports-match reward coupon is unchanged (same query
    result, just routed through one shared helper instead of an inlined
    query). `coupons.maxDiscountAmount` is NULL for every pre-existing
    coupon, so the new cap branch in `validateAndApplyCoupon` never
    fires for them. No change to Wallet, Cart, Orders, Purchases,
    Reader, Admin dashboards, or the payment/approval pipeline beyond
    the two additive `markDailyCheckinCouponUsed`/ownership-check calls
    described above. Regression-verified live (PART K, item 18).
21. **Secret scan**: confirmed none in this document, the diff, or any
    file added/changed for this phase (no `.env.local` or credentials
    were committed - the temporary one created for Playwright
    verification was deleted before finalizing).
22. **Commit hash**: see the commit this section was pushed with.
23. **Pushed to `origin/main`**: yes.

---
No secrets appear in this document or in any file added/changed for
this phase.
