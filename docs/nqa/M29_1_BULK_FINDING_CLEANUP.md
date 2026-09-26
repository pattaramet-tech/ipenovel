# M29.1 — Bulk Finding Cleanup

## Goal

Reduce repetitive manual cleanup in Editorial Workspace when the same checker
finding appears many times. The operator previews grouped findings, confirms one
bulk action, and Workspace creates one immutable Draft revision per changed work
item before running the deterministic checker once against that new Draft.

This milestone never writes Google Docs, Google Sheets, or Publish state.

## Scope

### Exact grouped finding

The Preview groups current, open findings by `ruleKey + normalizedToken`.
Examples:

- `alex02373` repeated in source-junk paragraphs;
- the same Devanagari token repeated in several paragraphs;
- any other exact checker token emitted by the current checker engine.

Applying a group removes only the exact findings represented by that Preview.
For ordinary inline findings, only the matched ranges are removed. If the
finding itself is `source_junk`, its whole paragraph is removed.

### Source-junk cleanup

A separate action removes every current open `source_junk` paragraph in the
selected Episode Packs. The action operates only on findings emitted by the
current checker engine; it does not independently guess which text is junk.

## Safety contract

1. Selection is limited to 1–100 work items.
2. Preview records exact Draft id/version/SHA, checker run, engine version,
   finding keys, paragraph fingerprints, offsets, disposition versions, and
   computes a SHA-256 Preview fingerprint.
3. Apply recomputes Preview and fails `PREVIEW_STALE` if any Draft/finding
   evidence changed.
4. Each changed work item is locked and validates the exact current Draft and
   checker run before editing.
5. All matching findings in one work item are applied in memory and persisted
   as exactly one new Draft version with transform code
   `bulk_finding_cleanup`.
6. One durable `bulk_cleanup` editor event is written per changed work item.
   This keeps the normal one-step Workspace Undo path available.
7. The current checker is run once against the new Draft. Its result moves the
   card through the existing QC projection.
8. A Workspace audit event stores ids, counts and hashes only; it does not
   store the removed full text.
9. No Google Docs, Google Sheets, Publish, pricing, or reader-visible state is
   mutated.

## UI

Bulk Editorial controls add **3.1 จัดกลุ่ม / ลบซ้ำ**.

The Preview shows:

- SOURCE JUNK total occurrences / paragraphs / Episode Packs with
  **ลบ Source Junk ทั้งหมด**;
- repeated exact groups sorted by occurrence count with
  **ลบทั้งหมด N จุด**.

Every apply action asks for confirmation and refreshes the latest checker
results after cleanup.

## Migration

`0057_workspace_editorial_bulk_cleanup.sql` extends
`workspaceEditorialDraftEditEvents.editKind` with `bulk_cleanup`.

## Staging validation

1. Deploy the M29.1 candidate to production-staging.
2. Select one Episode Pack containing repeated source-junk findings.
3. Run Checker v4.
4. Open **3.1 จัดกลุ่ม / ลบซ้ำ** and verify counts match the visible findings.
5. Delete one repeated exact group and confirm:
   - one Draft version is created;
   - all exact occurrences are gone;
   - checker refreshes once.
6. Preview again and run **ลบ Source Junk ทั้งหมด**.
7. Confirm remaining source-junk findings are gone and the Pack moves according
   to the refreshed QC result.
8. Use Undo once and verify the immediately previous Draft is restored.
9. Confirm no Google Docs/Sheets data and no Publish state changed.
