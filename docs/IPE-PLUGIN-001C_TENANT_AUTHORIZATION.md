# IPE-PLUGIN-001C — Tenant Authorization Boundary (read-only workspace/novel/pack/chapter slice)

Status: **READY FOR IPE-PLUGIN-001C REVIEW / QUALIFICATION**
Baseline: `feat/ipe-plugin-001b-oauth-mcp-foundation` @ `36ff71b` (post 001B-Q1 qualification).
No Production change, no deploy, no merge. Branch: `feat/ipe-plugin-001c-tenant-authorization`.

## What this milestone adds

The **server-side tenant boundary** for plugin (ChatGPT/MCP) access, plus eight
new read-only tools. The tenant set is derived ONLY from the token's bound
`users.id` — a client can never choose an authority/account:

> visible(workspace) ⟺ `workspaceWorkspaces.status='active' AND deletedAt IS NULL`
> AND (`ownerUserId = bound user` OR active `workspaceMembers` row)

Every tenant query carries this predicate **inside its own WHERE/JOIN** (no
check-then-read window): a membership removed mid-flight is reflected on the
very next call. Visibility mirrors the app's read models: `workspaceNovels`
must be `active`; packs are `workspaceEditorialWorkItems`
(`new_episode` + `package` saleMode) whose kanban card is `active` on the
workspace's `editorial` board; chapters are the tabs of the LATEST draft
version. All reads go straight to `drizzle/schema` — `server/plugin/` never
imports `server/workspace/*` (isolation static test).

## New tools (registry = 9, all READ_ONLY)

| Tool | Scope | Args (strict) |
| --- | --- | --- |
| `workspace.list` | `workspace:read` | — |
| `workspace.get` | `workspace:read` | `workspaceId` |
| `novel.list` | `novel:read` | `workspaceId` |
| `novel.get` | `novel:read` | `workspaceId, novelId` |
| `pack.list` | `pack:read` | `workspaceId, novelId?` |
| `pack.get` | `pack:read` | `workspaceId, packId` |
| `chapter.list` | `chapter:read` | `workspaceId, packId` |
| `chapter.get` | `chapter:read` | `workspaceId, chapterId` |

Deny policy mirrors the app's tRPC surface: **out-of-tenant and nonexistent ids
both answer the fixed in-band NOT_FOUND tool failure** (`isError:true`,
`structuredContent:null`, text `NOT_FOUND`) — no existence oracle — and are
audited as `mcp_tool_denied` / reason `TENANT_NOT_FOUND`. Scope/registry denials
remain protocol-level JSON-RPC `-32000` (`INSUFFICIENT_SCOPE`,
`UNKNOWN_CAPABILITY`, `CAPABILITY_DISABLED`); malformed args are `-32602`.
Tenant args are strict zod (positive ints, no extra keys) — a client passes
resource locators, never a userId/authority selector.

Audit denials carry only `{capability, reason}` — never requested ids.

## Files

- `server/plugin/controlPlane.ts` — 4 new scopes (`workspace/novel/pack/chapter:read`) + 8 capabilities + enable allowlist (9).
- `server/plugin/store.ts` — tenant read layer (`listPluginVisibleWorkspaces`,
  `findPluginVisibleWorkspace`, novel/pack/chapter list+find), self-contained
  membership EXISTS predicate, latest-draft-version subquery.
- `server/plugin/mcp/handlers.ts` — pure per-tool handlers (deps-injected loaders).
- `server/plugin/mcp/protocol.ts` — registry↔handler dispatch table, per-tool
  args schemas, in-band NOT_FOUND mapping, deny/allow audit.
- `server/plugin/oauth/routes.ts` — wires `defaultWorkspaceToolDeps()`.
- `scripts/plugin-register-oauth-client.mjs` — scope allowlist now the 5 read scopes.
- Tests: `controlPlane.test.ts` (9-tool lock + mutation-name ban), `isolation.static.test.ts`
  (registry lock, still exactly the 6 HTTP paths), `routes.edge/render` metadata
  scope updates, `pluginOauthFlow.integration.test.ts` (tools/list 9, unknown
  tool `publish.stage`, field-aware cross-identity assertions), and the new
  `server/plugin/workspaceTools.integration.test.ts` (A/B/C isolation, cross-tenant
  IDOR across all 4 resource families, paused-binding hiding, malformed-arg
  rejection, scope matrix incl. `workspace:read` not leaking into `novel:read`,
  revoke, 12-round parallel mixed-account concurrency, live membership-removal,
  audit metadata shape).

No schema change, no migration (0061 unchanged), no new HTTP routes, no
client/workspace/business-logic edits. `identity.whoami` unchanged.

## Known non-goals (unchanged)

No mutation/stage/publish surface, no write tools, no workspace management,
no deploy. Chapter state is structural (tabs of latest draft) — approval/stage
evidence remains internal until a later milestone.
