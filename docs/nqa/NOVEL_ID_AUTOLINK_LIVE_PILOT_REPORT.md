# NQA Novel ID Auto-Link Live Pilot Report

## Gate state

`BLOCKED_BEFORE_HUMAN_CONFIRM`

The Workspace composition implementation is test-ready, and live Google
read-only evidence is available, but the current local/runtime environment
cannot produce an authoritative canonical ipenovel `novelId` match.

No human confirmation was requested and no Google mutation was performed.

## Live Google evidence

Observed through the connected Google Drive/Sheets read surface on
2026-09-25.

Spreadsheet metadata:

- ID: `1uUzDUt4McCQFADr4WFZ5NiRTUlg1hOafMLIyljzec7Y`
- title: `รวมนิยาย`
- target tab exists: `นิยายยังไม่จบ/ยังไม่ยื่น`

A read of `A1750:B1800` showed Column A blank for the returned rows.

Pilot candidate re-read:

- Row: `1751`
- A1751: blank
- B1751:
  `นารูโตะ: ระบบค่าความชำนาญ ฝึกซ้ำจนไร้ขีดจำกัด 201 - 250`

A bounded A:B search across rows 1–2500 found that exact title only at row 1751.

The row is therefore suitable for a future Preview attempt because there is no
existing Column A value to overwrite and the sheet identity is known.

This is not yet a deterministic Auto-Link MATCH because a canonical database
candidate has not been obtained.

## Zero-mutation evidence

During this milestone's live Google work:

- only metadata/range/search reads were used
- no Sheets update/batchUpdate action was called
- A1751 was re-read and remained blank
- no Workspace binding/publish mutation was called

## Current runtime blocker

A local runtime environment-presence probe reported all of the following as
absent:

- `DATABASE_URL`
- `NQA_AUTOLINK_SPREADSHEET_ID`
- `NQA_AUTOLINK_GOOGLE_READ_ACCESS_TOKEN`
- `NQA_AUTOLINK_GOOGLE_READ_GRANTED_SCOPES`
- `NQA_AUTOLINK_GOOGLE_WRITE_ACCESS_TOKEN`
- `NQA_AUTOLINK_GOOGLE_WRITE_GRANTED_SCOPES`
- `NQA_AUTOLINK_AUDIT_DIR`
- `NQA_AUTOLINK_REMEDIATION_ENABLED`

No matching local `.env*` or credential/secret-named file was found in the
repo root or NQA worktree.

A direct local canonical DB query attempt did not produce verified result
evidence and was not used.

## Why the gate stops here

The live Sheet title must be matched against canonical `novels.id`.

Without the authoritative database connection, assigning a novelId from title,
another Sheet, web search, or model inference would violate the deterministic
matching contract.

Therefore the pilot stops before generating a Preview fingerprint and before
Human Confirm.

## Composition verification

Targeted Workspace/NQA composition regression after integration:

```text
Test Files: 9 passed
Tests:      55 passed
```

Full NQA + Workspace regression:

```text
Test Files: 126 passed
Tests:      568 passed
```

TypeScript:

```text
tsc --noEmit
PASS
```

After the full regression, `A1751:B1751` was read again and A1751 was still
blank. This is the post-test zero-mutation proof.

Coverage includes:

- fail-closed missing runtime config
- exact live spreadsheet-ID binding
- separate read/write credentials
- required read-only vs write Sheets scopes
- Preview through the actual NQA gateway with READ
- zero write during Preview
- default Confirm = TIER_DISABLED
- Confirm enabled only after exact remediation flag + write scope
- canonical numeric novelId + SYNC_READY handoff
- Workspace router exposure only through adminProcedure
- no broadening of Workspace Docs scopes
- no broadening of global NQA default tiers
- no automatic Workspace binding/publish

## Required evidence before Human Confirm

The next live attempt must produce a real response containing:

- `status = MATCH`
- `row = 1751` or another explicitly selected blank-A row
- one canonical numeric `matchedNovelId`
- one 64-hex `previewFingerprint`
- exact live spreadsheet ID/title/tab

Only then should the operator be asked to approve the exact tuple:

`row + novelId + previewFingerprint`

Until then Column A must remain unchanged.
