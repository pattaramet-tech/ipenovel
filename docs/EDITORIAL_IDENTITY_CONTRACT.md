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

### Paragraph identity under whole-tab rewrite — FIXED in IPE-058-C

IPE-058-A documented a known defect: `applyEditorialTabEdit` paired
replacement paragraphs to previous paragraphs PURELY BY POSITION, so a
mid-tab insertion made the NEW text inherit the old paragraph's key while the
shifted paragraph was re-keyed. IPE-058-C fixes this in
`editorialEditor.domain.ts`:

- **Canvas path (explicit identity)**: the single-canvas editor sends
  `replacementParagraphKeys` — one entry per replacement paragraph. A
  non-empty key that exists in the tab declares "this replacement paragraph
  IS that logical paragraph" (text may be edited — identity preserved). An
  empty string declares a NEW paragraph; the server mints a fresh key under a
  dedicated `workspace-editorial-tab-paragraph-v3` domain:
  `sha256(v3, sourceTabId, identitySeed, perSaveOrdinal, text)`. The
  **identity seed authority is the edit idempotency payload SHA** (computed
  by `editorialEditor.service.ts` from editorVersion + expectedDraftId +
  expectedDraftVersion + expectedDraftSha256 + command + findingKey): it is
  identical for an exact mutation retry (idempotent) and different across
  Draft revisions, so a paragraph recreated after deletion can NEVER resurrect
  the deleted paragraph's key (stale QC evidence can never retarget it).
  Duplicate keys or a count mismatch are rejected (`TAB_CONFLICT`) — fail
  closed.
- **Legacy path (no explicit keys)**: deterministic occurrence matching — the
  k-th replacement paragraph with a given text inherits the k-th previous
  paragraph with identical text, so insertions never steal neighbouring keys
  and deleted paragraphs' keys simply disappear.
- **Unmatched-piece pairing (canvas model)**: after exact-text occurrence
  matching, still-unmatched new pieces pair with still-unmatched previous
  nodes in ORIGINAL document order (`previous.filter(not matched)` — never
  `Map.values()` order, which scrambles duplicates by first-seen text key).

### Single-canvas editing layer (IPE-058-C)

The Chapter Editor is now ONE continuous editing surface
(`ChapterEditorCanvas` in WorkspacePage.tsx) over the flat canvas text. The
canonical persistence boundary is UNCHANGED: paragraph-aware plain text via
the guarded `replace_tab` Draft command (structuralSha256 + expectedText +
draftSha256 optimistic locks, immutable Draft revision, checker recheck after
save). See `client/src/pages/workspaceChapterCanvas.ts` for the model:

- paragraphs --join `"\n\n"`--> canvas text; canvas text --split on blank
  lines--> paragraphs (the server's blank-line split is the same contract).
- Reconciliation rules (deterministic, O(n), locked by
  `workspaceChapterCanvas.test.ts`): unchanged keeps key; text edit keeps
  key; split keeps the FIRST piece's key (other pieces new); merge keeps the
  FIRST node's key; delete drops the key; insert is a new identity; reorder
  follows the logical paragraph.
- Soft break: Shift+Enter inserts a single `"\n"` INSIDE the paragraph node;
  the canonical boundary is a BLANK line. Single `\n` survives the server
  split and the round trip.
- Offsets stay JavaScript UTF-16 code units end to end —
  `chapterCanvasFindingRange` maps (paragraphKey, offsets) onto the canvas;
  a stale paragraphKey returns null and fails safely (no wrong highlight).
- Undo/redo is a controlled client history (never crosses a server save or a
  chapter switch — reset on save/open/close).

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
- **ParagraphKey whole-tab-rewrite defect**: DEFERRED to IPE-058-C (DONE there — see the
  "FIXED in IPE-058-C" section above).

## IPE-058-C status

- Single-canvas paragraph-aware editor: DONE (presentation/editing layer only;
  canonical persistence stays paragraph-aware plain text through `replace_tab`).
- ParagraphKey positional-carry defect: FIXED (explicit canvas identity +
  legacy occurrence matching).

## IPE-058-E — QC/Approval state machine (canonical currentness)

The Draft→Checker→QC→Approval→Stage machine now has ONE pure authority:
`evaluateEditorialCheckerState` (editorialForeignChecker.domain.ts), consumed
by the checker read model, the approval QC read model, and the client status
chips. States: `NOT_RUN`, `RUNNING`, `STALE`, `ERROR`,
`CURRENT_HAS_FINDINGS`, `CURRENT_READY`.

- **Currentness** binds exact draftId (immutable revision identity — drafts
  are append-only) + engineVersion + allowListSha256. It NEVER derives from
  finding counts, timestamps, tabOrder, the latest row, or UI state. Stale
  evidence is stale even at open=0 (IPE-058-A invariant, now enforced by the
  evaluator itself).
- **QC ready** requires `CURRENT_READY` only: run succeeded + current
  evidence + zero unresolved blocking findings/anomalies. The approval
  `currentQcEvidence` returns the canonical `state` alongside
  ready/reason/QcEvidenceSha256.
- **Checker ERROR** is an explicit state (bounded safe reason) — never
  open=0/ready/pending_confirm; Stage is blocked because no usable evidence
  exists. **SCHEMA BLOCKER (IPE-058-E review fix, audited):** no existing
  durable store can carry an authoritative checker-ERROR record without a
  schema extension. Audited candidates: (1)
  `workspaceEditorialCheckerRuns.status` is a MySQL enum `passed|failed` —
  faking an error as a failed row with zero findings would become latestRun
  and look CURRENT_READY (actively wrong); (2)
  `workspaceEditorialDraftEditEvents` is Draft-edit semantics (editKind enum
  + text hashes) — checker failures are not edits; (3) `workspaceOutbox` is
  the M05 publish-delivery contract with a required publishRunId FK.
  Required extension (for a migration milestone, NOT done here): extend the
  run status enum with `error` + add nullable `errorReason varchar(255)` on
  `workspaceEditorialCheckerRuns`, persist an error row inside the run
  transaction, and have `evaluateEditorialCheckerState` consume
  `run.status === "error"` as authoritative. Until then: an errored attempt
  persists nothing, the previous run keeps its own (stale/current) state,
  and the client surfaces the error banner from the typed mutation error
  (transient, not durable).
- **Ghost pending_confirm**: the client approval pill downgrades to
  `stale`/`not_run` based on the server QC state — a stale draft/checker can
  never display as pending_confirm. (Server-side kanban already moves the
  card to `editing` on every content-changing revision path.)
- **Exactly-once auto recheck**: the client coalesces concurrent rechecks and
  skips already-completed ones per identity
  `workItemId:draftId:allowListSha256`; the server additionally dedupes run
  rows by (workItem, draft, sha, engine, allowlist) idempotency key.
- **Full Checker Apply (IPE-058-D)** creates a new Draft revision → old run
  stale by draftId, old approval `DRAFT_CHANGED`, card projected to
  `editing`; a cancelled preview persists nothing.

## IPE-058-F — Daily workflow UX on top of the canonical state machine

The UX layer is PRESENTATION ONLY — every status/action derives from the
IPE-058-E canonical state (no count/timestamp/local shortcuts):

- **Primary CTA**: deriveEditorialPrimaryAction
  (workspaceEditorialActionState.ts) picks exactly ONE next action per state
  (save_check / run_checker / fix_findings / confirm / stage / publish);
  dirty and saving are legitimate client-local editor states and win first.
- **Sticky toolbar** (WorkspaceEditorialToolbar.tsx): Prev/Next chapter,
  unsaved indicator, checker/QC state chip, issue count, and the primary CTA
  on one sticky row; no hashes/ids in the toolbar.
- **Issue drawer**: collapsed by default with counts; Previous/Next + jump
  actions unchanged; stale findings never jump.
- **Stage diagnostics**: groupStageDiagnostics
  (workspaceStageDiagnostics.ts) groups IPE-058-B blockers by root cause
  (CHECKER_STALE / QC_NOT_READY / APPROVAL_STALE / METADATA_MISSING /
  EPISODE_RANGE_INVALID / SOURCE_DRIFT / OWNERSHIP_MISMATCH) with affected
  counts/tabs and a direct repair action (Run Checker / Confirm ใหม่ /
  เปิด Editor); raw anomaly messages stay available below.
- **Advanced section**: draft/approval hashes and structural sha moved into
  collapsed Advanced details (title tooltips for tab hashes) — support data
  remains accessible, not in the primary flow.
- **Row → editor**: pack table rows have a direct เปิด Editor button; the
  selected novel group auto-expands and the editor opens issue-first when
  Draft tabs arrive. Table-first stays the default; Kanban optional.
- **Checker ERROR durability**: unchanged — still a documented SCHEMA
  BLOCKER from IPE-058-E; F renders the transient mutation error banner and
  does NOT claim durable ERROR persistence (limitation carried to
  IPE-058-G / a future migration milestone).
