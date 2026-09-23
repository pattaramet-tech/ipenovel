# M05 — Read-Only Google Bulk Intake Adapter

Status: COMPLETE
Date: 2026-09-24
Branch: feat/nqa-foundation

## Objective

M05 adds the first real Google-facing ingestion adapter for NQA.

The adapter reads configured Google Sheets rows and Google Docs metadata, converts rows into the M02 Source Contract, and exposes bounded read-only intake handlers through the M04 gateway boundary.

M05 does not perform semantic QA, identity merging, chapter resolution, or production mutation.

Architecture:

```text
NQA MCP Gateway / application caller
        ↓
Google Intake Handlers
        ↓
NqaGoogleBulkIntakeAdapter
        ↓
NqaGoogleReadOnlyTransport
        ↓
Google Sheets API + Google Docs API
```

The adapter remains callable without MCP.

## Live source contract verification

The current production Sheet was re-read before implementation.

Spreadsheet:

- title: รวมนิยาย
- spreadsheet ID: 1uUzDUt4McCQFADr4WFZ5NiRTUlg1hOafMLIyljzec7Y
- locale: th_TH
- timezone: Asia/Bangkok

Configured intake tab:

- title: นิยายยังไม่จบ/ยังไม่ยื่น
- sheetId: 0
- current observed rowCount: 3459
- columnCount: 26

Observed header A:K still labels column K as `หมายเหตุ`.

NQA therefore does not infer semantic meaning from the header label.
The C/E/K contract is configuration-driven by column position.

Configured M05 mapping:

- B = novel display title
- C = translation Google Doc
- E = optional web-source metadata
- K = prepared English source Google Doc

K remains mandatory for NQA V1.

## Current Row 1562 evidence

The canonical One Piece bundle is currently at row 1562:

`วันพีซ: ความทรงจำเนื้อเรื่องถูกลบ แต่ผมมีระบบนินจา 181 - 230`

Current C document:
`1gRxEHcLI3-e29E0jE0pWtGCGB1HlZm7opL-jcS9IyLQ`

The connected Google reader returned:
`PERMISSION_DENIED / HTTP 403`

Current K source document:
`1wXZBYJ9Eu586XajNw4R-Q768quKzHsJsIlK-KuWTB0Q`

The source document remained readable and returned the current Google Docs revision token captured in M02.

Design consequence:

- row syntax can parse successfully
- document accessibility is represented separately
- M05 does not silently convert a readable contract into semantic PASS
- M06 will own final intake PASS / REVIEW / FAIL policy

This preserves the distinction between routing validity and provider accessibility.

## Read-only OAuth contract

Required scopes:

- https://www.googleapis.com/auth/spreadsheets.readonly
- https://www.googleapis.com/auth/documents.readonly

Optional future metadata scope:

- https://www.googleapis.com/auth/drive.metadata.readonly

M05 runtime code does not require the optional Drive scope.

No mutation scope is declared.

Credentials and OAuth tokens are not stored in NQA source or audit records.
The transport accepts an injected access-token provider.

## REST transport

`GoogleRestReadOnlyTransport` implements only:

- getSpreadsheetMetadata
- batchGetValues
- getDocumentMetadata

Every HTTP request uses:
`method: GET`

There is no update, append, create, delete, batchUpdate, permission mutation, or file mutation method.

Document requests use:
`includeTabsContent=false`

Only document metadata, revision token, and tab properties are requested.
Full novel bodies are not read by M05.

## Provider error policy

Typed provider errors:

- AUTH_FAILURE
- PERMISSION_DENIED
- NOT_FOUND
- RATE_LIMITED
- TRANSIENT_PROVIDER_FAILURE
- MALFORMED_RESPONSE
- PROVIDER_ERROR

Retry policy:

- retry HTTP 429
- retry HTTP 5xx
- retry transport failures
- do not retry HTTP 401 / 403 / 404
- bounded attempts
- exponential bounded-delay hook

Tests inject a no-wait sleep function.

## Bounded bulk reads

Default safeguards:

- maxRowsPerScan = 200
- rowsPerBatchRange = 50
- documentConcurrency = 4
- maximum 20 A1 ranges per Sheets batch request

Larger scans are rejected before Google is called.

Rows are always reconstructed for the full requested interval, including empty trailing rows.

Column selection reads only the minimum contiguous column window required by configured B/C/E/K mappings.

## Request-local metadata cache

M05 deduplicates Google Doc metadata reads within one scan.

Each unique C or K document ID is read at most once per scan.

The cache is request-scoped only.

There is intentionally no cross-run persistent metadata cache yet, so M05 cannot silently override a newer live revision with stale cached metadata.

Persistent revision-aware caching is deferred until its invalidation contract is explicit.

## Row snapshot model

Each row snapshot contains:

- row number
- B/C/E/K routing values
- M02 parse result
- translation document access result
- prepared-source document access result

Document access is:

- READABLE with bounded metadata
- UNREADABLE with typed provider error code

No full chapter text is stored in the intake snapshot.

## MCP application handlers

M05 implements the existing M03 read capabilities:

- nqa.intake.get_row
- nqa.intake.scan_range
- nqa.intake.validate_contract
- nqa.intake.get_manifest

M04 gateway target now supports optional `rowEnd` for bounded scan ranges.

These capabilities remain READ_ONLY.

They do not require idempotency keys because they do not write QA state.

The request actor identity remains governed by the authenticated M04 principal.

No production HTTP or MCP listener is registered.

## M05 / M06 boundary

M05 owns:

- read-only Google transport
- bounded Sheet range reads
- C/E/K extraction
- Source Contract parsing
- document reachability and metadata
- provider error classification
- request-local dedupe
- read-only MCP handlers

M06 will own:

- stable novel identity
- alias/fuzzy candidate logic
- duplicate bundle detection
- final INTAKE_PASS / INTAKE_REVIEW / INTAKE_FAIL policy
- human-review routing for ambiguity

## Files

Production:

- server/nqa/google/contracts.ts
- server/nqa/google/transport.ts
- server/nqa/google/adapter.ts
- server/nqa/google/handlers.ts
- server/nqa/google/index.ts
- server/nqa/mcp/contracts.ts
- server/nqa/mcp/handlers.ts
- server/nqa/index.ts

Tests:

- server/nqa/google/transport.test.ts
- server/nqa/google/adapter.test.ts
- server/nqa/google/handlers.test.ts
- server/nqa/google/isolation.static.test.ts

## Isolation boundary

M05 does not modify:

- client/*
- server/routers.ts
- server/workspace/*
- Drizzle schema
- migrations
- package.json
- pnpm-lock.yaml

M05 performs no Google write operation.

M05 is complete.
