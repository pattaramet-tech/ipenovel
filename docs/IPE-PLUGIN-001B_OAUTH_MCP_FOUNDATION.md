# IPE-PLUGIN-001B — OAuth + MCP Foundation / Read-only Identity Slice

Status: **READY FOR IPE-PLUGIN-001C TENANT AUTHORIZATION**
Baseline: `main` @ `2703ee9` (post PR #100 / IPE-060). No Production change, no deploy.

## What this milestone adds

An **isolated** `server/plugin/` namespace that lets an external plugin client
(e.g. a ChatGPT MCP connector) obtain scoped, revocable credentials bound to a
real IpeNovel `users.id`, and call exactly **one** read-only tool,
`identity.whoami`. Everything else - workspace, novels, packs, chapters,
drafts, checker/stage/publish, any production mutation - is structurally
absent from this slice and locked out by static surface tests.

Reused from IpeNovel (as instructed): the existing session system
(`sdk.authenticateRequest`) as the only way a human authorizes a plugin, the
repo's hash-at-rest precedents (sha256 + `timingSafeEqual`, as in
`workspaceGoogleConsentAttempts.stateHash`), the NQA control-plane shape
(`server/nqa/controlPlane.ts`: frozen capability registry, enable allowlist,
pure authorization function, audit-sink interface, strict zod envelopes,
fixed error codes), the NQA isolation discipline (`*.static.test.ts`), and
the unattended-worker factory pattern (`publishUnattendedWorker.ts`).

NOT reused (as instructed): Google tokens/flows (`server/_core/googleOAuth.ts`,
`server/workspace/googleDocs.*` are untouched and never imported by plugin
code - enforced by `isolation.static.test.ts`), NQA business logic, and no
NQA-only tier model. Plugin credentials are **opaque random values stored only
as sha256 hashes** - no ciphertext, no key-management surface at all.

## Surfaces

| Path | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/api/plugin/oauth/authorize` | GET | IpeNovel session cookie | Validates client/redirect/PKCE S256/scope, renders minimal Thai consent page |
| `/api/plugin/oauth/authorize/consent` | POST | session + CSRF (double-submit, 10-min, path-scoped cookie) | One-shot consent decision → 302 `redirect_uri?code&state` or `?error=access_denied` |
| `/api/plugin/oauth/token` | POST | `client_secret_basic` or `client_secret_post` | `authorization_code` (single-use, atomic claim, PKCE verified) and `refresh_token` (rotation + reuse detection) |
| `/api/plugin/oauth/revoke` | POST | same | RFC 7009; refresh revocation kills the whole grant family |
| `/.well-known/oauth-authorization-server` | GET | none | RFC 8414 metadata (404 unless `PLUGIN_PUBLIC_BASE_URL` set) |
| `/api/plugin/mcp` | POST | `Authorization: Bearer` | JSON-RPC 2.0 MCP transport skeleton: `initialize`, `tools/list`, `tools/call` (only `identity.whoami`), `notifications/initialized` → 202 |

**All of it 404s unless `PLUGIN_FOUNDATION_ENABLED` is exactly `"true"`** — the
flag is checked fresh in every handler, and with the flag unset the routes are
indistinguishable from not existing (proven by `routes.flagOff.test.ts`, which
runs with no database at all).

## Security properties (all proven by tests)

- **Identity binding**: codes/tokens are issued only through a session-authenticated
  consent; tokens resolve to exactly one `users.id`. Two accounts → each
  `identity.whoami` returns only its own identity
  (`pluginOauthFlow.integration.test.ts`, "multi-account identity isolation").
- **Fail-closed matrix**: forged bearer, no bearer, session-JWT-as-bearer,
  self-signed wrong-issuer JWT, expired access token, revoked (RFC 7009),
  disabled client, insufficient scope, unknown capability, unknown MCP method —
  every one rejected (401 at the edge, or JSON-RPC `-32000` with a fixed
  `data.reason`).
- **PKCE**: S256 only (`plain` rejected at authorize); verifier checked
  constant-time at exchange against the RFC 7636 Appendix B vector in unit tests.
- **Single-use**: codes are claimed by a conditional `UPDATE ... WHERE consumedAt IS NULL`
  (row-lock race-safe); consent attempts are consumed on read (replay → 400);
  cross-account consent approval is refused and burns the attempt.
- **Refresh rotation**: one-time rotation; presenting a rotated token revokes
  the entire (user, client) grant family (access + refresh).
- **Audience binding**: an authorization code issued for client A is rejected
  when presented by client B (and is burned by the attempt).
- **Sanitized errors**: token/revoke endpoints return only RFC 6749 §5.2 codes
  with FIXED descriptions; internal failures collapse to `server_error`/500;
  raw errors logged via `safeErrorSummary` only. Never echoes request data.
- **Audit**: `pluginAuditLogs` is append-only (no update/delete path exists);
  every consent/token/MCP decision gets a server-generated `plg-<uuid>`
  `correlationId`, bounded secret-free `safeMetadata`.
- **Hygiene**: `pluginTokenSweeper` (default-off, exact-literal flag) deletes
  expired codes/consent attempts/tokens on a 60s default poll.

## New tables (migration `0061_plugin_foundation`, purely additive)

`pluginOAuthClients`, `pluginOAuthConsentAttempts`, `pluginOAuthAuthorizations`,
`pluginOAuthAuthorizationCodes`, `pluginAccessGrants`, `pluginRefreshGrants`,
`pluginAuditLogs` — all in `drizzle/schema.ts`, hashed-credential columns
unique-indexed, FKs to `users` cascade, FK `pluginOAuthClients.clientId` unique.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PLUGIN_FOUNDATION_ENABLED` | off | Exact-literal `"true"` enables `/api/plugin/*` + well-known |
| `PLUGIN_PUBLIC_BASE_URL` | unset | Absolute base URL for RFC 8414 metadata only; unset → well-known 404s |
| `PLUGIN_TOKEN_SWEEPER_ENABLED` | off | Exact-literal `"true"` starts the sweeper worker |
| `PLUGIN_TOKEN_SWEEPER_POLL_MS` | `60000` | 1000–3600000, strictly validated |

Registering a client (operator, one-time, secret shown once):

```bash
node scripts/plugin-register-oauth-client.mjs \
  --name "ChatGPT Connector" \
  --redirect-uri "https://chatgpt.com/connector_platform_oauth_redirect"
```

## Test map

- Unit (no DB): `server/plugin/controlPlane.test.ts` (registry is exactly one
  READ_ONLY capability), `crypto.test.ts` (sha256 vectors, RFC 7636 vector,
  constant-time compare), `contracts.test.ts` (strict JSON-RPC/principal
  envelopes), `oauth/service.unit.test.ts` (exact-literal flag; Basic vs post
  client auth), `oauth/routes.render.test.ts` (consent-page XSS escaping,
  sanitized error mapping, metadata builder), `pluginTokenSweeper.test.ts`
  (inert by default, strict poll validation, error backoff).
- Static safety: `server/plugin/isolation.static.test.ts` — no workspace/NQA/
  routers/client/googleDocs imports anywhere under `server/plugin/`, no
  listener construction, route registration only in `routes.ts`, and the HTTP
  surface is locked to exactly the six paths; capability registry stays
  one READ_ONLY tool.
- Flag behavior: `oauth/routes.flagOff.test.ts` (every path 404 with the flag
  off, no DB present), `oauth/routes.edge.test.ts` (metadata shape; 401 +
  `WWW-Authenticate` at the MCP edge; `invalid_client` before any DB access).
- Integration + security (requires `TEST_DATABASE_URL` → `ipenovel_test`,
  runs in `test:ci`): `oauth/pluginOauthFlow.integration.test.ts` — full
  authorize→consent→exchange→MCP flow, multi-account isolation, and the full
  fail-closed matrix listed above, plus audit-row assertions.

Run: `pnpm check`, `pnpm test:unit` (or `pnpm test:gate` for the
known-failure-baseline diff), `pnpm test:ci` for integration where the test DB
is available. Integration is NOT RUN locally (no `TEST_DATABASE_URL` on this
workstation) — same external-validation pattern as IPE-058…060.

## Explicitly NOT in this milestone (deferred to IPE-PLUGIN-001C+)

- Tenant/workspace authorization and any second tool (the registry structurally
  holds only `identity.whoami`).
- `workspace.list/get`, novel/pack/chapter reads, draft/checker/stage/publish
  tools, any production mutation.
- Dynamic client registration, SSE streaming transport, consent UX in the SPA
  (current consent is a standalone server-rendered page), user-facing token
  management UI.
- Any deploy or Production change.
