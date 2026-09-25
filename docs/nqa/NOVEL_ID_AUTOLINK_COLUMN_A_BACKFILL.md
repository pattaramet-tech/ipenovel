# NQA — Novel ID Auto-Link + Google Sheet Column A Backfill Gate

## Purpose

Link one row in Google Sheet `รวมนิยาย` to canonical IpeNovel `novels.id` before Workspace Sync.

Operator flow: `Preview -> Confirm -> Column A Backfill -> Workspace Sync`.

The feature does not scrape `ipenovel.com/novel`; it uses the canonical application catalog.

## Canonical mapping

- Column A = canonical IpeNovel `novelId`
- Column B = novel title
- Spreadsheet title = `รวมนิยาย`
- Sheet tab = `นิยายยังไม่จบ/ยังไม่ยื่น`
- Runtime config also binds the exact spreadsheet ID

After backfill, Workspace uses numeric `novelId` directly and must not re-identify by title.

## Deterministic matching

`normalizeNqaNovelTitle()` uses Unicode NFKC, NBSP normalization, whitespace collapse, trim, and English case normalization only.

No embeddings, fuzzy distance, LLM judgment, or ranking are used.

Statuses:

- one normalized exact title -> `MATCH`
- zero exact candidates -> `NO_MATCH`
- multiple distinct exact candidate IDs -> `AMBIGUOUS`
- existing valid Column A -> `ALREADY_LINKED`
- existing invalid Column A -> `INVALID_EXISTING_VALUE`
- missing Column B title -> `MISSING_TITLE`

Only `MATCH` can proceed to confirmation.

## Preview and confirmation

Preview binds exact spreadsheet ID/title/tab, row, current A value, current B title, normalized title, candidate set, status, and matched novelId.

The preview fingerprint excludes the display timestamp, so unchanged evidence produces the same fingerprint.

MCP capabilities:

- `nqa.novel_link.preview`: READ / READ_ONLY
- `nqa.novel_link.confirm_backfill`: REMEDIATION / PRODUCTION_MUTATION

`REMEDIATION` is not in `NQA_V1_ENABLED_PERMISSION_TIERS`, so Column A mutation is disabled by default.

For MCP confirm:

- `target.row` = Sheet row
- `target.novelId` = selected canonical numeric novelId
- `inputFingerprint` = preview fingerprint
- authenticated principal = human confirmer
- request ID = authorization ID

The confirmation binds the fixed statement `I_CONFIRM_NQA_NOVEL_ID_BACKFILL` to the principal, row, sheet identity, preview fingerprint, novelId, title, and validity window.

## Stale preview protection

Before mutation the service regenerates the preview, verifies the unique candidate and catalog identity, then reads A:B once more immediately before write.

A must still be blank and B must still match. Any change fails closed.

## Narrow Google mutation boundary

The existing `NqaGoogleReadOnlyTransport` remains unchanged.

A separate `GoogleRestNovelIdSheetBackfillTransport` uses the full Sheets scope `https://www.googleapis.com/auth/spreadsheets` and constructs the destination internally as `'<sheet>'!A<row>`.

There is no caller-supplied arbitrary write range and no batch-update surface. A:B is read only for identity/freshness context.

## No overwrite

Existing valid A values return `ALREADY_LINKED`; invalid/manual values return `INVALID_EXISTING_VALUE`. This milestone has no overwrite override.

## Post-write verification

After PUT, A:B is read again. A must equal the confirmed novelId and B must still normalize to the confirmed title before a Sync-ready result is emitted.

Google Sheets does not provide application-level compare-and-swap for this cell write, so the implementation minimizes the race window with a fresh pre-write read and verifies immediately after write.

## Audit

Append-only events: `PREVIEW_CREATED`, `CONFIRMATION_ACCEPTED`, `BACKFILL_COMMITTED`, `BACKFILL_REJECTED`.

Audit evidence retains row/sheet identity, preview fingerprint, novelId, authorization ID, human authorizer ID, authorization fingerprint, write receipt, timestamp, and deterministic event fingerprint.

`JsonFileNqaNovelIdAutolinkAuditStore` writes create-only JSON event files. MCP gateway audit remains in addition to this domain audit.

## Workspace Sync handoff

Success returns `SYNC_READY` with row, numeric novelId, spreadsheet identity, `canonicalIdentity = novel:<id>`, row sourceKey, and committed audit fingerprint.

The autolink module does not call `bindPublicationNovel()` automatically. Workspace Sync remains a separate user-visible step.

## Isolation

This milestone does not scrape the web UI, use fuzzy/LLM matching, overwrite A, change the existing read-only Google transport, enable REMEDIATION by default, mutate Workspace automatically, change QA thresholds or M17-M21 history, touch `.tmp`, push, create a PR, or merge.

Recommended UI: `Link Novel ID -> Sync -> Check -> Confirm -> Publish`.
