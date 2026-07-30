# VPS Environment Variable Inventory

Phase 0 output for the Manus/Cloud → VPS (Coolify + MariaDB) migration. Built entirely from a source-code audit (`rg -n "process\.env|import\.meta\.env|ENV\."` across `client server scripts shared drizzle.config.* package.json`, plus reading `server/_core/env.ts` in full as the authoritative central config). **No secret values appear anywhere in this document** — names and behavior only.

Audited at repo HEAD `da3a65e16b51ed7e81cead6fd3559e444fd3a814` (origin/main).

## How to read this table

- **Build/Runtime**: *Build* = baked into the client bundle at `vite build` time (`import.meta.env.VITE_*` or an `index.html` `%VAR%` substitution) and cannot be changed without a rebuild. *Runtime* = read by the Node server process from `process.env` on every boot/request and can be changed by restarting the container.
- **Secret/Public**: *Secret* = must never be logged, committed, or exposed client-side. *Public* = safe to appear in the client bundle or logs.
- **Required/Optional**: *Required* = the app throws, refuses to start, or a core feature hard-fails without it. *Optional* = has a working default, or only degrades a specific feature.
- **VPS value source**: where the value should come from on the new VPS (Coolify's environment-variable UI, a secrets manager, or "same value as current production" if it isn't changing).
- **Verification method**: how to confirm it's set correctly *without* printing the secret — used by `scripts/vps-migration/preflight.mjs` (see that script) and the manual checklist.

## Minimum bar for "app can start"

`server/_core/healthCheck.ts`'s `getReadinessStatus()` treats exactly these four as hard-required: `DATABASE_URL`, `JWT_SECRET`, `VITE_APP_ID`, `OAUTH_SERVER_URL`. Everything else degrades a specific feature rather than blocking boot.

## Core / Auth / Session

| Variable | Build/Runtime | Secret/Public | Required/Optional | Used by | Description | VPS value source | Verification method |
|---|---|---|---|---|---|---|---|
| `DATABASE_URL` | Runtime | **Secret** | Required | `server/_core/env.ts:4`, `drizzle.config.ts:3-6`, `server/db.ts:81,83`, `scripts/migrate.mjs` | MariaDB connection string (`mysql://user:pass@host:port/db`) | Coolify-generated internal MariaDB connection string (private network hostname, not a public IP) | `preflight.mjs`: parses the URL, prints host/port/database only |
| `JWT_SECRET` | Runtime | **Secret** | Required | `server/_core/env.ts:3`, `server/_core/sdk.ts:177` | HMAC secret signing/verifying session cookies | New random 32+ byte secret generated for the VPS deployment (rotating it invalidates all existing sessions — expected on cutover) | `preflight.mjs`: presence-only check |
| `VITE_APP_ID` | **Build + Runtime** | Public identifier | Required | `server/_core/env.ts:2`, `client/src/const.ts:6`, `server/_core/sdk.ts` (session `aud` check) | Manus OAuth application/client ID | Same value as current production (tied to the registered Manus OAuth app) | `preflight.mjs`: presence-only check |
| `OAUTH_SERVER_URL` | Runtime | Public (URL) | Required for login | `server/_core/env.ts:5`, `server/_core/sdk.ts:43-48` | Base URL of the Manus OAuth backend | Same value as current production | `preflight.mjs`: presence + URL-parses check |
| `VITE_OAUTH_PORTAL_URL` | **Build** (client bundle) | Public | Required for login | `client/src/const.ts:5` | Manus OAuth login portal URL, used to build the login redirect | Same value as current production | Manual: confirm client bundle's login button navigates correctly |
| `OWNER_OPEN_ID` | Runtime | Sensitive identifier (not a credential) | Optional (empty default = never matches) | `server/_core/env.ts:6`, `server/db.ts:150` | OpenID of the app owner account; auto-grants admin role on that login | Same value as current production | `preflight.mjs`: presence-only check |
| `NODE_ENV` | Runtime (+ build) | Public | Optional (default `development`) | `vite.config.ts`, `server/_core/index.ts`, `server/_core/cookies.ts`, `server/_core/startupMigrations.ts`, `server/_core/ocr-config.ts` | Standard mode flag — gates cookie `secure`, dev logging, startup migrations, OCR production-safety checks | `production` on the VPS, always | `preflight.mjs`: reports value (not secret) |
| `PORT` | Runtime | Public | Optional (default `3000`, auto-scans +19 if busy) | `server/_core/index.ts:115-122` | HTTP listen port | Whatever Coolify's Nixpacks/Dockerfile build expects the app to bind (commonly `3000`) | `preflight.mjs`: reports value |
| `CANONICAL_HOST` | Runtime | Public | Optional (default `ipenovel.com`) | `server/_core/env.ts:40`, `server/_core/canonicalDomainRedirect.ts` | Canonical domain used by the 301-redirect middleware | The VPS-hosted production domain (change only if the domain itself changes) | `preflight.mjs`: reports value |
| `LEGACY_REDIRECT_HOSTS` | Runtime | Public | Optional (default `ipenovelz.manus.space`) | `server/_core/env.ts:41` | Comma-separated old domains that 301-redirect to `CANONICAL_HOST` | Keep the existing default; do **not** remove the old Manus subdomain — old bookmarks/links must keep resolving after cutover | `preflight.mjs`: reports value |

## Cloudflare R2 — public bucket (novel covers, banners)

| Variable | Build/Runtime | Secret/Public | Required/Optional | Used by | Description | VPS value source | Verification method |
|---|---|---|---|---|---|---|---|
| `R2_ACCOUNT_ID` | Runtime | Secret-adjacent | Optional (lazy-checked per upload) | `server/_core/env.ts:16`, `r2Storage.ts:28` | Cloudflare account ID for the public bucket | Same value as current production (same R2 bucket, unless intentionally migrating buckets) | `preflight.mjs`: reports "configured" / "not configured" only |
| `R2_ACCESS_KEY_ID` | Runtime | **Secret** | Optional (lazy) | `env.ts:17`, `r2Storage.ts:29,63` | R2 S3-compatible access key | Same as current production | configured/not-configured only |
| `R2_SECRET_ACCESS_KEY` | Runtime | **Secret** | Optional (lazy) | `env.ts:18`, `r2Storage.ts:30,64` | R2 S3-compatible secret key | Same as current production | configured/not-configured only |
| `R2_BUCKET_NAME` | Runtime | Public | Optional (lazy) | `env.ts:19`, `r2Storage.ts:31,99` | Public bucket name | Same as current production | reports value |
| `R2_PUBLIC_BASE_URL` | Runtime | Public | Optional (lazy) | `env.ts:20`, `r2Storage.ts:32,75` | Public CDN base URL for R2 media | Same as current production | reports value |
| `R2_ENDPOINT` | Runtime | Public (URL) | Optional (lazy) | `env.ts:21`, `r2Storage.ts:33,60` | R2 S3-compatible API endpoint | Same as current production | reports value |

## Cloudflare R2 — private bucket (payment slips, paid episode files)

| Variable | Build/Runtime | Secret/Public | Required/Optional | Used by | Description | VPS value source | Verification method |
|---|---|---|---|---|---|---|---|
| `R2_PRIVATE_ACCOUNT_ID` | Runtime | Secret-adjacent | Optional structurally, strictly validated when present | `env.ts:27`, `r2PrivateStorage.ts:95,146` | Cloudflare account ID for the private bucket | Same as current production | configured/not-configured only |
| `R2_PRIVATE_ACCESS_KEY_ID` | Runtime | **Secret** | Same | `env.ts:28`, `r2PrivateStorage.ts:96,147,173` | Private-bucket access key | Same as current production | configured/not-configured only |
| `R2_PRIVATE_SECRET_ACCESS_KEY` | Runtime | **Secret** | Same | `env.ts:29`, `r2PrivateStorage.ts:97,148,174` | Private-bucket secret key | Same as current production | configured/not-configured only |
| `R2_PRIVATE_ENDPOINT` | Runtime | Public (URL), must match account ID | Same | `env.ts:30`, `r2PrivateStorage.ts:98,149,170` | Private-bucket S3 endpoint | Same as current production | reports value |
| `R2_PRIVATE_BUCKET_NAME` | Runtime | Public | Same | `env.ts:31`, `r2PrivateStorage.ts:99,150,165` | Private bucket name | Same as current production | reports value |
| `R2_PRIVATE_SIGNED_URL_EXPIRES_SECONDS` | Runtime | Public | Optional (default `900`) | `env.ts:32-35` | TTL for presigned GET URLs to private objects | Same as current production, or leave unset for default | reports value |

## OCR / LLM ("Forge" platform)

| Variable | Build/Runtime | Secret/Public | Required/Optional | Used by | Description | VPS value source | Verification method |
|---|---|---|---|---|---|---|---|
| `BUILT_IN_FORGE_API_URL` | Runtime | **Secret** (internal platform API) | Optional per-var; features throw at call time if missing | `env.ts:8`, `server/storage.ts`, `dataApi.ts`, `imageGeneration.ts`, `llm.ts`, `notification.ts`, `voiceTranscription.ts` | Base URL for OCR, LLM completions, AI image generation, notifications, voice transcription, and the legacy Manus storage proxy (sports-match images) | **Must be confirmed with Manus/platform owner whether this credential keeps working after leaving Manus hosting** — see Runbook's "Known limitations" | `preflight.mjs`: configured/not-configured only |
| `BUILT_IN_FORGE_API_KEY` | Runtime | **Secret** | Same | `env.ts:9`, same call sites | Bearer token for the Forge API | Same caveat as above | configured/not-configured only |
| `OCR_ENABLED` | Runtime | Public | Optional (default `true`) | `env.ts:10`, `ocr-config.ts:70` | Master OCR feature toggle | Same as current production | reports value |
| `OCR_AUTO_APPROVE_ENABLED` | Runtime | Public | Optional; **must be `true` in production** (validated at boot) | `ocr-config.ts:71-74,137-144` | Auto-approves OCR-verified payments without manual review | Same as current production | reports value; startup validation already enforces this |
| `OCR_SHADOW_MODE` | Runtime | Public | Optional; **must be `false`/unset in production** (validated) | `ocr-config.ts:75-78,126-134` | Runs OCR checks without applying results | Unset / `false` on VPS production | reports value; startup validation already enforces this |
| `OCR_MIN_CONFIDENCE` | Runtime | Public | Optional (default `85`) | `ocr-config.ts:81-84` | Minimum confidence % to accept an OCR result | Same as current production | reports value |
| `OCR_MAX_TIME_WINDOW_MINUTES` | Runtime | Public | Optional (default `120`) | `ocr-config.ts:85-88` | Max age of a slip relative to now for OCR match | Same as current production | reports value |
| `OCR_STRICT_DUPLICATE_CHECK` | Runtime | Public | Optional (default `true`) | `ocr-config.ts:89-92` | Strict duplicate-slip detection | Same as current production | reports value |
| `OCR_METRICS_ENABLED` | Runtime | Public | Optional (default `true`) | `ocr-config.ts:95` | Enables OCR metrics collection | Same as current production | reports value |
| `OCR_DETAILED_LOGGING` | Runtime | Public | Optional | `ocr-config.ts:96-99` | Verbose OCR debug logging | Same as current production (usually off in prod) | reports value |
| `OCR_SHOW_BREAKDOWN` | Runtime | Public | Optional (default `true`) | `ocr-config.ts:102-105` | Shows OCR score breakdown to admins | Same as current production | reports value |
| `OCR_SHOW_METADATA` | Runtime | Public | Optional (default `true`) | `ocr-config.ts:106` | Shows raw OCR metadata to admins | Same as current production | reports value |

## Client-side "Forge"-adjacent (public by construction)

| Variable | Build/Runtime | Secret/Public | Required/Optional | Used by | Description | VPS value source | Verification method |
|---|---|---|---|---|---|---|---|
| `VITE_FRONTEND_FORGE_API_KEY` | **Build** (ships in client bundle) | Named like a secret, but public once shipped — **flag for platform-owner review before reuse** | Optional (falls back to a hardcoded literal in `Map.tsx:89-92` if unset) | `client/src/components/Map.tsx:89` | Frontend-facing key for the Map component / slip-image upload widget | Confirm with the platform owner this is meant to be a restricted/public key before reusing on a new domain | Manual: confirm the map/upload widget renders correctly post-cutover |
| `VITE_FRONTEND_FORGE_API_URL` | **Build** | Public | Optional | `client/src/components/Map.tsx:91` | Base URL companion to the key above | Same as current production | Manual smoke test |
| `VITE_ANALYTICS_ENDPOINT` | **Build** (`index.html` `%VAR%` substitution, not `import.meta.env`) | Public | Optional | `client/index.html:39` | Umami analytics script base URL | Same as current production, or omit if analytics isn't carried over | Manual: view page source for the substituted value |
| `VITE_ANALYTICS_WEBSITE_ID` | **Build** | Public | Optional | `client/index.html:40` | Umami analytics website ID | Same as current production | Manual: view page source |

## Misc / feature flags / vestigial

| Variable | Build/Runtime | Secret/Public | Required/Optional | Used by | Description | VPS value source | Verification method |
|---|---|---|---|---|---|---|---|
| `DISCORD_OCR_REVIEW_WEBHOOK_URL` | Runtime | **Secret** (a webhook URL is a bearer credential) | Optional (`console.warn`s and skips if unset) | `server/services/discordNotificationService.ts:171,175` | Discord webhook alerting admins when OCR flags a payment for manual review | Same as current production, if the team wants this alert preserved | configured/not-configured only |
| `PACKAGE_IMPORT_MAX_ZIP_MB` | Runtime | Public | Optional (default `30`) | `server/services/packageZipImportService.ts:11` | Max ZIP size for novel/episode package import | Same as current production | reports value |
| `PACKAGE_IMPORT_MAX_TXT_MB` | Runtime | Public | Optional (default `8`) | `server/services/packageZipImportService.ts:12` | Max TXT size for package import | Same as current production | reports value |
| `SENTRY_DSN` | Runtime | Secret-adjacent | Optional — **presence-checked only; no Sentry SDK is actually wired up anywhere in the repo** (`server/_core/healthCheck.ts:146-148`) | `healthCheck.ts:146` | Vestigial — currently a no-op. Safe to leave unset. | N/A — not implemented | N/A |
| `LOG_LEVEL` | Runtime | Public | Optional — **presence-checked only; value never consumed anywhere else** (`healthCheck.ts:150-152`) | `healthCheck.ts:150` | Vestigial — currently a no-op. Safe to leave unset. | N/A — not implemented | N/A |

## Test-only (must never be set on the VPS production environment)

| Variable | Build/Runtime | Secret/Public | Required/Optional | Used by | Description | Env scope |
|---|---|---|---|---|---|---|
| `TEST_DATABASE_URL` | Runtime | **Secret** | Required for integration tests; tests self-skip if unset | `server/test-helpers/testDb.ts`, `scripts/test-db-prepare.ts`, `vitest.integration.*` | Isolated test database connection, **must never point at production** | Test-only |
| `TEST_DATABASE_TRANSPORT` | Runtime | Public (mode flag) | Optional; only `"internal_plaintext"` has effect | `server/test-helpers/testDbConnectionOptions.ts:88-171` | Skips strict TLS for a Docker/Coolify-internal MariaDB test host, gated to exact database name `ipenovel_test` and single-label hostname | Test-only |
| `IPENOVEL_TEST_DB_DIAGNOSTICS` | Runtime | Public | Optional | `server/test-helpers/testDbDiagnostics.ts:14` | Verbose test-DB diagnostic logging | Test-only |
| `IPENOVEL_GATE_B_STEPS_OVERRIDE` | Runtime | Public | Optional | `scripts/run-gate-b.ts:129` | Overrides which CI "gate B" steps run | CI/test tooling only |

## Known documentation drift (found while auditing)

- `OCR_AUTO_APPROVE_CONFIDENCE_THRESHOLD` is mentioned in `OCR_ACTIVE_PATH_HARDENING_REPORT.md` as a configuration example, but **no code anywhere reads this name** — the real variable is `OCR_MIN_CONFIDENCE`. Do not configure `OCR_AUTO_APPROVE_CONFIDENCE_THRESHOLD` on the VPS; it would silently do nothing.

## TLS / connection-string note for `DATABASE_URL` specifically

`server/db.ts`'s production DB connection (`getDb()`) sets **no explicit TLS options** — it relies entirely on whatever query-string parameters (if any) are present in `DATABASE_URL` itself. The current production TiDB Cloud connection almost certainly requires `?ssl={"rejectUnauthorized":true}`-style parameters or equivalent in the URL today. A self-hosted MariaDB reachable only over Coolify's internal Docker network **should not** need TLS at all — when constructing the new `DATABASE_URL` for the VPS, drop any TLS query parameters that assumed a public, TLS-required TiDB Cloud endpoint. See `docs/VPS_MIGRATION_RUNBOOK.md`'s database-compatibility section for detail on the internal-network TLS assumption already partially handled in test helpers (`testDbConnectionOptions.ts`) but **not yet in the production connection path** — this is flagged there as a "needs live MariaDB verification" item, not a blocker.
