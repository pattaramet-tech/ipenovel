# Legacy Manus Asset Migration to Cloudflare R2

Moves the remaining assets still hosted on the legacy Manus CloudFront CDN
(`d2xsxph8kpxj0f.cloudfront.net`) onto Cloudflare R2:

- **A. Payment/wallet slips** (`payments.slipImageUrl`, `walletTopups.slipImageUrl`) → **PRIVATE** R2 (`r2p:<key>` references, same bucket/convention as newly-submitted slips)
- **B. Sports match images** (`sportsMatches.homeTeamImageUrl`/`awayTeamImageUrl`/`coverImageUrl`) → **PUBLIC** R2 (same bucket/convention as novel covers/banners)

It also removes the last runtime dependency on the Manus storage proxy for
*new* uploads: `admin.sportsMatches.uploadImage` now uploads straight to
Public R2 instead of calling `storagePut()` (see Part C below).

Implementation:
- `server/services/legacyManusAssetMigrationService.ts` — all migration logic
- `scripts/migrate-legacy-manus-assets-to-r2.ts` — CLI wrapper (argv parsing + console output only)
- `server/routers.ts` (`admin.sportsMatches.uploadImage`) — Part C

This is **operator-run only**. Nothing in this migration runs automatically
during `pnpm install`, `pnpm build`, server startup, deployment, or a
database migration (`pnpm db:migrate`/`pnpm db:push`).

## Confirmed production inventory (at time of writing)

| Column | Manus CloudFront refs | Unique URLs |
|---|---|---|
| `payments.slipImageUrl` | 2,142 | 2,142 |
| `walletTopups.slipImageUrl` | 652 | 652 |
| `sportsMatches.homeTeamImageUrl` | 28 | 28 |
| `sportsMatches.awayTeamImageUrl` | 28 | 28 |
| `sportsMatches.coverImageUrl` | 28 | 28 |
| **Total** | **2,878** | **2,878** |

Already safe / out of scope for this migration (left untouched):

| Column | Count | Status |
|---|---|---|
| `novels.coverImageUrl` | 282 | already on Public R2 / `media.ipenovel.com` |
| `banners.imageUrl` | 4 | already on Public R2 / `media.ipenovel.com` |
| `episodes.fileUrl` | 2,433 | Google Docs links, unrelated storage |
| `payments.slipImageUrl` | 212 | already migrated/new, `r2p:` (Private R2) |
| `walletTopups.slipImageUrl` | 57 | already migrated/new, `r2p:` (Private R2) |

One unrelated anomaly (`episode id=3210001`, `fileUrl` classification
`UNKNOWN`) is explicitly **not** touched by this migration — it isn't a
Manus CloudFront reference and is out of scope.

## Source → target mapping

| Source | Hostname required | Target | New DB value |
|---|---|---|---|
| `payments.slipImageUrl` | exactly `d2xsxph8kpxj0f.cloudfront.net` (https only) | Private R2, `payment-slips/legacy/payments/<payment-id>/...` | `r2p:<key>` |
| `walletTopups.slipImageUrl` | exactly `d2xsxph8kpxj0f.cloudfront.net` (https only) | Private R2, `payment-slips/legacy/wallet-topups/<topup-id>/...` | `r2p:<key>` |
| `sportsMatches.homeTeamImageUrl` | exactly `d2xsxph8kpxj0f.cloudfront.net` (https only) | Public R2, `sports-matches/legacy/<match-id>/home/...` | `${R2_PUBLIC_BASE_URL}/<key>` |
| `sportsMatches.awayTeamImageUrl` | exactly `d2xsxph8kpxj0f.cloudfront.net` (https only) | Public R2, `sports-matches/legacy/<match-id>/away/...` | `${R2_PUBLIC_BASE_URL}/<key>` |
| `sportsMatches.coverImageUrl` | exactly `d2xsxph8kpxj0f.cloudfront.net` (https only) | Public R2, `sports-matches/legacy/<match-id>/cover/...` | `${R2_PUBLIC_BASE_URL}/<key>` |

A value is **only** migrated if its hostname is an **exact** match for
`d2xsxph8kpxj0f.cloudfront.net` over **https**. Everything else is left
completely untouched, including:

- `r2p:` references (already Private R2)
- `media.ipenovel.com` / `${R2_PUBLIC_BASE_URL}` values (already Public R2)
- any other external URL (e.g. `docs.google.com`)
- relative or malformed values
- a lookalike hostname such as `d2xsxph8kpxj0f.cloudfront.net.attacker.example` — hostname matching is exact-equality on the parsed URL's `hostname`, never a prefix/suffix/substring check

Payment slips (image or PDF) are stored **byte-for-byte unchanged** — never
optimized, resized, or re-encoded, since they're financial evidence. Sports
images are optimized to WebP using the same `optimizeImageToWebp()` pipeline
(and the same `SPORTS_MATCH_IMAGE_PRESET`) as a freshly-uploaded sports
image, so a migrated image and a new upload always look identical.

## Safety guarantees

- **Fail closed, per row.** Every row is its own unit: strict sequence is
  (1) validate hostname → (2) download → (3) validate response →
  (4) enforce size ceiling → (5) validate MIME/content → (6) upload to the
  correct R2 bucket → (7) verify the upload → (8) **only then** update that
  one DB column → (9) continue. If any of steps 1–7 fail, that row's DB
  value is **never** touched, and the row is reported as failed.
- **The legacy Manus source is never deleted.** This migration only ever
  reads from Manus and writes to R2/the DB — no delete call to Manus (or
  anywhere else) exists in this code path.
- **No unbounded downloads.** HTTPS-only, hostname must exactly equal
  `d2xsxph8kpxj0f.cloudfront.net`, `redirect: "error"` (never follows a
  redirect), a fetch timeout, a `Content-Length` pre-check, and a hard
  streamed-byte ceiling enforced independently of any header. A response
  whose declared `Content-Type` doesn't match its actual byte content
  (magic-number check) is rejected too.
- **No provider-independent scope creep.** Only three tables/five columns
  are ever written: `payments.slipImageUrl`, `walletTopups.slipImageUrl`,
  and `sportsMatches.{homeTeamImageUrl,awayTeamImageUrl,coverImageUrl}` —
  one column per row, nothing else (no status/amount/OCR/review field is
  ever touched, no schema/migration change, no `episodes` row is ever
  touched).
- **No unsafe force mode.** There is no `--force` flag. A row is
  re-classified fresh on every run — once migrated, its DB value no longer
  has the Manus hostname, so it's naturally excluded from the next run.
- **Sequential processing.** Rows are processed one at a time, in ascending
  `id` order — no concurrent fan-out. 2,878 assets total is a manageable
  size where safety matters far more than speed.
- **Privacy-safe logging.** Logs and CLI output use only safe identifiers
  (`payment #123`, `walletTopup #456`, `sportsMatch #789 home`) and fixed
  failure-reason codes (e.g. `TOO_LARGE`, `UNSUPPORTED_TYPE`) — never a full
  slip URL, a signed query string, a private R2 object key, OCR-extracted
  data, or any credential. The migrated Private R2 reference for a slip is
  deliberately never printed, even on success.

## Dry-run procedure

Dry-run downloads and validates each eligible row (and, for sports,
optimizes it) — the exact same steps 1–5 (and the WebP conversion for
sports) as a live run — but stops **before** uploading to R2 or writing to
the DB, so it's an accurate check that the source asset is real and
decodable.

```bash
pnpm migrate:legacy-manus-assets:dry
# equivalent to:
tsx scripts/migrate-legacy-manus-assets-to-r2.ts --dry-run --limit=20 --type=all
```

Useful variations:

```bash
tsx scripts/migrate-legacy-manus-assets-to-r2.ts --dry-run --limit=50 --type=payments
tsx scripts/migrate-legacy-manus-assets-to-r2.ts --dry-run --limit=50 --type=wallet
tsx scripts/migrate-legacy-manus-assets-to-r2.ts --dry-run --limit=50 --type=sports
tsx scripts/migrate-legacy-manus-assets-to-r2.ts --dry-run --limit=50 --type=sports --column=cover
```

Dry-run never requires R2 to be configured (no upload is attempted), but
does require `DATABASE_URL` to be set to the database you want to preview
against.

## Recommended batch sizes

Start small and increase once confident:

1. `--limit=20` (default) — verify a handful migrate cleanly, spot-check the
   results.
2. `--limit=100` per type once the first batch looks correct.
3. `--limit=250`–`500` per type for the bulk of the run.

Given 2,878 total assets, a handful of `--limit=250` batches per type
comfortably completes the whole migration. There is no need to raise this
beyond a few hundred per invocation — sequential processing means a very
large `--limit` mostly just makes one run take longer, with no additional
safety benefit.

## Resume procedure

The script is safe to stop (Ctrl-C) and restart at any time:

- A **successfully migrated** row no longer contains the Manus hostname, so
  it's automatically excluded (`already migrated`) on the next run — no
  `--start-id` bookkeeping is required to avoid re-migrating it.
- A **failed** row is left completely unchanged, so it's automatically
  retried (still `eligible`) on the next run.
- `--start-id=N` is available for explicitly paginating through a very
  large batch across multiple invocations (skip rows already known to be
  below `N`), but is not required for correctness — only for controlling
  how much of the table a single invocation scans.

To continue where a previous run's `--limit` cut off, either re-run the same
command (already-migrated rows are skipped automatically) or use the
reported "not processed this run" count together with `--start-id` to jump
ahead.

## Validation procedure

After a batch (dry-run or live), the CLI prints:

```
Checked / Already migrated / Out of scope / Eligible / Migrated (or Would migrate) / Failed / Remaining
```

For a live run, spot-check a few `[OK]` rows:

- **Payments/wallet**: confirm the payment/top-up's slip still displays
  correctly in the admin review UI (which resolves `r2p:` references to a
  fresh signed URL) — never confirm by reading the raw DB value directly in
  a shared channel, since even the `r2p:` reference is treated as
  unnecessary-to-log.
- **Sports**: confirm the new `https://media.ipenovel.com/sports-matches/legacy/...` URL
  loads directly.

Any `[FAILED]` row is safe to leave as-is (it still points at the original
Manus URL, so the asset keeps working exactly as it did before this
migration) and can be retried later.

## Rollback philosophy

There is no automated rollback, by design:

- A row is only ever overwritten **after** its new asset is confirmed
  uploaded — so a "rollback" only matters if the **new** value turns out to
  be wrong in some way not caught by validation (extremely unlikely, since
  slips are stored byte-for-byte and sports images are decoded before
  upload).
- The legacy Manus asset is **never deleted** by this migration, so the
  original source remains available as a reference for as long as Manus
  itself is still reachable.
- If a specific row needs to be reverted, that is a manual, deliberate DB
  update (restoring the original Manus URL for that one row) — this
  migration intentionally does not attempt to automate reverting a
  successful write, since a bulk automated rollback carries more risk than
  the narrow, already-rare failure mode it would exist to fix.

## Warnings

> **Do not delete any legacy file from Manus** until the migration has been
> independently verified (spot-checked results above, plus a broader sample
> once a full run completes). This migration only ever reads from Manus.

> **Live migration must be run only after explicit approval** from
> whoever owns this rollout. Always run `--dry-run` first, on the same
> `--type`/`--limit`/`--start-id` you intend to run live, and review its
> output before proceeding.

No credentials are included in this document. `DATABASE_URL` and the R2
env vars (`R2_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/
`R2_BUCKET_NAME`/`R2_PUBLIC_BASE_URL`/`R2_ENDPOINT` for Public R2;
`R2_PRIVATE_ACCOUNT_ID`/`R2_PRIVATE_ACCESS_KEY_ID`/
`R2_PRIVATE_SECRET_ACCESS_KEY`/`R2_PRIVATE_BUCKET_NAME`/`R2_PRIVATE_ENDPOINT`
for Private R2) must already be available in the shell environment where
the script runs — this document does not manage or reference their values.
