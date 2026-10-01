# IPE-059-B — Thai-Novel Export UI Integration Contract

Status: implemented on top of IPE-058-F UX (`ddfa87e`) with the verified IPE-059-A core cherry-picked in (`60a6619`, from `d4aed30c`). **Not production-qualified until IPE-058-G closes and B is re-qualified on the final integration baseline.** No schema migration, no IPE-058-G mutation, no deploy.

## Two export modes (never blended)

1. **Thai-Novel Upload** (default) — flat upload-ready TXT files for the Thai-Novel portal.
2. **IpeNovel Backup / Re-import** — the IPE-059-A package (`manifest.csv` + `contents/*.txt`), round-trip-proven through `parsePackageZip`. Unchanged from A.

## Thai-Novel TXT contract (per file)

```text
<final title>\n
\n
<canonical body>\n
```

- First physical line = title, then the **proven blank separator line** (legacy working exporter wrote `title + "\n\n" + content` — preserved deliberately; do not change to single `\n` without portal evidence).
- Body = canonical published content, LF-normalized, UTF-8, no BOM, Thai/emoji intact.
- No manifest/header metadata inside TXT files.

## Numbering

- Portal order = filename order. Generated names are sequential: canonical source order first (`sortExportItemsCanonical`: singles ascending, then ranges by start/end, episodeId tiebreak), then renumber from `startEpisodeNumber` (default 1).
- Zero-padded to 3 digits minimum, never truncated (`999.txt` → `1000.txt`).
- Selected subset `5, 7, 10` with `start=1` → `001.txt`, `002.txt`, `003.txt`; with `start=101` → `101.txt`, `102.txt`, `103.txt`.

## Title options

- `titlePrefix` — joined with a single space (`ตอนที่` + `การพบกันอีกครั้ง` → `ตอนที่ การพบกันอีกครั้ง`).
- `appendFilenameToTitle` — appends the generated stem (`การพบกันอีกครั้ง 001`).
- Combined: `ตอนที่ การพบกันอีกครั้ง 001`. An already-present prefix/filename token is never duplicated.
- Title is single-line flattened (first-line contract); empty title falls back to the generated number.

## ZIP contract (Thai-Novel mode)

Flat root only — `001.txt`, `002.txt`, ... **No `manifest.csv`, no `contents/`.** Deterministic bytes (canonical order + fixed entry timestamp 2000-01-01, same infrastructure as A). Filename: `<sanitized-title>-thainovel.zip` (fallback `novel-<id>-thainovel.zip`; Windows-safe via the shared A sanitizer).

## Source authority

Identical to A: `episodes.isPublished === true` + inline canonical `content` only. Drafts/Checker/QC/Approval/Stage are never read. The UI states "ส่งออกเฉพาะตอนที่เผยแพร่แล้ว". Selection semantics (unknown/cross-novel/duplicate/unpublished/empty-subset fail closed; whole-novel missing-content skip-and-report) are the shared A service code.

## API (all admin-only, same FORBIDDEN semantics as A)

- `admin.novelExport.thaiNovelPreview` `{ novelId, episodeIds?, startEpisodeNumber?, titlePrefix?, appendFilenameToTitle? }` → `{ novelTitle, mode, sourceEpisodes[], entries[] (source→filename→title→bytes), skippedItems, limits }`. No TXT content over the wire; preview comes from the same serializer as the download.
- `admin.novelExport.thaiNovelDownloadZip` (same input) → `{ filename, mimeType: "application/zip", contentBase64, byteCount, itemCount, entryFilenames }`.
- Limits reused from A: 500 items / 8MB per TXT / 40MB total / 24MB ZIP — fail-closed typed `NovelExportError`.

## UI

- `client/src/pages/WorkspaceNovelExportDialog.tsx` — shadcn Dialog; mode radios (Thai-Novel default), scope (ทั้งเรื่อง / ตอนที่เลือก from published source episodes), Thai-Novel options, preview table, download via Blob (`atob` → `Blob` → object URL → revoked after click), bounded error display, download disabled while invalid.
- `WorkspacePage.tsx` wiring: +1 state line, +1 import, +1 derived `workspaceBoundNovels` (from `workspace.bindings.list`), a compact outline `ส่งออก` button in the workspace utility row (next to "ลบ Workspace"), and the dialog render — nothing in the Draft→Checker→QC→Confirm→Stage→Publish progression; `WorkspaceEditorialToolbar.tsx` untouched (asserted by static test).

## Known limitations (inherited, unchanged in B)

- `saleMode="chapter"` episodes are exported in Backup mode but the existing package import flow rejects them by contract (documented in A).
- Backup-mode ZIP filename remains `<sanitized-title>.zip` (A contract, unchanged).
- Manual local smoke NOT RUN (no safe local runtime/test DB).
