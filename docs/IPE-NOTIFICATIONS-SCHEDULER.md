# IpeNovel Notifications — External One-Shot Scheduler (Candidate Contract)

Status: **PROPOSED / NOT IMPLEMENTED IN ANY DEPLOYED ENVIRONMENT**. This
document is the activation contract for the R40R59 recommendation
(external one-shot scheduler). The CLI binary IS implemented and
qualified locally (R40R66); **no cron entry, Coolify scheduled task or
deployment change exists anywhere** and none may be created without
Owner approval.

## Command

**Production (built artifact — requires `pnpm build` first):**

```
node dist/notifications-tick.js
```

**Local test (source, separate from production):**

```
# disposable channel (TEST_DATABASE_URL -> ipenovel_test, live-verified)
DEPLOYMENT_ENVIRONMENT=local-test TEST_DATABASE_URL=mysql://...@127.0.0.1:3313/ipenovel_test NOTIFICATIONS_ENABLED=true NOTIFICATIONS_DELIVERY_ENABLED=true npx tsx scripts/notifications-tick.ts
```

The two channels are mutually exclusive: production uses the built
artifact with `DATABASE_URL`; the local test channel uses
`TEST_DATABASE_URL` and a live `DATABASE() = ipenovel_test` verification
through `ensureVerifiedTestDb()`. Never point one channel's variables at
the other channel's database.

## Behavior

- Exactly ONE delivery tick (claim ≤ `DEFAULT_DELIVERY_LIMITS.maxEvents`
  events, deliver ≤ `maxRecipientsPerEvent` recipients each, checkpoint,
  complete/retry/dead-letter) then the process EXITS.
- Exit codes: `0` = disabled / busy / completed, `1` = failed
  (sanitized error; lease fencing protects correctness — the next
  successful tick resumes), `130` = terminated by SIGTERM/SIGINT while a
  tick was in flight.
- Kill switch evaluated BEFORE any database access:
  `NOTIFICATIONS_ENABLED=true` AND `NOTIFICATIONS_DELIVERY_ENABLED=true`
  are both required; anything else exits 0 `{status:"disabled"}`.
- Deployment identity gate (R40R66R2) — runs after the kill switch, before
  any database access, ONLY when delivery is enabled:
  - `DEPLOYMENT_ENVIRONMENT=production-staging` routes through the repo's
    own `assertProductionStagingDatabaseIsolation()` — `DATABASE_URL` must
    resolve to the approved staging identity and differ from Production
    (fingerprints required, collisions refused).
  - `DEPLOYMENT_ENVIRONMENT=local-test` routes through the disposable test
    channel (`TEST_DATABASE_URL`, live `DATABASE() = ipenovel_test`
    verified via `ensureVerifiedTestDb()`). A Production-shaped
    `DATABASE_URL` is IGNORED on this channel — there is no
    `DATABASE_URL` fallback (R40R66R3).
  - A missing or unknown deployment context FAILS the run (exit 1) — a
    missing context never skips the check. `production` as a channel is
    deliberately unreachable today (staging-first rollout).
- Catalog fanout and check-in reminders remain independently default-OFF
  (`NOTIFICATIONS_CATALOG_FANOUT_ENABLED`,
  `NOTIFICATIONS_CHECKIN_REMINDERS_ENABLED`).

## Staging activation plan (requires Owner approval per step)

1. Apply migration 0067 to the qualified staging DB (0066 must already be
   applied — journal 0065 → 0066 → 0067).
2. Set `NOTIFICATIONS_ENABLED=true` and
   `NOTIFICATIONS_DELIVERY_ENABLED=true` on staging only; catalog and
   check-in gates stay OFF.
3. Schedule the command at a modest frequency (suggested: every 1–5
   minutes; a single tick is bounded: ≤10 events, ≤100 recipients/event,
   single-digit seconds on the qualification container).
4. Observe for one delivery cycle before touching production.

## Monitoring

- Outbox state surface (SQL):
  `SELECT state, COUNT(*) FROM notificationOutbox GROUP BY state;`
  (`pending` backlog, `leased` in-flight, `dead_letter` needs operator)
- Dead-letter inspection: rows with `state='dead_letter'` keep
  `lastFailureCode` (sanitized: `DELIVERY_ERROR` |
  `PERMANENT_DELIVERY_ERROR`).
- CLI stdout is one JSON line per invocation (`status`, per-state counts)
  — suitable for Coolify/container log ingestion.

## Multi-replica / restart safety

- Claim uses `FOR UPDATE SKIP LOCKED` + a random `leaseToken` with a
  5-minute lease; two schedulers (or a redeploy racing a tick) cannot
  double-deliver. An expired lease is reclaimable by the next tick.
- A SIGTERM/SIGINT mid-tick exits 130; the abandoned lease is reclaimed
  after expiry and the tick replays idempotently (unique
  `(event, user)` recipients, dismissed tombstones never revived).

## Rollback

- Remove the cron/scheduled task — delivery stops immediately (no state
  to rewind; pending rows simply wait).
- Or set `NOTIFICATIONS_DELIVERY_ENABLED=false` (tick exits `disabled`)
  without removing the schedule.
- Application rollback is independent: the additive 0067 schema is safe
  for builds that predate notifications.

## Qualification evidence (R40R66 + R40R66R1/R2/R3, local disposable MySQL 8)

- Unit: `server/notifications/tickCli.test.ts` (25) — kill switch +
  fixed flags snapshot (2); channel routing (2: local-test →
  `ensureVerifiedTestDb` never falls back to `DATABASE_URL`,
  production-staging → `getDb`); one-shot semantics (3); deployment
  identity negative matrix (7: missing context / unknown env /
  unreachable production channel / missing TEST_DATABASE_URL / missing
  fingerprints / fingerprint collision / DATABASE_URL resolving to the
  Production identity); graceful shutdown (2: signal mid-tick exits 130,
  never downgraded by the sanitization catch); error sanitization (9:
  5 secret shapes never emitted, JWT → `[redacted-token]`, drizzle
  SQL+params dropped while driver `code`/`errno`/`sqlState` survive,
  wrapped driver cause preserved).
- Spawn E2E on the real command:
  `server/notifications/tickCliSpawn.integration.test.ts` (3) — disabled
  gates deliver nothing; enabled gates deliver a seeded real event to a
  real recipient and a re-tick is idempotent; **no-fallback proof**
  (R40R66R3): a Production-shaped UNREACHABLE `DATABASE_URL` alongside a
  verified `TEST_DATABASE_URL` still delivers through the test channel
  only — any `DATABASE_URL` fallback would fail the whole tick instead,
  and the production identity never appears in operator output.
- Production artifact runs: `node dist/notifications-tick.js` — disabled
  exit 0 without DB access; enabled-but-missing deployment context
  exits 1 with the sanitized refusal; enabled exit 0 delivering a seeded
  real event on the disposable DB (outbox `completed`, attempt 1, lease
  released; idempotent re-run verified).
- Deeper delivery semantics: s6DeliveryInbox (21), s6DeliveryRace (12),
  s6ControlledRuntime (15), s6NotificationAtomicity (8),
  s6WalletTopupFinancialSafety (9), s6PurchaseOrderRealDb (3),
  couponNotificationE2E (2), session race (30) — all green on the merged
  tree.
