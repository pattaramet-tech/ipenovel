# scripts/vps-migration/

Safe, read-only tooling for the Manus/Cloud → VPS (Coolify + MariaDB) migration described in `docs/VPS_MIGRATION_RUNBOOK.md`. Everything in this directory:

- **Never connects to a database automatically.** Nothing here opens a network connection or a MySQL/MariaDB client connection on its own.
- **Never writes anything** — no `DROP`/`TRUNCATE`/`DELETE`/`UPDATE`/`INSERT`, no migration execution, no file writes beyond the operator's own shell redirection.
- **Never prints a secret value** — env var checks report presence/absence and non-secret shape (host/port/database name) only.

If you need something that actually talks to a database, run the queries in `snapshot-schema.sql` yourself with your team's normal DB client and save the output — these scripts only work with files you produce that way.

## Files

### `preflight.mjs`

A read-only sanity check for a deployment target (run it locally against a `.env` you're about to hand to Coolify, or inside the container after deploy). Checks:

- Which of the four hard-required env vars (`DATABASE_URL`, `JWT_SECRET`, `VITE_APP_ID`, `OAUTH_SERVER_URL`) are present — **names only**.
- `DATABASE_URL` parses as a URL, and reports its host/port/database name — **never the password, never the full string**.
- Whether each optional feature's env var group (R2 public, R2 private, OAuth portal, Forge/OCR, Discord webhook) is fully configured, partially configured, or absent — again, presence only.
- The running Node version and the pnpm version pinned in `package.json`'s `packageManager` field.
- Whether the expected build artifacts (`dist/index.js`, `dist/public/index.html`) exist on disk.
- Whether `drizzle/*.sql` migration files and `drizzle/meta/_journal.json` are consistent with each other (surfaces the same "files not tracked by the journal" class of issue documented in the Runbook's Database Compatibility Audit).

Requires an explicit `--ack-read-only` flag or it exits 1 without doing anything — this is deliberate friction so it's never wired into an automated pipeline without a human having read what it does first.

```sh
node scripts/vps-migration/preflight.mjs --ack-read-only
```

### `compare-snapshots.mjs`

Compares two **JSON snapshot files** you already produced (see "Snapshot file format" below) — one from the source database, one from the target. It never connects to either database itself.

```sh
node scripts/vps-migration/compare-snapshots.mjs source-snapshot.json target-snapshot.json
```

Exits `0` if every check marked `"policy": "exact"` matches between the two snapshots and the `migrationTags` sets are identical. Exits non-zero (and prints every mismatch) if any exact-match check differs — this is the condition the Cutover checklist (`docs/VPS_MIGRATION_CHECKLIST.md` P4) treats as a stop-the-cutover signal. Checks marked `"policy": "informational"` are reported but never cause a non-zero exit.

### `snapshot-schema.sql`

Every read-only validation query from `docs/VPS_DATA_VALIDATION.md`, collected into one runnable file with section headers matching that document's numbering. Run it (in full, or section by section) against a database with your normal SQL client; there is no write statement anywhere in it. This file is the query *source* — `docs/VPS_DATA_VALIDATION.md` is the query *documentation* (rationale for each check, exact-match policy, orphan/duplicate/entitlement reasoning). Keep them in sync if either changes.

## Snapshot file format

A snapshot is a JSON file you assemble by hand (or with your own throwaway script — not provided here, since that would need real DB credentials, which this PR's scope explicitly excludes) from the results of `snapshot-schema.sql`'s queries:

```json
{
  "label": "source-production-tidb-2026-08-01T12:00:00Z",
  "takenAt": "2026-08-01T12:00:00Z",
  "checks": {
    "users_count": { "value": 12345, "policy": "informational" },
    "admins_count": { "value": 3, "policy": "exact" },
    "approved_orders_count": { "value": 4200, "policy": "exact" },
    "approved_orders_total": { "value": "1234567.89", "policy": "exact" },
    "approved_payments_count": { "value": 4200, "policy": "exact" },
    "purchases_count": { "value": 9800, "policy": "exact" },
    "episode_purchases_count": { "value": 1500, "policy": "exact" },
    "episode_purchases_total": { "value": "45678.00", "policy": "exact" },
    "wallet_balance_total": { "value": "98765.43", "policy": "exact" },
    "approved_topups_count": { "value": 900, "policy": "exact" },
    "approved_topups_credited_total": { "value": "112233.00", "policy": "exact" },
    "coupons_count": { "value": 50, "policy": "informational" },
    "coupon_usages_count": { "value": 2100, "policy": "exact" },
    "daily_checkins_count": { "value": 6000, "policy": "informational" }
  },
  "migrationTags": ["0000_needy_anthem", "0001_steep_romulus", "...all 33 journal tags..."]
}
```

Notes:

- `value` may be a number or a string. Financial sums are best passed as **strings** (e.g. `"1234567.89"`) to sidestep any floating-point round-off from however your SQL client serializes `DECIMAL` — `compare-snapshots.mjs` normalizes both to a fixed-precision comparison either way, so either form works, but strings are safer for anything money-related.
- `policy` is `"exact"` (must match exactly, or the cutover is blocked) or `"informational"` (reported, never blocking). Every financial `SUM`, every entitlement `COUNT`, and the migration tag set should be `"exact"` — see `docs/VPS_DATA_VALIDATION.md`'s "Exact-match policy" section for the authoritative list. If you omit `policy` entirely, `compare-snapshots.mjs` treats it as `"exact"` (the safer default) and warns you to make it explicit.
- The keys shown above correspond to `snapshot-schema.sql`'s §1 (overall reconciliation summary). You can add more checks (per-table row counts, orphan-check row counts, etc.) with any name you like — `compare-snapshots.mjs` compares whatever keys exist in `checks`, not a fixed schema.
- `migrationTags` should list every `tag` from `drizzle/meta/_journal.json`'s `entries` array that the database being snapshotted has actually applied (per §14's discovery query) — order doesn't matter, it's compared as a set.

## What this directory deliberately does NOT do

- It does not connect to Production or any live database, ever, from inside this repo/sandbox.
- It does not export, dump, or copy any real customer/financial data.
- It does not run migrations against anything.
- It does not embed or require any real credential, connection string, or secret value — every example above uses placeholder numbers.

If you need an automated snapshot-producing script that *does* connect to a database, that is a deliberate, separate decision outside this PR's scope (per the constraints in `docs/VPS_MIGRATION_RUNBOOK.md`) — build and review it explicitly, with its own credential-handling review, rather than extending these files to do it silently.
