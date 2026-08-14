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
- **Compare-and-swap on every DB write (step 8).** The final write is a
  conditional `UPDATE ... WHERE id = ? AND <column> = ?` (see
  `updatePaymentSlipUrlIfUnchanged`/`updateWalletTopupSlipUrlIfUnchanged`/
  `updateSportsMatchImageUrlIfUnchanged` in `server/db.ts`), requiring the
  column to still hold the EXACT value read at candidate-discovery time -
  never just the row id. If the source value changed (e.g. the user
  re-submitted a new slip, or an admin edited the row) or the row was
  deleted while a slow download/upload was in flight, the write matches
  zero rows and is reported as failed (`SOURCE_CHANGED_OR_ROW_MISSING`) -
  the current value is never overwritten. For payment/wallet slips (Private
  R2), the just-uploaded object is then also deleted as best-effort cleanup
  (`deletePrivateObject`, the one existing, exact-key-only delete primitive
  for that bucket). Sports images (Public R2) have no equivalent delete
  primitive available today, so a CAS-lost sports upload can leave a
  harmless orphaned object in Public R2 (a public, non-sensitive image,
  unreferenced by any DB row) - correct DB preservation is intentionally
  prioritized over avoiding this orphan.
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

## Mode selection: DRY RUN vs LIVE — fails closed, no default mode

Every invocation of the CLI must pass **exactly one** of two mode flags.
**No mode flag = script refuses to run.** It exits non-zero before any
database or R2 access is even attempted — there is no implicit/default
mode, live or otherwise.

```
DRY RUN:   --dry-run
LIVE:      --live  +  an EXPLICIT --type=payments|wallet|sports
```

- `--dry-run` — preview only, no upload, no DB write. `--type` defaults to
  `"all"` and `--type=all` is allowed here.
- `--live` — writes to R2 and the DB. Requires an **explicit**
  `--type=payments|wallet|sports` — there is no default type for a live
  run, and **`--live --type=all` is rejected outright** (a live run always
  migrates exactly one asset class at a time; this also avoids the
  unrelated-id-space `--start-id` hazard `--type=all` has, documented under
  "Resume procedure" below).
- Passing **both** `--dry-run` and `--live` together is rejected.

### Dry-run procedure

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

### Live migration procedure

There is deliberately **no npm script shortcut for a live run** (unlike
`migrate:legacy-manus-assets:dry`) — the documented Production live command
is always the full, explicit CLI invocation below, so the operator always
sees (and consciously types or pastes) exactly what mode and asset class
they're about to run:

```bash
tsx scripts/migrate-legacy-manus-assets-to-r2.ts --live --limit=20 --type=payments
tsx scripts/migrate-legacy-manus-assets-to-r2.ts --live --limit=20 --type=wallet
tsx scripts/migrate-legacy-manus-assets-to-r2.ts --live --limit=20 --type=sports
```

Always run the matching `--dry-run` command first (see above) and review
its output before running the equivalent `--live` command — see "Warnings"
below.

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

## Resume procedure (LIVE only — see "Dry-run coverage" below for --dry-run)

The script is safe to stop (Ctrl-C) and restart at any time.

**PRIMARY RESUME PROCEDURE FOR `--live`: rerun the exact same command, with
the same `--start-id` value.** A **successfully migrated** row no longer
contains the Manus hostname, so it's automatically excluded (`already
migrated`) on the next run — this naturally reveals the next batch of
still-eligible rows, no bookkeeping required. A **failed** row is left
completely unchanged, so it's automatically retried (still `eligible`) on
the next run too.

**This "rerun the same command" advice applies ONLY to `--live`.**
`--dry-run` never writes anything — not to R2, not to the DB — so
re-running the exact same `--dry-run --limit=N --start-id=M` command
re-validates the SAME first `N` eligible rows again, every time. It does
**not** advance on its own. See "Dry-run coverage" immediately below for
how to actually preview further rows.

**`--start-id=N` is only an explicit LOWER-BOUND FILTER** for an operator
who has independently verified that every relevant row below `N` is already
migrated or intentionally out of scope. It is **not** a resume cursor, and
must never be derived from the last-processed id or the reported "remaining"
count — doing so can **permanently skip rows**. Concretely:

- **A sports match has three independent image columns.** If a `--limit`
  cutoff stops partway through `sportsMatch #28` (say, its `home` column
  migrates but `away`/`cover` haven't been reached yet) and the operator
  resumes with `--start-id=29`, `away` and `cover` for id `28` are skipped
  forever — they still have id `28`, which is now below the new
  `--start-id`. Rerunning with the *same* `--start-id` instead finds them
  normally, since `home` is now `already_migrated` and no longer counts
  against `--limit`.
- **`--type=all` (dry-run only — `--live` always requires a single,
  explicit `--type`) draws from three tables whose ids are unrelated to
  each other.** If the last row previewed under `--dry-run --type=all`
  happens to be `payments #50` and the operator sets `--start-id=51` for
  the next preview, any still-eligible `walletTopups` or `sportsMatches`
  row with an id below 51 (e.g. `walletTopups #12`) is silently skipped —
  its id has nothing to do with `payments #50`'s id.
- **A failed row keeps its original (possibly low) id forever.** If
  `payments #3` fails (e.g. a transient network error) while `payments #50`
  succeeds, advancing `--start-id` to anything above 3 — even if it "looks
  done" because everything reported this run succeeded — permanently
  excludes `payments #3` from every future run.

If you must scan only part of a table across multiple invocations (e.g. a
very large one-off backfill), only ever raise `--start-id` after
independently confirming (via the dry-run/validation procedures below) that
every row below the new value is genuinely done — never simply because a
previous run "got that far".

### Dry-run coverage (how to preview MORE rows, since --dry-run never advances on its own)

`--dry-run` mutates nothing — no upload, no DB write — so re-running the
exact same `--dry-run --limit=N --start-id=M` command always re-validates
the SAME first `N` eligible rows, forever; it will never "pick up where it
left off" the way a `--live` run does. The CLI's own "Not processed this
run" message says so explicitly when this applies. To actually preview more
rows:

- **Raise `--limit`** (e.g. `--limit=20` → `--limit=100` → `--limit=500`)
  to preview more rows in a single dry-run call.
- **Dry-run one asset class at a time** — `--type=payments`, then
  `--type=wallet`, then `--type=sports` — instead of `--type=all`, so each
  preview stays focused and its row count is easier to reason about.
- `--start-id` remains only a manually-verified lower-bound filter here
  too, exactly as described above — never derive a new value from a
  previous dry-run's "remaining" count.

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
- **Possible orphaned Public R2 object.** If a sports-image row's source
  value changes concurrently between candidate discovery and the final
  write, the compare-and-swap DB write is skipped (see "Compare-and-swap on
  every DB write" above) but the already-uploaded WebP object stays in
  Public R2 — there is no existing delete primitive for that bucket to
  clean it up safely. This is treated as an acceptable, low-risk outcome: it
  is a public, non-sensitive image with no DB row pointing at it, not a
  security or data-integrity issue, and correct DB preservation is more
  important than avoiding it. (Payment/wallet slips, which use Private R2,
  get a best-effort delete of the exact just-uploaded object in this same
  scenario, since a safe delete primitive already exists for that bucket.)

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
