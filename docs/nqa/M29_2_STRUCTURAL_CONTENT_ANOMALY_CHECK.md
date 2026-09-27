# M29.2 — Structural / Content Anomaly Check

## Goal

Extend Workspace step **3. ตรวจ / ตรวจซ้ำ** so each Episode Pack is checked for
chapter structure and content anomalies in addition to foreign-script and
source-junk findings.

The checker remains read-only. It never edits Draft content, Google Docs,
Google Sheets, or Publish state.

## Per-run summary

Every checker run records:

- actual Draft tab count;
- expected tab count when `episodeNumber` is a parseable range;
- total structural anomaly count;
- blocking anomaly count;
- persisted anomaly rows tied to the exact checker run.

The Workspace bulk result summary displays the same data per file.

## Anomaly types

### Blocking errors

- `empty_tab`: tab has no meaningful text;
- `end_only_tab`: tab has only `จบตอน`;
- `heading_only_tab`: tab has only chapter heading plus optional `จบตอน`;
- `source_note_only`: tab is only a source note such as
  `บทที่ 13 หมายเหตุต้นฉบับ`;
- `missing_expected_chapter`: a chapter in the Episode Pack range has no
  parsed chapter heading;
- `duplicate_chapter_number`: the same chapter number is present in multiple
  tabs;
- `tab_count_mismatch`: actual number of tabs differs from the episode range;
- `duplicate_content_exact`: canonical chapter bodies are identical.

Blocking anomalies keep QC from approval/staging until the Draft is corrected
and checker v5 passes again.

### Review warning

- `duplicate_content_near`: chapter bodies are highly similar.

Near duplicates use deterministic 5-character shingles. A pair is reported
when Dice similarity is at least 0.92 or smaller-body containment is at least
0.95. This covers both near-identical chapters and the case where one chapter
contains almost all of another chapter plus extra content.

Near-duplicate warnings are surfaced in the result summary but do not by
themselves block approval because legitimate repeated/flashback text is
possible.

## Workspace summary

For each selected Episode Pack, **สรุปผลตรวจ** displays:

- `แท็บ actual/expected`;
- unresolved word/script findings;
- anomaly count and blocking anomaly count;
- compact missing chapter ranges;
- count of end-only, empty, heading-only and source-note-only tabs;
- duplicate/near-duplicate chapter pairs with similarity percentage.

The overall selected-files summary also displays total tabs and total anomaly
count.

## User-case acceptance examples

- `046-100`: 55 tabs; chapters 78, 82-83, 87-88 can be represented by
  end-only tabs and must be reported as both end-only anomalies and missing
  expected chapter numbers.
- `301-350`: chapters 304 and 305 must be reported as high-similarity content
  when their bodies are effectively duplicated.
- `351-400`: chapters 364/365 and contained duplicate 366/367 must be
  reported by the deterministic duplicate detector.
- A tab containing only `บทที่ 13 หมายเหตุต้นฉบับ` plus an optional
  `จบตอน` must be reported as `source_note_only`.

## Persistence

Migration `0058_workspace_editorial_structural_anomalies.sql` adds run-level
summary fields and `workspaceEditorialCheckerAnomalies`, with durable evidence
bound to the exact checker run.

QC evidence SHA includes structural anomaly identity/type/severity, so
approval evidence cannot silently outlive a changed checker result.
