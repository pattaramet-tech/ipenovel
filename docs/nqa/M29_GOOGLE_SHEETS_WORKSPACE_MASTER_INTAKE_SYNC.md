# M29 — Google Sheets → Workspace Master Intake Sync

## Scope

M29 imports editorial intake metadata from the approved Google Sheet into IpeNovel Workspace so operators do not have to type a novel title, episode range, and source links one item at a time.

Source:
- Spreadsheet: `รวมนิยาย`
- Tab: `นิยายยังไม่จบ/ยังไม่ยื่น`
- B: novel title + terminal episode range
- C: Thai translation Google Doc
- E: web source URL
- K: prepared English source Google Doc

The feature uses the selected durable Workspace Google connection with read-only Sheets/Docs scopes.

## Operator flow

1. Select a Workspace and Google connection.
2. Enter a row range of 1–100 rows.
3. Run **Preview Sync**.
4. Review per-row status: `NEW`, `MATCH`, `UNCHANGED`, `UPDATED`, or `CONFLICT`.
5. Run **Sync**. Only actionable rows are mutated; `CONFLICT` rows stay failed/unchanged and `UNCHANGED` rows are no-ops.
6. Re-preview after success. Identical durable rows resolve to `UNCHANGED`.

## Durable behavior

For an actionable row, M29:
- matches an existing publication novel by normalized title or creates a new `archived` novel;
- binds it to the selected Workspace;
- creates/reuses an Editorial Episode Pack;
- leaves commerce metadata pending/unset for M29-created packs;
- imports C through the existing Google Docs → Editorial Draft pipeline;
- persists C/E/K links plus spreadsheet/sheet/row provenance and SHA-256 row fingerprint;
- records an append-only Workspace audit event for the batch.

The preview fingerprint includes the row fingerprint plus resolved DB target identities/blockers. Confirm recomputes Preview and rejects a stale fingerprint, preventing a preview from being applied after Sheet or Workspace state drifts.

## Conflict and idempotency policy

Preview fails closed per row for malformed B/C/E/K values, ambiguous titles, overlapping ranges, duplicate/overlapping identities inside the same batch, shifted provenance, an already-owned work item, changed Thai source identity, missing durable targets, or a pack that has advanced beyond the editable intake state.

Repeated identical syncs do not create duplicate novels, Episode Packs, or provenance rows.

## Safety invariants

- Google Sheet reads are read-only.
- Maximum batch size is 100 rows.
- No M29 code path calls Controlled Publish.
- New novels remain `archived`.
- M29-created Episode Packs have pending commerce metadata until an operator explicitly configures it.
- M29 never writes QA/QC columns L/M.
- Production deployment is out of scope for M29 validation; validation is performed on production-staging only.

## Verification policy

The blocking M29 gate covers targeted/adjacent Workspace tests, TypeScript, production build, migration/diff checks, secret/U+FFFD checks, and a dependency-change gate. The repository-wide CI suite and dependency audit remain visible as diagnostics because the current main baseline has pre-existing failures/advisories unrelated to M29; M29 must not introduce dependency or lockfile changes.
