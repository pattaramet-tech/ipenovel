# NQA — Novel ID Auto-Link Live Pilot + Workspace Composition Gate

## Objective

Compose the committed Novel ID Auto-Link gate into the real Workspace admin
surface while preserving the operator sequence:

`Status -> Preview -> Human Confirm -> Column A -> Workspace Sync`

This milestone must not turn a missing credential, missing database connection,
or missing human confirmation into an implicit mutation.

## Live target

The runtime is hard-bound to:

- Spreadsheet ID: `1uUzDUt4McCQFADr4WFZ5NiRTUlg1hOafMLIyljzec7Y`
- Spreadsheet title: `รวมนิยาย`
- Sheet tab: `นิยายยังไม่จบ/ยังไม่ยื่น`

`NQA_AUTOLINK_SPREADSHEET_ID` must be explicitly configured and must equal the
hard-bound ID. A different value fails closed.

## Workspace composition

Workspace exposes the Auto-Link runtime only through the existing admin-only
router:

- `workspace.nqaNovelLink.status`
- `workspace.nqaNovelLink.preview`
- `workspace.nqaNovelLink.confirmBackfill`

The router uses the existing Workspace `adminProcedure`.

The runtime composes:

- `DatabaseNqaNovelCatalogReader`
- `NqaNovelIdAutolinkService`
- read and write Google Sheet transports
- `createNqaNovelIdAutolinkHandlers()`
- `NqaGatewayHandlerRegistry`
- `NqaMcpGateway`
- append-only Auto-Link audit store

Therefore the Workspace route does not bypass the NQA capability/permission
gate.

## Credential split

The composition deliberately does not reuse:

- Google login/OIDC tokens
- Workspace Docs OAuth credentials
- the existing NQA read-only Google transport

Workspace Docs remains limited to Drive metadata read-only and Docs read-only.

The Auto-Link pilot uses two distinct server-only credential boundaries:

### Preview credential

Environment:

- `NQA_AUTOLINK_GOOGLE_READ_ACCESS_TOKEN`
- `NQA_AUTOLINK_GOOGLE_READ_GRANTED_SCOPES`

Required declared scope:

`https://www.googleapis.com/auth/spreadsheets.readonly`

This credential is used only by the Preview service.

### Backfill credential

Environment:

- `NQA_AUTOLINK_GOOGLE_WRITE_ACCESS_TOKEN`
- `NQA_AUTOLINK_GOOGLE_WRITE_GRANTED_SCOPES`

Required declared scope:

`https://www.googleapis.com/auth/spreadsheets`

The read and write access-token values must be distinct when both are present.

The access-token environment variables are suitable for a bounded live pilot.
They are not a replacement for a durable refresh-token/workload-identity
provider.

No token value is exposed by the status endpoint or audit artifacts.

## Audit path

`NQA_AUTOLINK_AUDIT_DIR` is required before Preview or Confirm is runtime
ready.

The path should point at persistent server storage.

If it is absent, the Workspace runtime reports a blocker and refuses live
execution.

## Permission gate

`NQA_AUTOLINK_REMEDIATION_ENABLED` uses exact-literal activation.

Only the exact value:

`true`

adds `REMEDIATION` to that runtime gateway instance.

Unset, empty, `TRUE`, `True`, or any other value leaves remediation
disabled.

The global `NQA_V1_ENABLED_PERMISSION_TIERS` remains unchanged at READ +
QA_OPERATE.

Therefore an authenticated Workspace admin can use Preview when Preview config
is ready, but Confirm still returns `TIER_DISABLED` unless the operator has
explicitly enabled this pilot mutation boundary.

## Status gate

The status endpoint reports only non-secret readiness booleans and blockers.

Preview blockers can include:

- target ID not configured/mismatch
- read credential missing
- read scope missing
- audit directory missing

Confirm blockers can include:

- target ID not configured/mismatch
- remediation disabled
- write credential missing
- write scope missing
- read/write credentials not distinct
- audit directory missing

## Workspace Sync

A successful Confirm continues to return the previously defined
`SYNC_READY` handoff:

- numeric canonical `novelId`
- `canonicalIdentity = novel:<id>`
- Google row source key
- committed Auto-Link audit fingerprint

This composition does not automatically call `bindPublicationNovel()` and
does not publish.

The existing Workspace publication binding accepts numeric `novelId`
directly, so Workspace Sync does not need to re-identify the novel by title.

## Human gate

A live Column A write is allowed only after a fresh live Preview has produced:

- `status = MATCH`
- exact row
- exact canonical novelId
- exact preview fingerprint

Those values must be shown to the human operator before Confirm.

A read-only Google row by itself is not sufficient evidence to invent or infer
a novelId.

## Deployment order for the pilot

1. Deploy the composition commit.
2. Ensure production has its normal canonical `DATABASE_URL`.
3. Configure exact `NQA_AUTOLINK_SPREADSHEET_ID`.
4. Configure persistent `NQA_AUTOLINK_AUDIT_DIR`.
5. Provision only the read credential + read-only Sheets scope.
6. Keep `NQA_AUTOLINK_REMEDIATION_ENABLED` unset/false.
7. Run `workspace.nqaNovelLink.status`; require `previewReady = true`.
8. Run Preview for the selected row.
9. Verify unique MATCH and present row/novelId/fingerprint to the human.
10. Only after explicit approval, provision the distinct write credential,
    declare full Sheets scope, and set remediation to exact `true`.
11. Run Confirm once.
12. Verify Column A, committed audit, and `SYNC_READY`.
13. Disable remediation/remove bounded pilot write credential after the pilot.
