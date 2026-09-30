# IPE-059-A — Novel TXT/ZIP Export Contract

Status: implemented (backend/core only; no UI). UI integration is **IPE-059-B**, scheduled after IPE-058-F stabilizes.

## Source authority

Export reads **canonical published content only**: `episodes` rows with `isPublished === true` and the inline `episodes.content` column — the exact same persisted text the web reader serves via `readerService.getReaderEpisode`. Workspace Drafts, editor buffers, Checker/QC/Approval/Stage state are never read. No schema was added or changed.

## Modules

```text
server/services/novelExport.domain.ts     pure serializer (no DB): ordering, filename safety, manifest CSV, TXT/ZIP
server/services/novelExport.service.ts    DB access, selection enforcement, limits, audit logging
server/routers/novelExportRouter.ts       admin-only tRPC endpoints (wired under admin.novelExport in server/routers.ts)
```

## API (all `adminProcedure` — anonymous → FORBIDDEN, non-admin → FORBIDDEN)

- `admin.novelExport.preview` `{ novelId, episodeIds? }` → item count, skipped items, estimated bytes, limits. No content over the wire.
- `admin.novelExport.downloadTxt` `{ novelId, episodeId }` → `{ filename, mimeType: "text/plain; charset=utf-8", contentBase64, byteCount }`
- `admin.novelExport.downloadZip` `{ novelId, episodeIds? }` → `{ filename, mimeType: "application/zip", contentBase64, byteCount, itemCount, totalPlaintextBytes, entryFilenames, skippedItems }`
- `admin.novelExport.limits` → active limit constants.

Transport decision: base64 inside tRPC, mirroring the existing `admin.importPackageZip` flow. `MAX_EXPORT_ZIP_BYTES` (24MB) keeps base64 output (~32MB) below the 50MB Express JSON body limit. Audit logging via `[Admin] novelExport.*` console lines with counts/bytes only — novel text is never logged.

## Selection semantics

- Whole novel: every published episode of one novel.
- Explicit subset (`episodeIds`): never broadened; unknown ids, ids from another novel, duplicate ids, unpublished members and members without canonical content fail closed with typed errors.
- Missing-content policy: whole-novel exports **skip-and-report** legacy rows without inline content (`skippedItems`, reason `MISSING_CONTENT`); explicit subsets fail closed.

## TXT contract

UTF-8, no BOM, LF newlines (CRLF/CR normalized), content bytes = the same `normalizeExportText` output used inside ZIP entries. Filename: zero-padded canonical identity (`001.txt`, `001-050.txt`; minimum width 3, no truncation). No timestamps, no HTML, no presentation metadata injected.

## ZIP structure

```text
<sanitized-novel-title>.zip      (fallback novel-<id>.zip; Windows-safe)
├── manifest.csv
└── contents/
    ├── 001.txt
    ├── 001-050.txt
    └── ...
```

Entries are stored by adm-zip in lexicographic name order (deterministic). Duplicate identity spellings (e.g. episodes `1` and `001`, which the DB unique key on raw `episodeNumber` permits) get a stable `001__ep<episodeId>.txt` suffix — never a silent overwrite.

## manifest.csv

UTF-8 no BOM, LF line endings, exact header:

```text
episodeNumber,episodeTitle,price,isFree,isPublished,saleMode,contentFile,contentFormat,sortOrder,description
```

All columns are ones `packageZipImportService` reads through its `HEADER_ALIASES` (canonical normalized spellings, 1:1). RFC-style quoting for commas/quotes; `isPublished` is always `true` (published-only export). Known parser-contract deviation (deliberate, forced by the existing parser): `parseCsvManifest` is line-oriented, so titles/descriptions containing newlines are **flattened to single lines** (newline/tab → single space) instead of RFC multi-line quoted fields. Content newlines live untouched in the `.txt` entries.

## Determinism

Same canonical input ⇒ identical manifest bytes, identical TXT bytes, identical entry names/order, and **byte-identical ZIP** (every entry's timestamp is overwritten with `FIXED_ZIP_TIMESTAMP` = 2000-01-01T00:00:00Z via `entry.header.time`, since adm-zip defaults to the current wall clock). Verified by test.

## Round-trip guarantee

Exported ZIP parses through the existing `parsePackageZip` with zero errors **for package-mode rows**: episodeNumber (raw spelling preserved), title, price, isFree, saleMode (`package`), contentFile resolution, and TXT bytes all round-trip exactly (proven in `novelExport.roundTrip.test.ts`, parser/preview only — no DB writes).

Known limitation (existing importer contract, not an exporter defect): the package ZIP import flow rejects `saleMode = "chapter"` rows. Chapter-mode episodes are still exported (full-fidelity admin backup); re-importing them through this specific flow is rejected with the parser's own validation. Likewise two published episodes whose episodeNumbers normalize to the same range (e.g. `1` + `001`) will be reported `DUPLICATE_IN_BATCH` by the importer — data that predates and is outside IPE-059-A.

## Resource limits (fail closed, typed `NovelExportError`)

| Constant | Value |
| --- | --- |
| `MAX_EXPORT_ITEMS` | 500 |
| `MAX_EXPORT_PER_ITEM_BYTES` | 8MB (mirrors importer's `MAX_TXT_SIZE_BYTES`, so exports always pass re-import) |
| `MAX_EXPORT_TOTAL_BYTES` | 40MB |
| `MAX_EXPORT_ZIP_BYTES` | 24MB |

Error codes: `EXPORT_NOVEL_NOT_FOUND`, `EXPORT_EMPTY_SELECTION`, `EXPORT_UNKNOWN_EPISODE`, `EXPORT_EPISODE_NOT_IN_NOVEL`, `EXPORT_DUPLICATE_SELECTION`, `EXPORT_EPISODE_MISSING_CONTENT`, `EXPORT_INVALID_EPISODE_IDENTITY`, `EXPORT_INVALID_SALE_METADATA`, `EXPORT_LIMIT_ITEMS`, `EXPORT_LIMIT_ENTRY_BYTES`, `EXPORT_LIMIT_TOTAL_BYTES`, `EXPORT_LIMIT_ZIP_BYTES`, `EXPORT_UNSAFE_PATH`.

## Handoff to IPE-059-B

- Call `admin.novelExport.preview` first; render `exportItemCount`, `skippedItems`, `estimatedPlaintextBytes` before download.
- Decode `contentBase64` to a Blob and trigger a client-side download with the returned `filename` and `mimeType` (server-side `Content-Disposition` is not applicable to the tRPC transport).
- Do not modify the domain/service contract without re-running `novelExport.roundTrip.test.ts`.
