# M02 — NQA Data Contracts + Canonical Fixtures

Status: COMPLETE
Date: 2026-09-24
Scope: READ-ONLY fixture capture and typed contracts
Branch: feat/nqa-foundation

## Objective

Freeze the first executable NQA contracts and reproducible regression identities without copying full novel text into the repository.

M02 establishes:

- typed Sheet C/E/K source routing
- novel / bundle / chapter identity shapes
- chapter content fingerprints
- QA result and bounded evidence contracts
- canonical historical bad fixture
- positive-control candidates
- revision-aware handling of mutable Google Docs and mutable Sheet rows

## Production-safety invariant

No Google content was written, edited, moved, published, or deleted.

The repository stores:

- document IDs
- revision IDs/tokens
- tab IDs
- chapter numbers/titles
- index ranges where available
- SHA-256 fingerprints
- bounded semantic notes

It does not store complete source or translation chapter text.

## Critical discovery during fixture capture

The original incident locator was not stable.

Historical locator:

- Sheet: นิยายยังไม่จบ/ยังไม่ยื่น
- Row: 1584
- Bundle: วันพีซ: ความทรงจำเนื้อเรื่องถูกลบ แต่ผมมีระบบนินจา 181 - 230

Current locator observed during M02:

- Row: 1562
- Same logical bundle title
- Current C-column document changed to 1gRxEHcLI3-e29E0jE0pWtGCGB1HlZm7opL-jcS9IyLQ
- K remains 1wXZBYJ9Eu586XajNw4R-Q768quKzHsJsIlK-KuWTB0Q
- The current C-column document returned permission denied to the connected Google reader

Design consequence:
Row number and current C link are locators, not regression identity.

Regression identity is pinned by document + revision + tab + chapter + normalized content SHA-256.

## Fixture normalization

Version: NQA_FIXTURE_V1

Algorithm:

1. Unicode NFC
2. CRLF / CR to LF
3. trim trailing spaces/tabs per line
4. trim leading/trailing blank lines
5. for historical text/plain revision exports, strip the leading tab-label line before chapter hashing

## Frozen English source

Document:
1wXZBYJ9Eu586XajNw4R-Q768quKzHsJsIlK-KuWTB0Q

Google Drive revision:
4

Google Docs revision token:
ANLCKQlrksmAFNO1iPtKgVAlfisxIsQbLQc7uTC3g85mxGJsx6yzdO1-tNV-Bgyg8XLgDyFdmWb7I6BP0z3hB_9sNPam8u0pLVZzOoKp1Dk

Tab:
t.0

### Source Chapter 196

- internal sequence: 197
- heading: 196. Search and Rescue
- paragraph count: 95
- start index: 170567
- end index: 181956
- chars: 11389
- SHA-256: 29dfb16657addd2f46c824f3cdb9a2d9d7516ad1b7b9a354b07b6c8aa93fff17

### Source Chapter 197

- internal sequence: 198
- heading: 197. Possessing
- paragraph count: 88
- start index: 181957
- end index: 193006
- chars: 11049
- SHA-256: de05d436cc03526bb80506482b10d908ecfcdc3f3c53365a56253903518be793

This confirms internal sequence and source chapter number are distinct identity fields.

## Historical Thai revision

Historical document:
1iLE_8KxtftOIcZuRuU30CVmOQM0W3CnF4HWARAT3vjY

Known-bad Drive revision:
69

### Thai Chapter 196 — positive-control candidate

- tab lineage: t.t7mcm92c2amf
- chapter: 196
- chars: 9470
- paragraphs in normalized historical slice: 95
- SHA-256: 57d53dced4d97bd1eaf35bce87d420cbde15b6f750317a361bed39ab048d1633
- expected decision: PASS
- label status: CANDIDATE_PENDING_HUMAN_SIGNOFF

### Thai Chapter 197 — canonical bad

- tab lineage: t.bf525hytchcg
- historical title: ค้นหาและช่วยเหลือ
- chapter: 197
- chars: 10189
- paragraphs in normalized historical slice: 107
- SHA-256: 5eb68ab366d0ab258676d07e644799809777bd004f4ed8ff21862dc8e4256ea0
- expected decision: FAIL
- label status: CANONICAL_INCIDENT

Deterministic semantic anchors revalidated in revision 69:

- commander-search content present
- laboratory content present
- Devon content present

These conflict with the frozen English Chapter 197 storyline.

## Corrected Thai revision

Same historical document ID, current Drive revision:
90

Google Docs revision token:
ANLCKQmKbq-ZJzMyvDUPEZYooBvgZMlAQj96UTF-wQJrmvUAm6gyY5FFxP3Ig6vj7zJLPcRQ0UmbBjWN6CEYvbPM5_XiPCzlgFQ0oR-H9pQ

Corrected Chapter 197:

- tab: t.bf525hytchcg
- heading: บทที่ 197 การสิงร่าง(แปลใหม่)
- paragraphs: 86
- start index: 1
- end index: 9963
- chars: 9962
- SHA-256: 98c4d7e573c8c10735102283a7aff8a653fedd85b759f4deec9f614af0f6922f
- expected decision: PASS
- label status: CANDIDATE_PENDING_HUMAN_SIGNOFF

Semantic anchors revalidated:

- Sabo present
- Kurama present
- possession/mind-related content present

## Implemented contracts

server/nqa/contracts.ts defines:

- SourceContract
- SheetLocator
- GoogleDocRef
- NovelIdentity
- BundleIdentity
- ChapterIdentity
- ContentFingerprint
- ChapterSnapshotRef
- NqaReasonCode
- QaDimensionScores
- QaEvidenceRef
- QaResult
- CanonicalFixture

The QA result intentionally has separate fidelity dimensions and no single overall similarity score.

## Pure intake parser

server/nqa/intake.ts provides deterministic parsing only:

- B display title
- C translation Google Doc URL
- E optional web reference
- K prepared English Google Doc URL
- chapter-range extraction
- typed SourceContract output

Policy:
K is mandatory for NQA V1.
E does not replace a missing K.
A deep-linked Google Docs tab is never treated as chapter identity.

## Acceptance criteria

- historical bad Chapter 197 is reproducibly identified by revision/hash
- row drift is explicitly represented
- positive controls remain pending human signoff
- full copyrighted chapter text is not committed
- contracts are executable Zod schemas
- TypeScript strict check passes
- unit tests cover contract, fixture and intake invariants

M02 is complete.
