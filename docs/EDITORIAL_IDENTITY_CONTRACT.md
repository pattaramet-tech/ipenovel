# Editorial Identity Contract (IPE-058-A)

Canonical identity semantics for the Workspace editorial pipeline. The
executable form lives in `server/workspace/editorialIdentityContract.domain.ts`
(pure TypeScript, no DB, no service imports); this document is the human map.
Nothing in IPE-058-A relaxes a blocker or changes staging behavior — this is
the contract that IPE-058-B stage-mapping work must implement against.

## Pipeline

```
Work Item ── owns ──> Draft (versioned, draftSha256)
   │                      └─ tabs[] ── each: paragraph[] with paragraphKey
   │                      └─ tab.chapterNumber/chapterTitle (parsed heading metadata)
   ├─ episodeNumber = COMMERCE range string (e.g. "001-030")
   ▼
Checker Run (draftId, engineVersion, allowListSha256) ── currentness ──> QC Evidence
   ▼
Approval (draftSha256 → qcEvidenceSha256 → approvalPayloadSha256)
   ▼
Stage Plan (batch by DETECTED episode number, never tabOrder)
   ▼
Staged Episode (stage row keyed (approvalId, canonical episodeNumber);
 publish item key = editorial-stage:{stageId}:episode:{episodeId})
```

## Identity semantics per layer

| Identity | Definition | Must NOT be |
| --- | --- | --- |
| `workItemId` | DB row owning the draft + latest approval | derived from titles |
| `workItem.episodeNumber` | commerce range string, e.g. `"001-030"` (pack scope) | used as any tab's chapter number |
| `sourceTabId` | stable provider identity assigned at intake (`editorialStableSourceTabIdentity` hashes ONLY this) | derived from title/display text; changed by reorder/retitle |
| `tabOrder` | presentation/source ordering | chapter identity; batch→stage mapping is by detected number |
| source-tab snapshot | `editorialSourceTabSnapshotFingerprint` hashes tabOrder + chapterNumber/chapterTitle scoped by sourceTabId — a change-detection projection, EXPECTED to change on reorder/retitle/renumber | called a stable identity |
| `paragraphKey` | intake: sha256(`workspace-editorial-paragraph-key-v1`, sourceTabId, 1-based source position, sourceParagraphFingerprint, occurrence ordinal); split: derived from original key | assumed text-stable across a whole-tab rewrite (see known defect below) |
| `chapterNumber` / `chapterTitle` | parsed-heading metadata on the draft tab (first heading-like PARAGRAPH, not the tab title) | canonical identity when range-shaped; a pack range must never become a tab's chapter number |
| canonical range | hyphen form `"001-030"` (`kind: "range"`) — pack/commerce scope | any tab's canonical chapter identity |
| range-shaped non-canonical | dot/em-dash forms (`"1..30"`, `"001—030"`) → `kind: "unparseable"` + `rangeShaped: true` — draft metadata only, staging keeps refusing | parsed into bounds or treated as a single chapter |
| checker run | `(draftId, engineVersion, allowListSha256)` — current only when all three match | `open=0` treated as current |
| QC evidence | production `editorialQcEvidenceSha256` binds run identity PLUS the per-finding/anomaly disposition set. `editorialCheckerRunIdentity` in the contract module is the run/currentness identity component only | equated with the full evidence hash |
| staged episode | stageId + episodeId (row identities) | mutable display title |

### Known paragraph-identity defect (whole-tab rewrite)

`applyEditorialTabEdit` (editorialEditor.domain.ts) pairs replacement
paragraphs to previous paragraphs PURELY BY POSITION and carries
`previous?.paragraphKey` forward **without checking text equality**. When a
paragraph is inserted mid-tab: the NEW text at that position INHERITS the old
paragraph's key, and the old (shifted) paragraph is re-keyed. `paragraphKey`
is position-stable but NOT text-stable across a whole-tab rewrite — finding
states and anomaly confirmations keyed by `paragraphKey` can attach to the
wrong paragraph. This is locked by a regression test
(`editorialEditor.domain.test.ts`, "identity is not stable across tab
replacement") and MUST be reconciled in IPE-058-B (or a dedicated milestone)
before any consumer relies on paragraphKey across a tab rewrite. No
production editor behavior was changed in IPE-058-A.

## Known identity-mismatch origins (reproduced as deterministic fixtures)

| # | Origin | Layer | Fixture |
| --- | --- | --- | --- |
| A | Tab with content but no chapter-shaped heading stores `chapterNumber=null` silently; staging then raises `TAB_NUMBER_MISSING` | draft → approval | `editorialApproval.domain.test.ts` (A) + draft test |
| B | `X/Y` tab counts come from work-item range width (`parseEditorialEpisodeRange`) vs detected tabs; missing tabs fail closed with `COUNT_MISMATCH` + `EXPECTED_EPISODE_MISSING` | structural/approval | `editorialApproval.domain.test.ts` (B) |
| C | Draft parser accepts range-shaped headings (`บทที่ 001-030`, `1..30`) and stores the normalized string as `chapterNumber`, while staging canonicalizes every range-shaped form to `null` → `TAB_NUMBER_MISSING` — draft/UI and stage disagree. Canonical range = hyphen form; dot/em-dash forms are range-shaped non-canonical metadata (`classifyEditorialChapterNumber.rangeShaped`) | draft vs approval | draft + approval tests (C) + contract tests |
| D | A checker run with zero findings (`open=0`) is still stale when draftId/engine/allow-list drift; `effectiveStatus` is computed independently of `isCurrent` | checker/QC | checker domain test + approval service integration test (CI-gated) |
| E | Title-only/empty/source-note/front-matter tabs are classified: source notes are excluded when confirmed, genuine empty tabs raise `TAB_EMPTY`, front matter is excluded only when not conflicting and not in-range | approval | `editorialApproval.domain.test.ts` (E) |

## IPE-058-B implementation notes (done on branch fix/ipe058b-stage-metadata-reconciliation)

- **Chapter metadata resolver**: `resolveEditorialTabChapterIdentity` (editorialApproval.domain.ts)
  collects per-source candidates (heading → tab metadata → tab title), canonicalizes each
  through the IPE-058-A contract classifier, and only selects a canonical number when ALL
  observed claims agree as canonical singles: any range-shaped claim emits
  `RANGE_USED_AS_CHAPTER_IDENTITY`, any observed-but-unresolvable claim (e.g. unreadable
  metadata) fails closed via `TAB_NUMBER_MISSING` with evidence instead of being silently
  discarded, and any two distinct canonical claims conflict via `TAB_NUMBER_CONFLICT`
  (the stable code for chapter-identity conflict). Absent sources (null/empty) are not
  claims and never conflict. Selection precedence equals candidate precedence — never a
  silent pick.
- **Range-shaped metadata**: any range-shaped candidate in a chapter-identity position emits
  `RANGE_USED_AS_CHAPTER_IDENTITY` (fail closed) with per-source evidence. Canonical pack
  range stays hyphen-form commerce scope; dot/em-dash forms are range-shaped non-canonical.
- **Coverage reconciliation**: every batch plan now carries `reconciliation`
  (expected/mapped/missing/duplicate/out-of-range episode numbers, unreadable tabs with
  blocker codes, excluded tabs, identity conflicts, ready). Equal counts with wrong
  identities still block. Surfaced via `stagePlanSummary.reconciliation` and rendered in
  the Stage panel.
- **Stable blocker codes**: existing stable codes reused (`TAB_NUMBER_MISSING`,
  `TAB_NUMBER_CONFLICT`, `TAB_NUMBER_DUPLICATE`, `TAB_NUMBER_OUT_OF_RANGE`,
  `EXPECTED_EPISODE_MISSING`, `COUNT_MISMATCH`, `TAB_EMPTY`, `TAB_CONTENT_INVALID`);
  one new code added (`RANGE_USED_AS_CHAPTER_IDENTITY`). Requested
  `CHAPTER_IDENTITY_CONFLICT` maps to the existing stable `TAB_NUMBER_CONFLICT`;
  `DUPLICATE_EPISODE_NUMBER` → `TAB_NUMBER_DUPLICATE`;
  `EPISODE_OUT_OF_RANGE` → `TAB_NUMBER_OUT_OF_RANGE` — no duplicate terminology.
- **Item-key parser consolidation**: editorialPublish.service and ipenovelPublish.provider
  now build/parse via the contract functions; persisted format unchanged
  ("editorial-stage:{stageId}:episode:{episodeId}"), strict positive-integer semantics kept.
- **ParagraphKey whole-tab-rewrite defect**: DEFERRED. Stage mapping uses canonical chapter
  identity, not paragraphKey, so the defect does not affect stage correctness; the
  regression test locking the behavior stays and the fix moves to the editor milestone
  (IPE-058-C) to keep this change scope-safe.

## Still open for IPE-058-C

- ParagraphKey positional-carry defect under whole-tab rewrite (re-key or text-aware carry).
- Single-canvas paragraph-aware editor redesign.
- "แท็บ X/Y" bulk-checker summary still derives from checker structural summary (separate
  taxonomy from pack reconciliation) — unify presentation if desired.
