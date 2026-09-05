# Preview legacy-slip reference audit — read only

## Scope and authority

This one-off tool investigates ten approved records whose database reference was
reported as `TRUSTED_LEGACY` and whose exact legacy R2 prefix contained one candidate.
It does **not** approve/reject payments, change references, insert claims/bindings,
upload/delete objects, run migrations, or mark backfill/dependency completion.
There is no apply/live mode, and this report is **not an executable apply manifest**.
Do not resume IPE-013 as a consequence of running it.

Fixed targets (no range, limit, or additional-target option):

- `order_payment` / `payments`: 11280001, 11310001, 11340002, 11340004, 11370001.
- `wallet_topup` / `walletTopups`: 180001, 210001, 240001, 270001, 300001.

Control payment 10020002 (already private, two objects) and pending payment 82350007
are excluded. No duplicate candidate is selected by filename, date, size, or ETag.

## Run in the Preview APPLICATION terminal

The terminal must have the new script and its imported helper files, Node, `tsx`,
`mysql2`, and the S3 SDK. A terminal for the database container is not suitable.
This tool is not wired to application startup or deploy hooks. Installing the code
does not mean an audit has run. Do not paste SQL or Node code into the wrong shell.

```sh
node --import tsx scripts/audit-legacy-slip-references.ts --help
node --import tsx scripts/audit-legacy-slip-references.ts --dry-run --confirm-preview
```

Alternatively, from the repository:

```sh
npm run audit:legacy-slip-references -- --dry-run --confirm-preview
```

`--help` works without environment settings and without loading DB/storage clients.
No mode defaults; missing, duplicate, unknown, `--live`, `--apply`, `--limit`, and
completion flags fail before I/O. Do not reuse flags from the backfill script.

Use existing **Preview** process environment values; no `.env` file is loaded.
Never paste credentials or full environment output into a chat or issue.

The guard requires `DATABASE_URL` to be `mysql:` with the exact Preview hostname
`z71vl8sxkolha3jf644qgsgr`, port 3306 (or omitted), database `ipenovel`, and credentials.
Query-string options, fragments, and alternate transports are rejected. Changing
the guard for another environment requires a separate code review.

Required private storage settings:

- `R2_PRIVATE_ACCOUNT_ID`
- `R2_PRIVATE_ACCESS_KEY_ID`
- `R2_PRIVATE_SECRET_ACCESS_KEY`
- `R2_PRIVATE_ENDPOINT` (valid matching Cloudflare R2 HTTPS endpoint)
- `R2_PRIVATE_BUCKET_NAME` (must equal `ipenovel-staging-private`)
- Optional `R2_PRIVATE_SIGNED_URL_EXPIRES_SECONDS` (default 900; configuration
  validation only — the tool makes authenticated SDK reads, not signed/public URL requests).

Public `R2_*` credentials are not a fallback. Keep bucket public access disabled.
Prefer credentials restricted to SELECT and private object read/list where available;
the code issues only those operations even when existing credentials allow more.

## What is checked

1. Read a source, its owner, at most 21 binding rows and 21 same-source claim rows
   using SELECTs with a 5-second query timeout. More than 20 related rows blocks.
   No transaction or row lock is opened; destroy the connection before R2 I/O.
2. Only inspect approved, unbound `legacy_compatibility_required` sources with a
   trusted legacy HTTPS URL (the existing exact CloudFront origin). Never fetch it.
3. List only the exact source-type/id prefix with `MaxKeys: 20`, no pagination.
   Truncation, unexpected names, or multiple candidates blocks any download.
   Zero-byte directory markers are ignored, but no data object is deleted.
4. Download at most one candidate, conditional on the listed ETag via `IfMatch`.
   The GET ETag, declared size, and actual byte count must agree. ETag is a
   concurrency token, **not a file hash**. SDK retries are disabled. Each LIST and
   combined GET/body read has a 10-second timeout; actual bytes are capped at 5 MiB.
5. Stream raw SHA-256 and the existing canonical `SHA256(bytes + "slip:file:v1")`
   from identical complete bytes. JPEG/PNG/PDF detection is **signature-only**,
   not full decoding, OCR, or proof the slip represents a genuine bank transfer.
6. Re-read current source/owner/binding/claim fields via a new connection after I/O.
   Any observed snapshot change blocks a repair proposal. The run has a cooperative
   180-second budget checked between operations; an in-progress bounded read may
   finish beyond that budget. Unattempted targets remain reported as blocked.
7. A proposal requires the persisted extraction's valid canonical hash to match,
   a positive current evidence version, and `extractedEvidenceVersion` equal to it.
   The parser permits at most three JSON decodes for legacy string wrappers.
   Missing, malformed, unversioned, stale, raw-only, or mismatched hashes never
   become verified through an ID-prefix match alone. Contradictory same-source
   claim owners/hashes also block.

## Interpreting output

Output is sanitized NDJSON: one result per fixed target, followed by a summary.
It contains counts, safe status/version fields, detected type/size, and fixed codes.
It contains **no** URLs, object keys, ETags, file hashes, owner IDs, extracted OCR
JSON, raw SDK/SQL errors, or credentials. Do not enable SDK/debug SQL logging.

- `action: REVIEW_REFERENCE_REPAIR`: identity and the local gates passed; request
  independent review. It is **not permission to write**.
- `action: NONE`: inspect the fixed `blockers` codes; no repair proposal is made.
- `SOURCE_HASH_MISSING`, `EVIDENCE_VERSION_UNPROVEN`, or
  `EXTRACTED_VERSION_MISMATCH`: the R2 candidate may be readable but original
  evidence identity is not proven. Additional provenance is needed, not a bypass.
- `HASH_FORMAT_REVIEW`: only raw SHA-256 matches; investigate historical hash
  format/version provenance. Do not overwrite the hash or claim it is canonical.
- `AMBIGUOUS_CANDIDATES`, `SOURCE_CHANGED`, `OBJECT_VERSION_CHANGED`, or
  `IDENTITY_MISMATCH`: stop for that record; do not choose another object automatically.
- All results have `writeAuthorized: false`, `pointInTimeOnly: true`, and
  `claimCheckScope: SAME_SOURCE_ONLY`. This is not a cross-source replay/collision audit.

Exit codes: 0 = all ten have review proposals, 1 = at least one blocked/skipped/
unproven record, 2 = arguments, configuration, or fatal execution error.
Exit 0 is **not** completion of reference repair, backfill, payment refactoring,
or production readiness. Unit-test fixtures are not live Preview evidence.

## Required stop and later work

Share the sanitized report for independent review, then stop. No reference repair
or backfill write is authorized by this run. A future, separately authorized repair
must establish any missing original-file provenance, check cross-source claim
collisions, revalidate the DB and object state, preserve immutable evidence, and
use guarded updates with an approved exact before/after plan. An old audit report
cannot substitute for fresh validation. Only then can a new backfill dry-run
measure remaining coverage; ten recovered samples cannot prove all 2,225 earlier
transient failures are repaired.
