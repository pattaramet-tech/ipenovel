# IPE-PLUGIN-001D-R1 — Tenant Role Authorization Design (READ-ONLY PROPOSAL)

Status: **DESIGN ONLY — awaiting ChatGPT design review. Nothing in this document is implemented.**
Scope guard: Workspace UI/tRPC routes KEEP their platform-admin semantics unchanged. No
`requireWorkspacePlatformAdmin()` deletion, no `skipAdminCheck`-style boolean bypass, no
schema/migration, no service refactor in this round.

## 1. Why the admin gate blocks plugin users today

Every editorial Workspace service starts with `requireWorkItem(...)` →
`requireWorkspacePlatformAdmin(db, actorUserId)` → throws `ADMIN_REQUIRED` unless
`users.role === "admin"`. Plugin tokens bind to real IpeNovel users; unless that user is a
platform admin, all four 001D tools fail with `ADMIN_REQUIRED` even when the 001C tenant
boundary (owner-or-active-member + active binding) passes.

The 001D tests therefore use admin-role users. This works but is NOT the target model: it
makes the plugin boundary partially redundant for admins and excludes legitimate
owner/editor members.

## 2. Goal

Plugin tools authorize from the 001C tenant role, WITHOUT bypassing security and WITHOUT
duplicating editorial business logic — the services keep owning CAS, idempotency, kanban
projection, and evidence semantics.

## 3. Proposed role matrix (target state)

| Tool | effect | owner | editor | reviewer | viewer | non-member |
| --- | --- | --- | --- | --- | --- | --- |
| `draft.get` | READ_ONLY | ✓ | ✓ | ✓ | ✓ | NOT_FOUND |
| `checker.get` | READ_ONLY | ✓ | ✓ | ✓ | ✓ | NOT_FOUND |
| `draft.edit` | MUTATION | ✓ | ✓ | ✗ DENIED | ✗ DENIED | NOT_FOUND |
| `checker.run` | MUTATION | ✓ | ✓ | ✓ (read-grade state change, evidence-only) | ✗ DENIED | NOT_FOUND |

Rationale:
- All four roles already satisfy "can view" (`canViewWorkspace` in
  `server/workspace/domain.ts` returns true for every role).
- `draft.edit` changes manuscript content → editor-grade authority (owner/editor only).
- `checker.run` writes only derived evidence + projects the pack card to
  `needs_fix`/`pending_confirm` — no manuscript text mutation. Reviewers (who review
  findings) plausibly need it; if the design review prefers stricter symmetry, reviewer can
  be dropped to read-only without affecting the other rows.
- Non-members remain NOT_FOUND via the 001C boundary (no existence oracle) — unchanged.

## 4. Recommended mechanism: authorization context passed INTO the service

Keep `requireWorkspacePlatformAdmin` exactly where it is for the tRPC surface, and add a
parallel, explicitly-named authorization context that the PLUGIN supplies:

```ts
// server/workspace/editorialAccess.ts (NEW, no behavior change by itself)
export type EditorialAccessContext =
  | { kind: "platform_admin" }                       // existing tRPC path
  | { kind: "plugin_member"; role: "owner" | "editor" | "reviewer" | "viewer" };

export async function resolveEditorialAccessContext(
  db, actorUserId, workspaceId,
  source: "workspace_route" | "plugin_tool"
): Promise<EditorialAccessContext>
```

- `source === "workspace_route"` → current behavior (platform admin or throw). Zero change
  to any existing tRPC route/test.
- `source === "plugin_tool"` → platform admin (same as today) OR active member; the member's
  role is returned so the caller (plugin tool layer) can enforce the matrix above.

`requireWorkItem(...)` gains one parameter: the resolved context replaces its internal
admin check:

```ts
requireWorkItem(db, ctx: EditorialAccessContext, workspaceId, workItemId)
```

- lineage join unchanged (workItem → card → editorial board → workspaceId),
- `WORK_ITEM_NOT_FOUND` unchanged,
- plugin path passes `ctx` from `resolveEditorialAccessContext(..., "plugin_tool")`;
  role below `editor` + mutation tool → plugin layer denies BEFORE calling the service
  (fail closed at the boundary, service stays the second gate).

## 5. Why this does not duplicate/bypass

- Business logic (CAS, idempotency keys, projections, evidence) stays 100% in the services;
  only the ACCESS CHECK becomes parameterized by caller kind.
- The plugin cannot forge the context: `EditorialToolDeps` (protocol wiring) resolves it
  server-side from `principal.userId` — the same override-aware db singleton; no client
  field can select it.
- Workspace tRPC routes never pass `"plugin_tool"`, so their admin semantics are bit-for-bit
  preserved (guarded by `adminOnlyAccess.integration.test.ts` + static tests, untouched).
- Fail-closed default: unknown source string → treat as workspace_route (admin) — no new
  privilege by accident.

## 6. Migration sketch (future round, AFTER design approval)

1. Add `editorialAccess.ts` + `EditorialAccessContext` (no callers).
2. Parameterize `requireWorkItem` to take the context (workspace routes pass
   `resolveEditorialAccessContext(..., "workspace_route")` — behavior identical).
3. Plugin editorial deps resolve `"plugin_tool"` context + enforce role matrix.
4. Tests: existing workspace admin-only suites unchanged + green; new plugin role-matrix
   regressions per the table in §3 (owner/editor/reviewer/viewer × read/mutation).

## 7. Open questions for design review

1. `checker.run` for `reviewer`: allow (evidence-only) or restrict to owner/editor?
2. Should `draft.edit` by `owner` vs `editor` be distinguished in pluginAuditLogs
   (`viewerRole` is already resolved by the tenant proof)?
3. Do we need the SAME context mechanism later for Stage/Publish tools (001E+), or should
   those keep admin-only semantics indefinitely?
