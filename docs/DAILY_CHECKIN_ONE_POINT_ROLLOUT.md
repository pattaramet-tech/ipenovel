# Daily Check-in — 1 Point Rollout

Operational guide for switching the Daily Check-in reward from a daily
discount coupon to **exactly 1.00 point per successful Bangkok business-day
check-in**.

> **The reward does not change when you deploy.** Shipping this code leaves
> production on the legacy coupon. The switch happens at Bangkok midnight on a
> date an admin explicitly schedules, with no second deploy.

---

## 1. Architecture

Two configuration sources, deliberately kept apart:

| Source | Owns |
|---|---|
| `settings["daily_checkin_campaign"]` (legacy JSON) | The **global kill switch** (`isActive`) and the legacy coupon's discount settings. Carries **no** point configuration. |
| `dailyCheckinCampaigns` + `dailyCheckinRewardRules` (relational) | The **single source of truth** for the point reward: its amount and its Bangkok start date. |

Keeping the point amount out of the JSON blob is what makes "a deploy cannot
flip the reward mid-day" structurally true.

**Runtime resolution** — `server/services/dailyCheckinRewardModeService.ts`:

| Condition | Mode |
|---|---|
| Kill switch `isActive: false` | `disabled` (blocks **both** modes) |
| No campaign row, no point grants exist | `legacy_coupon` |
| No campaign row, but point grants already exist | `disabled` (`point_history_requires_safe_stop`) |
| Campaign `draft` or `startDate` in the future, no grants for it yet | `legacy_coupon` |
| Campaign `draft` or `startDate` in the future, but grants already exist for it | `disabled` (`point_history_requires_safe_stop`) |
| Campaign `active`, today within `[startDate, endDate]`, valid 1.00-point rule | `points` |
| Campaign ended / non-active / rule missing or malformed | `disabled` — **never** a silent fall back to coupons |

**Once any point has been granted, no configuration drift can resume coupon
issuance.** Every path that would otherwise return `legacy_coupon` — campaign
row missing, reverted to `draft`, or its `startDate` pushed back into the
future — checks for existing point grants first (globally, or scoped to that
campaign) and returns `disabled` instead if any are found. This holds even if
the drift happens by operator error or a bug, not just through the admin UI.

Both modes share `campaignKey = "default"`, so the existing
`UNIQUE(userId, checkinDate, campaignKey)` index means a coupon claimed
earlier on the cutover date still blocks a point claim later that same day.

**Claim transaction** (`claimDailyCheckin`, point mode) — one transaction:

1. `lockUserForPoints(userId, tx)` — `SELECT … FOR UPDATE` on `users`.
2. Re-read the check-in row **under the lock** (never trust the pre-lock fast path).
3. Read the balance once; compute the new `balanceAfter` with decimal-safe helpers.
4. Compute the consecutive Bangkok-date streak (see below).
5. Insert `dailyCheckins` (`couponId = NULL`) — **the race arbiter**, before any ledger write.
6. Insert `pointsTransactions` (`earn`, `1.00`, `referenceType = "daily_checkin"`, `referenceId = dailyCheckins.id`).
7. Insert `dailyCheckinRewardGrants` linking the check-in, the rule and the ledger row, with `streakCountAtGrant` set explicitly.
8. Commit.

All three rows commit or roll back together.

**Every points ledger writer** (Daily Check-in, order redemption/award, sports
vote/refund, admin adjustment) coordinates on the same `lockUserForPoints`
row lock via a shared `withUserPointsLock(userId, tx, fn)` helper — a writer
called with no open transaction gets one opened just for its own
read-balance/insert-transaction section, so no writer can lose an update to
a concurrent one for the same user.

**Two distinct balance fields — do not confuse them:**

| Field | Meaning |
|---|---|
| `rewards[].balanceAfterGrant` (point reward only) | The **historical** `balanceAfter` recorded on the linked `pointsTransactions` row at the moment of that grant. Fixed forever once written. |
| `pointsBalance` (top level of `getStatus`/`claim`) | The user's **current** balance, read fresh every time. |

A user who earned 1 point from today's check-in and later spent it shows
`rewards[0].balanceAfterGrant` unchanged (still reflecting the moment of the
grant) while `pointsBalance` reflects the spend. The UI card's
"คะแนนคงเหลือ X คะแนน" always uses `pointsBalance`, never
`balanceAfterGrant`.

**Streak calculation** (`calculateDailyCheckinStreak`) is exact for any
streak length, with no arbitrary cap. Rather than one unbounded query, it
pages backward through history in batches of 400 rows, walking each batch
date-by-date until it hits a genuine gap (which ends the streak) or runs out
of batches to fetch. A 1-day streak, a 400-day streak, and an 801-day streak
are all computed exactly, at a cost proportional to the streak length divided
by 400, never to the user's entire history.

---

## 2. Migration 0031

`drizzle/0031_enable_daily_checkin_point_rewards.sql` makes
`dailyCheckins.couponId` **nullable** — a point-only check-in mints no coupon,
so it has nothing to reference.

- Guarded via `information_schema` + `SET/PREPARE/EXECUTE/DEALLOCATE`, so a
  re-run (or a database where the column is already nullable) is a true no-op.
  This matters on TiDB, where a column-type change is a full **Reorg-Data**
  operation over every row.
- **No backfill.** No `UPDATE`, `DELETE`, `DROP`, `TRUNCATE` or `RENAME`.
  Existing `couponId` values are preserved exactly.
- The `unique_daily_checkins_coupon` index is **kept**. MySQL/TiDB allow many
  NULLs in a UNIQUE index, so unlimited point-only check-ins coexist while the
  index still prevents one coupon attaching to two check-ins.
- Migrations 0000–0030, their timestamps and their snapshots are untouched.

---

## 3. Pre-deploy checks

- [ ] `pnpm check`, `pnpm build` clean.
- [ ] `pnpm test:gate` reports **0 new failures**.
- [ ] `pnpm test:integration` green, including the 0031 and point-reward suites.
- [ ] Confirm production is at migration high-water **1784602000000** (0030) before deploying.
- [ ] Confirm `dailyCheckins` row count — the 0031 `ALTER` is a TiDB Reorg-Data operation; it is cheap on a small table, so know the size first.
- [ ] Confirm the kill switch (`daily_checkin_campaign.isActive`) is `true` if check-in should keep working.

Startup verification (`scripts/migrate.mjs`) fails closed if any of these are
missing after migration — the server will **not** listen:

`dailyCheckins.couponId` (present **and nullable**),
`dailyCheckinCampaigns`, `dailyCheckinRewardRules`, `dailyCheckinRewardGrants`
(incl. `pointsTransactionId` and `streakCountAtGrant`), and the reward-grant /
rule / campaign unique indexes.

---

## 4. Scheduling the rollout

**Admin → Settings → “Daily Check-in — 1 Point Rollout”.**

1. Pick a **future** Bangkok date (the server rejects today or earlier).
2. Confirm the dialog.
3. The panel then shows `กำหนดเริ่มรับ 1 คะแนนแล้ว (scheduled)` with the date.

This creates exactly one campaign (`campaignKey = "default"`, timezone
`Asia/Bangkok`, `endDate = 2099-12-31`) and one rule
(`ruleType = daily`, `rewardKind = points`, `pointsAmount = 1.00`,
`dedupeKey = daily:points`). Re-scheduling the same date is idempotent;
scheduling a *different* date while one is pending is rejected.

`pointsAmount`, `campaignKey`, `dedupeKey`, `ruleType` and `rewardKind` are
server-fixed constants — the API accepts only `startDate`.

### The Bangkok boundary

At `00:00:00 +07:00` on `startDate`, `getBangkokBusinessDate()` returns the new
date, the resolver returns `points`, and claims begin granting 1 point. **No
deploy, no restart, no manual step.**

A user who already claimed a **coupon** earlier on the cutover date keeps that
coupon, is not granted a point, and cannot claim again — enforced by the
unique index, not by application logic.

---

## 5. Smoke-test checklist (after the boundary)

- [ ] Admin panel shows current mode `รับ 1 คะแนน (1 point)`.
- [ ] A fresh test account sees `รับ 1 คะแนนเมื่อเช็กอินวันนี้` and no coupon copy.
- [ ] Claiming shows `เช็กอินสำเร็จ` / `ได้รับ 1 คะแนน` / `คะแนนคงเหลือ X คะแนน`.
- [ ] No coupon code is displayed anywhere for a point reward.
- [ ] A second claim the same day is refused politely (`เช็กอินวันนี้แล้ว`), no error toast.
- [ ] Points balance on the Points page increased by exactly 1.
- [ ] A user holding a pre-cutover coupon can still redeem it at checkout.

---

## 6. Rollback

### Before the first point grant

Cancel the schedule in the admin panel (allowed only while no grants exist and
the start date has not arrived). This removes the unstarted campaign and its
rule; legacy coupons continue untouched. Migration 0031 can stay applied — a
nullable column is harmless to the legacy flow.

### After point grants exist

**Cancellation is refused by design.** Use the **global kill switch**
(`daily_checkin_campaign.isActive → false`) to stop new claims.

- Points already granted stay in the ledger.
- Coupons already issued stay valid and redeemable.
- Status reads keep working; users still see what they earned.
- Coupon issuance does **not** silently resume — resuming it is an explicit
  future decision, not an automatic fallback.

### Absolute prohibitions

- ❌ Never `DELETE` from `pointsTransactions`.
- ❌ Never hand-edit a user's balance. `balanceAfter` is a materialized running
  balance; editing one row silently corrupts every later read.
- ❌ Never `DELETE` from `dailyCheckinRewardGrants` or `dailyCheckins`.
- ❌ Never revert `couponId` to `NOT NULL` once point rows exist — they hold NULL.
- ✅ If an over-credit is ever genuinely proven, issue a compensating
  `type: "adjust"` transaction with a correct `balanceAfter`. Never mutate history.

---

## 7. Read-only verification queries

All are `SELECT`-only and safe to run against a live database.

```sql
-- Current rollout configuration.
SELECT id, campaignKey, status, startDate, endDate, timezone
FROM dailyCheckinCampaigns WHERE campaignKey = 'default';

SELECT id, campaignId, ruleType, rewardKind, pointsAmount, dedupeKey, isActive
FROM dailyCheckinRewardRules WHERE dedupeKey = 'daily:points';

-- Has the rollout started granting yet?
SELECT COUNT(*) AS grantCount FROM dailyCheckinRewardGrants WHERE rewardKind = 'points';

-- Point grants per Bangkok date (expect at most one per user per date).
SELECT c.checkinDate, COUNT(*) AS grants
FROM dailyCheckinRewardGrants g
JOIN dailyCheckins c ON c.id = g.dailyCheckinId
WHERE g.rewardKind = 'points'
GROUP BY c.checkinDate ORDER BY c.checkinDate DESC LIMIT 30;

-- Integrity: every point grant must link to exactly one ledger row.
SELECT COUNT(*) AS orphanGrants
FROM dailyCheckinRewardGrants g
LEFT JOIN pointsTransactions p ON p.id = g.pointsTransactionId
WHERE g.rewardKind = 'points' AND p.id IS NULL;   -- expect 0

-- Integrity: no user may hold two check-ins on one Bangkok date.
SELECT userId, checkinDate, COUNT(*) AS n
FROM dailyCheckins GROUP BY userId, checkinDate, campaignKey HAVING n > 1;  -- expect empty

-- Migration state.
SELECT COUNT(*) AS applied, MAX(created_at) AS highWater FROM `__drizzle_migrations`;

-- couponId must be nullable after 0031.
SELECT IS_NULLABLE FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'dailyCheckins' AND column_name = 'couponId';
```

---

## 8. Related

- `server/services/dailyCheckinRewardModeService.ts` — mode resolution and rollout admin.
- `server/db.ts` — `claimDailyCheckin`, `getDailyCheckinStatus`, `calculateDailyCheckinStreak`.
- `client/src/components/dailyCheckinPresentation.ts` — card-state decisions (unit-tested).
- `server/daily-checkin-point-reward.integration.test.ts` — claim, balance, rollback, cutover, admin.
- `server/migration-0031-point-rewards.integration.test.ts` — fresh/upgrade/rerun/NULL-tolerance.
- `docs/INCIDENT_MIGRATION_0024_EPISODES_CONTENT.md` — why guarded, idempotent DDL matters on TiDB.
