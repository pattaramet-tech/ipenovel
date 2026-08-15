# Manus / Forge Residual Runtime Dependency Audit

**Status: AUDIT ONLY.** No runtime behavior, schema, or migrations were changed to produce this document. No database was accessed. No migration was run.

**Current main SHA at time of audit:** `9ec1944ce2cf7f88bb07a29c2176c9ace1f16d87`

---

## 1. Executive summary

IpeNovel was originally built on the Manus platform, which historically provided four services via a single proxy credential pair (`BUILT_IN_FORGE_API_URL` / `BUILT_IN_FORGE_API_KEY`): object storage, LLM/vision chat completions, image generation, and a data/notification API, plus Manus's own OAuth login provider (`OAUTH_SERVER_URL`).

Prior work (already merged into `main`) has removed almost all of this:

- **Payment/wallet slip storage** now uses Cloudflare R2 (private bucket) exclusively — the Manus storage proxy is no longer in that path at all.
- **Novel covers/banners/sports-match images** now use Cloudflare R2 (public bucket) exclusively.
- **OCR/LLM** (payment-slip auto-approval) has an explicit, preferred, provider-independent path (`LLM_API_URL`/`LLM_API_KEY`/`LLM_MODEL`) that — once configured — **permanently and completely bypasses** the Manus/Forge LLM fallback; the fallback is used **only** when none of those three variables are set.
- **Login** can run entirely on Google OAuth (`AUTH_PROVIDER=google`), with the Manus login callback route reduced to an always-registered-but-404-if-inactive no-op, verified by dedicated feature-flag tests.
- **Image generation, the generic Data API, and voice transcription** helpers still exist in the codebase but have **zero reachable callers anywhere** — they are dead code, not wired into any router, cron job, or frontend feature.

What remains is narrower than "does IpeNovel depend on Manus" would suggest, but it is **three P0 items, not one**:

1. **P0-1, conditional on configuration**: the OCR/LLM pipeline (core to payment and wallet-topup auto-approval) still *supports* falling back to Manus/Forge, and does so automatically whenever the operator-owned `LLM_*` variables are unset. The code already prefers and fully supports the non-Manus path — this is purely a configuration confirmation, not a code change.
2. **P0-2, conditional on configuration, but on BOTH sides**: Manus OAuth is still the default login mechanism on **both** the server (`AUTH_PROVIDER` defaults to `"manus"`) and, independently, the client build (`VITE_AUTH_PROVIDER` defaults to the Manus branch in `client/src/const.ts`). Both must be explicitly set to `"google"` — server-side alone is not sufficient, since the client bundle bakes its own default in at build time.
3. **P0-3, unconditional, requires an actual code change**: the bank-transfer/wallet-topup QR code image shown on the Cart, Payment, and Wallet pages is a hardcoded hotlink to Manus's CloudFront CDN (`d2xsxph8kpxj0f.cloudfront.net`), with no environment variable or fallback — the only P0 finding that isn't already "just configuration."
4. **One un-gated auth edge case (P1)**: an "orphaned session" fallback in `server/_core/sdk.ts` makes a live call to Manus's OAuth server regardless of `AUTH_PROVIDER`, but only when a valid session cookie exists with no matching database user row — not part of normal steady-state traffic, but should be gated before Manus is considered fully removable.
5. **One active, admin-only, non-core feature (P1)**: `system.notifyOwner`, a tRPC mutation that sends an owner notification through the Manus Notification Service. No frontend UI currently calls it.
6. **A dozen dead-code helpers/components**: `generateImage`, `callDataApi`, `transcribeAudio`, `storagePut`/`storageGet`, three non-v2 OCR implementations, `ManusDialog.tsx`, and the unused Forge Maps proxy in `Map.tsx` — fully implemented, fully Forge-dependent, zero callers anywhere in the repo.
7. **The intentionally-retained legacy asset migration tooling** (`server/services/legacyManusAssetMigrationService.ts` and its CLI), which exists specifically to migrate *away* from Manus and must not be removed until that migration is complete in Production.
8. **A platform-level, non-code dependency**: Manus's own hosting/edge layer still overrides social-preview (`og:image`) metadata with a stale screenshot — documented as unfixable from application code, requiring Manus-side action.
9. **Doc drift**: several release-readiness and runbook documents still describe Forge storage as required for payment/wallet slip uploads, or claim sports-match/AI-generated images still use the Manus storage proxy — both claims are contradicted by code that has already shipped and should be corrected.
10. **Cosmetic/harmless references**: a legacy redirect hostname, an admin-role bootstrap value that happens to be Manus-shaped but has zero network coupling, and dev-only Vite tooling that never runs in a production build.

**Bottom line:** IpeNovel does **not** have a hard, unconditional Production dependency on Manus being reachable for payments, wallet top-ups, or reader entitlement — **provided** `LLM_*` and `AUTH_PROVIDER`/`VITE_AUTH_PROVIDER` are correctly configured on both server and client. The one genuinely unconditional, code-level dependency remaining is the hardcoded QR payment image hotlinked to Manus's CDN, which requires an actual code change (not just configuration) to remove. This audit did not have access to Production's actual deployed environment variables, so items 1-2 above should be confirmed directly against the live configuration, not assumed from source alone.

---

## 2. Current main SHA

```
9ec1944ce2cf7f88bb07a29c2176c9ace1f16d87
```

Working tree was confirmed clean (only the pre-existing, untracked `.worktrees/` directory — stale leftover git worktrees from prior sessions, excluded from this entire audit as they are not part of the real repository state) before this audit began.

---

## 3. Complete dependency inventory

Every helper/route/component that touches a Manus/Forge search term, traced to its actual runtime status.

| # | File | Export/symbol | Manus mechanism | Runtime status |
|---|---|---|---|---|
| 1 | `server/storage.ts` | `storagePut` | `POST {forgeApiUrl}v1/storage/upload` | **DEAD_CODE** — sole real caller (`generateImage`) itself has zero callers |
| 2 | `server/storage.ts` | `storageGet` | `GET {forgeApiUrl}v1/storage/downloadUrl` | **DEAD_CODE** — zero callers anywhere |
| 3 | `server/storage.ts` | `isStorageReady` | local config presence check only, no network call | reachable (used by #4), but performs no live Manus call |
| 4 | `server/helpers/uploadHealthCheck.ts` | `checkUploadServiceHealth` | logs a warning if `BUILT_IN_FORGE_*` unset | **P1_NON_CORE_ACTIVE** — runs at every startup, non-blocking, no network call |
| 5 | `server/helpers/uploadHealthCheck.ts` | `getUploadServiceStatus` | same as above | **DEAD_CODE** — zero callers |
| 6 | `server/_core/imageGeneration.ts` | `generateImage` | `POST {forgeApiUrl}images.v1.ImageService/GenerateImage` | **DEAD_CODE** — zero callers |
| 7 | `server/_core/dataApi.ts` | `callDataApi` | `POST {forgeApiUrl}webdevtoken.v1.WebDevService/CallApi` | **DEAD_CODE** — zero callers |
| 8 | `server/_core/notification.ts` | `notifyOwner` | `POST {forgeApiUrl}webdevtoken.v1.WebDevService/SendNotification` | **P1_NON_CORE_ACTIVE** — mounted as `system.notifyOwner`, admin-gated tRPC mutation, no frontend trigger |
| 9 | `server/_core/voiceTranscription.ts` | `transcribeAudio` | `POST {forgeApiUrl}v1/audio/transcriptions` | **DEAD_CODE** — unused template; file's own trailing comment shows a `voiceRouter` that was never added |
| 10 | `server/_core/llm.ts` | `resolveLLMRuntimeConfig` / `invokeLLM` | `POST {forgeApiUrl or forge.manus.im}/v1/chat/completions` | **P0_RUNTIME_BLOCKER (conditional)** — sole production caller chain is payment/wallet OCR slip verification; falls back to Manus only when `LLM_API_URL`/`LLM_API_KEY`/`LLM_MODEL` are all unset |
| 11 | `server/ocr-slip-verification.ts` (v1) | `parseSlipImage` et al. | via `invokeLLM` | **DEAD_CODE** — only imported by `ocr-slip-integration.ts` and test files, neither reachable from any router/service |
| 12 | `server/ocr-slip-integration.ts` | wrapper around v1 | — | **DEAD_CODE** — zero importers outside its own test files |
| 13 | `server/ocr-slip-verification-hardened.ts` | alternate implementation | via `invokeLLM` | **DEAD_CODE** — zero importers anywhere, not even tests |
| 14 | `server/ocr-slip-verification-improved.ts` | alternate implementation | via `invokeLLM` | **DEAD_CODE** — only imported by `ocr-improvements.test.ts` |
| 15 | `server/ocr-slip-verification-v2.ts` | `parseSlipImage`, `invokeLLMWithOcrRetry` | via `invokeLLM` | **ACTIVE** — the real production implementation (see #10) |
| 16 | `server/_core/oauth.ts` + `server/_core/index.ts` (`registerOAuthRoutes`) | Manus OAuth callback (`/api/oauth/callback`) | `{oAuthServerUrl}` token exchange + user-info fetch | **P0_RUNTIME_BLOCKER (conditional)** — always registered; internally 404s only when `AUTH_PROVIDER` is exactly `"google"` |
| 17 | `client/src/const.ts` | `buildManusLoginUrl`, `resolveLoginUrl`, `getLoginUrl` | builds `{VITE_OAUTH_PORTAL_URL}/app-auth` link | **P0_RUNTIME_BLOCKER (conditional)** — client fails **closed to Manus** for any `VITE_AUTH_PROVIDER` value other than the exact literals `"google"`/`"transition"` |
| 18 | `client/src/pages/LoginPage.tsx` | renders Manus login link | via #17 | active whenever `VITE_AUTH_PROVIDER="transition"` (intentional legacy fallback) or unset (unintentional default) |
| 19 | `server/_core/sdk.ts` (`authenticateRequest`) | orphaned-session fallback | `getUserInfoWithJwt` → `{oAuthServerUrl}` | **P1_NON_CORE_ACTIVE** — real live network call to Manus, **not gated by `AUTH_PROVIDER` at all**; fires only when a valid session JWT has no matching DB user row |
| 20 | `client/src/constants/payment.ts`, `CartPage.tsx`, `PaymentPage.tsx`, `WalletPage.tsx` | `QR_PAYMENT_IMAGE` | hardcoded `https://d2xsxph8kpxj0f.cloudfront.net/...` (Manus's asset CDN) | **P0_RUNTIME_BLOCKER (unconditional)** — no env var gates this; bank-transfer/wallet-top-up QR code image is hotlinked directly from Manus's CDN |
| 21 | `client/src/components/ManusDialog.tsx` | "Login with Manus" modal | — | **DEAD_CODE** — zero importers |
| 22 | `client/src/components/Map.tsx` | Forge Maps JS proxy (`VITE_FRONTEND_FORGE_API_KEY`/`URL`) | proxies Google Maps via Manus's Forge Maps proxy | **DEAD_CODE** — zero importers, no map feature exists in the app |
| 23 | `server/services/legacyManusAssetMigrationService.ts`, `scripts/migrate-legacy-manus-assets-to-r2.ts` | legacy asset migration | reads from `MANUS_CLOUDFRONT_HOSTNAME` (`d2xsxph8kpxj0f.cloudfront.net`), writes to R2 | **MIGRATION_ONLY** — intentionally retained until Production legacy assets are fully migrated; not a cutover blocker |
| 24 | `server/_core/canonicalDomainRedirect.ts` | 301 redirect for `LEGACY_REDIRECT_HOSTS` (default `ipenovelz.manus.space`) | incoming-request hostname match only, no outbound call | **Non-dependency reference** — reachable on every request, but has zero coupling to Manus's live availability |
| 25 | `server/db.ts` | `OWNER_OPEN_ID` comparison at user-upsert | local string equality only | **Non-dependency reference** — historically Manus-shaped value, zero network coupling |
| 26 | `vite.config.ts`, `vite-plugin-manus-runtime` (package.json dep), `client/public/__manus__/debug-collector.js` | dev/build tooling | Manus Cloud IDE preview/debug tooling | **DEV-TOOLING-ONLY** — `transformIndexHtml` explicitly no-ops when `NODE_ENV === "production"`; never reachable from `node dist/index.js` |
| 27 | `client/src/pages/AdminSettingsPage.tsx` | static copy: "Manus built-in payment system" (line ~247) and "Auth: Manus OAuth" (line ~652) | display-only text, no function call | **Non-dependency reference** — the payment-system line is stale/inaccurate (actual flow is manual bank transfer + QR + OCR); the OAuth line is accurate today but purely informational |
| 28 | `client/src/_core/hooks/authClientStorage.ts` | `LEGACY_AUTH_LOCALSTORAGE_KEY = "manus-runtime-user-info"` | clears a stale localStorage key on logout | **Non-dependency reference** — client-side cleanup only |
| 29 | Manus's own hosting/edge layer (not repo code) | `og:image`/`og:title`/`og:description` override via `files.manuscdn.com/webdev_screenshots/...` | Manus platform-level social-preview screenshot injection | **Platform-level, non-code dependency** — documented in `docs/PERFORMANCE_SEO_AUDIT.md` Part D as a still-open limitation; explicitly **not fixable from application code**, requires Manus-side/DNS-cutover action |

Note on a name collision found by the tests/docs sweep: `.manus/db/` (gitignored, confirmed untracked) is a **local editor/agent tool's query-history cache directory**, unrelated to the production Manus hosting/Forge dependency covered by this audit. It surfaces only in `server/_core/localAdminLoginRemovalStaticSafety.test.ts` and should not be conflated with items 1-29 above.

### Known doc/code drift (informational — not a runtime finding, but material to any operator reading these docs)

Several root-level historical report docs (`WALLET_PRODUCTION_DEPLOYMENT.md`, `RELEASE_READINESS_REPORT.md`, `SLIP_UPLOAD_DIAGNOSTICS.md`, `FINAL_RELEASE_READINESS.md`) state that `BUILT_IN_FORGE_API_URL`/`BUILT_IN_FORGE_API_KEY` must be configured for **payment-slip and wallet-topup file storage** to work (e.g. `SLIP_UPLOAD_DIAGNOSTICS.md`: *"Root Cause: BUILT_IN_FORGE_API_URL or BUILT_IN_FORGE_API_KEY not set"*). This is now **stale** — `server/services/manusRemovalStaticAssertions.test.ts`, `fileService.test.ts`, and `slipFileUploadService.test.ts` all prove the current code path for episode files and payment slips uses `putPrivateObject` (R2), never `storagePut`. These docs describe a pre-R2-migration architecture and should be updated or archived to avoid an operator wrongly believing Forge credentials gate slip uploads.

Similarly, `docs/VPS_MIGRATION_RUNBOOK.md` §13 states the "legacy Manus storage proxy is still actively used for sports-match images and AI-generated images" — the sports-match-image half of that claim is contradicted by `server/sportsMatchImageUpload.test.ts` (already migrated to R2 via `optimizeAndUploadToR2()`), and the AI-generated-images half is contradicted by this audit's own finding that `generateImage()` has zero callers (item 6, DEAD_CODE). This runbook document predates both of those changes and should be refreshed before being used as a cutover reference.

`docs/VPS_ENVIRONMENT_INVENTORY.md`, by contrast, is consistent with this audit's findings and is the most current/accurate of the three doc sources reviewed — it correctly lists `OAUTH_SERVER_URL`/`VITE_OAUTH_PORTAL_URL`/`VITE_APP_ID` as hard-required for login, correctly notes `AUTH_PROVIDER` "defaults to manus... until an explicit, separate cutover decision," and correctly notes `BUILT_IN_FORGE_*` "features throw at call time if missing" (no longer gates storage, only the OCR/LLM fallback + the dead notification/imageGen/voiceTranscription helpers). **This audit did not access actual deployed Production environment variables** — the doc's statement of intended defaults should still be confirmed directly against the live Production config, not assumed from static inspection alone.

---

## 5. P0 runtime blockers

| Item | File / symbol | Direct caller(s) | Final entry point | User-facing feature | Recommended action |
|---|---|---|---|---|---|
| **P0-1: Manus/Forge LLM fallback** | `server/_core/llm.ts` (`resolveLLMRuntimeConfig`, `invokeLLM`) | `ocr-slip-verification-v2.ts` (`parseSlipImage`, `invokeLLMWithOcrRetry`) | `payment.uploadSlipFile`, `wallet.uploadTopupSlip` (`server/routers.ts:708,880,2580,2588`) | Order payment slip OCR verification; wallet top-up slip OCR verification | Set `LLM_API_URL`/`LLM_API_KEY`/`LLM_MODEL` in Production (operator-owned, OpenAI-compatible provider). Code already fully supports and prefers this — no code change required, only configuration. |
| **P0-2: Manus OAuth login** | `server/_core/oauth.ts` + `client/src/const.ts` (`resolveLoginUrl`) | `server/_core/index.ts` (`registerOAuthRoutes`, always registered); `client/src/pages/LoginPage.tsx` | `/api/oauth/callback`; Manus OAuth portal link on the login page | Primary account login, including admin login | Set **both** `AUTH_PROVIDER=google` (server) **and** `VITE_AUTH_PROVIDER=google` (client build-time) in Production. Both must be set together — see §11. Code already fully supports this; the Manus route fails closed to 404 when server-side flag is `google`. |
| **P0-3: QR payment image hotlinked to Manus CDN** | `client/src/constants/payment.ts` (`QR_PAYMENT_IMAGE`), `CartPage.tsx`, `PaymentPage.tsx`, `WalletPage.tsx` | rendered directly as `<img src=...>` | Checkout page, payment page, wallet top-up page | Bank-transfer QR code shown to every paying/topping-up user | **Requires a code change** (unlike P0-1/P0-2): download the QR image(s) from `d2xsxph8kpxj0f.cloudfront.net`, upload to R2 (public bucket, same as covers/banners), update the three constants to the R2 URL. No env var can fix this — it is hardcoded, unconditional, and not currently covered by the legacy asset migration tooling (which targets DB-referenced assets, not hardcoded frontend constants). |

**Note on "conditional" vs "unconditional":** P0-1 and P0-2 are blockers only under default/unconfigured settings — the code has already been written to fully support a Manus-free deployment and simply needs the correct environment variables set. P0-3 is a genuine, unconditional code-level dependency with no configuration escape hatch; it requires an actual code change to remove.

---

## 6. P1 non-core active dependencies

| Item | File / symbol | Direct caller(s) | Final entry point | User-facing feature | Recommended action |
|---|---|---|---|---|---|
| **P1-1: notifyOwner** | `server/_core/notification.ts` (`notifyOwner`) | `server/_core/systemRouter.ts` (`system.notifyOwner`, adminProcedure) | `trpc.system.notifyOwner` mutation, mounted on `appRouter` | None currently (no frontend UI calls it; reachable only via direct API/tRPC call by an authenticated admin) | Low priority — either wire to a non-Manus notification channel (Discord webhook already exists elsewhere in the codebase, `discordNotificationService.ts`, confirmed independent of Manus) or remove if unused. |
| **P1-2: checkUploadServiceHealth** | `server/helpers/uploadHealthCheck.ts` | `server/_core/index.ts`, inside `server.listen()` success callback | Startup log line only | None — non-blocking, performs no network call, just checks env var presence | Safe to leave, remove, or repoint at R2 config once Forge storage is fully decommissioned. Not urgent. |
| **P1-3: Orphaned-session Manus fallback** | `server/_core/sdk.ts` (`authenticateRequest`) | every authenticated request, on DB-lookup-miss for an otherwise-valid session JWT | live network call to `{OAUTH_SERVER_URL}` via `getUserInfoWithJwt` | Session recovery for a narrow edge case (valid signed session cookie, no matching DB user row) | **Should be fixed before declaring Manus fully removable** — this is the one path in the entire auth system not gated by `AUTH_PROVIDER`. If Manus's OAuth server becomes unreachable, any user hitting this specific edge case will get a hard error instead of a graceful re-login prompt. Recommend gating this fallback behind `isManusAuthActive()` the same way the rest of the auth system is gated, with a fallback to a plain re-authentication prompt when Manus auth is inactive. |

---

## 7. Dead code

| # | File / symbol | Evidence |
|---|---|---|
| 1 | `server/storage.ts` — `storagePut` | Sole real caller (`generateImage`) has zero callers; also a literal unused import in `server/_core/index.ts:11` |
| 2 | `server/storage.ts` — `storageGet` | Zero callers anywhere |
| 3 | `server/helpers/uploadHealthCheck.ts` — `getUploadServiceStatus` | Zero callers anywhere |
| 4 | `server/_core/imageGeneration.ts` — `generateImage` | Zero callers anywhere (not routers, not client, not scripts) |
| 5 | `server/_core/dataApi.ts` — `callDataApi` | Zero callers anywhere |
| 6 | `server/_core/voiceTranscription.ts` — `transcribeAudio` | Zero callers; file's own trailing comment shows an example `voiceRouter` that was never actually added to `routers.ts` |
| 7 | `server/ocr-slip-verification.ts` (v1) | Only imported by `ocr-slip-integration.ts` and test files, neither reachable from any router/service |
| 8 | `server/ocr-slip-integration.ts` | Zero importers outside its own test files |
| 9 | `server/ocr-slip-verification-hardened.ts` | Zero importers anywhere, not even tests |
| 10 | `server/ocr-slip-verification-improved.ts` | Only imported by `ocr-improvements.test.ts` |
| 11 | `client/src/components/ManusDialog.tsx` | Zero importers anywhere in `client/src` |
| 12 | `client/src/components/Map.tsx` (Forge Maps proxy, `VITE_FRONTEND_FORGE_API_KEY`/`URL`) | Zero importers anywhere; no map feature exists in the app |

**Recommended action for all of the above:** safe to delete entirely — none are reachable from any router, cron job, or frontend component. Deleting them also removes the last textual references to `BUILT_IN_FORGE_API_URL`/`KEY` from 6 of the 12 files, which will make the eventual "grep for Manus" pass much cleaner. (Per the audit-only constraint, no deletions were performed as part of this task.)

---

## 8. Docs/test-only references

**Tests that only assert/describe Manus-related behavior without it being a live production dependency of the test subject itself**, or that are testing already-dead code paths:

- `server/services/manusRemovalStaticAssertions.test.ts` — pure static source-text assertions (regex over `readFileSync`) proving `storagePut` is no longer imported/called by `slipFileUploadService.ts`/`fileService.ts`.
- `server/_core/sitemap.test.ts` — single assertion that generated sitemap XML never contains `"manus.space"`.
- `client/src/_core/hooks/authClientStorage.test.ts`, `migrationGate.test.ts`, `client/src/pages/profileGoogleConnectStatus.test.ts`, `client/src/const.test.ts` — client-side behavioral tests of Manus/Google branching logic; these test currently-live code (const.ts, item 17) but are themselves just test files, not separate dependencies.
- `server/_core/googleOAuthStaticSafety.test.ts` — static assertions confirming the Manus OAuth handler and `manusTypes.ts` remain untouched/imported, and that `AUTH_PROVIDER` comparisons remain exact-literal (no normalization).
- `server/_core/googleMigrationGate.test.ts`, `oauth.featureFlag.test.ts`, `googleMigrationGateMiddleware.test.ts` — behavioral tests of Google-migration gating logic using `"manus"` as one of the literal input values under test.
- `server/googleOpenId.test.ts`, `googleIdentityConnect.integration.test.ts`, `authGoogleConnected.test.ts`, `authGoogleConnectionCutoffStatus.test.ts`, `accountRecoveryRouter.test.ts`, `accountRecoveryService.test.ts`, `googleIdentityService.test.ts` — Manus appears only as fixture data (`loginMethod: "manus"`) to model an existing Manus-authenticated user while testing unrelated Google-connect/account-recovery flows; noise-level relevance.
- `server/_core/localAdminLoginRemovalStaticSafety.test.ts` — asserts `.manus/db/` (the unrelated local tool-cache directory, see note under §3/§4) is gitignored and untracked.
- Pure-noise files (fixture literal `loginMethod: "manus"` or a passing comment only): `server/daily-checkin.test.ts`, `server/daily-checkin-ui-safety.test.ts`, `server/hybrid-access-regression.test.ts`, `server/auth.logout.test.ts`, `server/services/hybridHealthQueries.static.test.ts`, `server/hybridHealthPlaintextAudit.integration.test.ts`, `server/services/r2PrivateStorage.test.ts`, `server/checkout-after-slip-upload-diagnosis.integration.test.ts`, `server/migration-0024-episode-schema-repair.integration.test.ts`, `server/test-helpers/testDbConnectionOptions.test.ts`, `server/tests/final-regression.test.ts`, `server/tests/phase1-2.test.ts`.

**Tests that exercise a currently-live production code path** (listed here because they're docs/test artifacts, but flagged as testing real, active code, not dead code): `server/_core/googleOAuth.test.ts` (Manus callback end-to-end across all 3 `AUTH_PROVIDER` values), `server/tests/regression.test.ts` ("Area 1: Manus Auth Login/Session Protection"), `server/_core/canonicalDomainRedirect.test.ts`, `server/ocr-slip-verification-v2.retry.test.ts` (legacy_forge retry semantics), `server/services/ocrImageInputService.test.ts` (legacy_forge transport mode).

**Docs that are current/accurate and describe live dependencies** (not stale, but doc-only — no separate code dependency beyond what's already captured in §3-6): `docs/VPS_ENVIRONMENT_INVENTORY.md`, `docs/VPS_MIGRATION_CHECKLIST.md`, `docs/VPS_ROLLBACK_PLAN.md`, `docs/PERFORMANCE_SEO_AUDIT.md` (including the platform-level OG-screenshot finding, item 29 in §3).

**Docs that are stale/superseded** (see "Known doc/code drift" under §3-4): `WALLET_PRODUCTION_DEPLOYMENT.md`, `RELEASE_READINESS_REPORT.md`, `SLIP_UPLOAD_DIAGNOSTICS.md`, `FINAL_RELEASE_READINESS.md`, `docs/VPS_MIGRATION_RUNBOOK.md` (§13 specifically).

**Docs with only incidental/historical mentions, no action needed**: `docs/TEST_INFRASTRUCTURE.md`, `docs/TEST_BASELINE.md`, `docs/INCIDENT_DAILY_CHECKIN_ROLLBACK.md`, `docs/INCIDENT_MIGRATION_0024_EPISODES_CONTENT.md`, `WALLET_BONUS_FINAL_HANDOFF.md`, `DEPLOYMENT_SUMMARY.md`, `PHASE1_API_VERIFICATION_SCRIPTS.md`, `PHASE_1_2_SUMMARY.md`, `PRODUCTION_SMOKE_TEST.md`, `BUG_AUDIT_REPORT.md`, `BUG_FIX_SUMMARY.md`, `DESIGN_01/02/03_*.md`, `OCR_SLIP_AUTO_APPROVAL_FINAL.md`, `OCR_STAGING_DELIVERY.md`, `PRODUCTION_RELEASE.md`, `QA_REVIEW.md`, `REGRESSION_TEST_PLAN.md`, `PHASE1_FINAL_REPORT_TEMPLATE.md`, `todo.md`.

---

## 9. Migration-only references

Per explicit instruction, these are **not** cutover blockers — they exist specifically to migrate assets/data *away* from Manus and must be retained until that migration is complete in Production:

- `server/services/legacyManusAssetMigrationService.ts` + `.test.ts` — downloads legacy assets from `d2xsxph8kpxj0f.cloudfront.net` (Manus's CDN, `MANUS_CLOUDFRONT_HOSTNAME`), validates via magic-byte MIME detection, re-uploads to R2.
- `scripts/migrate-legacy-manus-assets-to-r2.ts` + `server/legacyManusAssetMigrationCli.test.ts` — CLI wrapper; only a `:dry` variant exists in `package.json` scripts (fail-closed by design, live run must be invoked manually).
- `scripts/vps-migration/preflight.mjs` + `scripts/vps-migration/README.md` — read-only, one-time cutover diagnostic tool for the broader Manus/Cloud → VPS migration (`docs/VPS_MIGRATION_RUNBOOK.md`); requires an explicit `--ack-read-only` flag; never connects to a database or makes a network call; only reports env-var presence/shape (never values) for a `Forge/OCR platform` group among several others.
- `docs/LEGACY_MANUS_ASSET_MIGRATION.md` — documentation for the asset migration service above.
- `docs/VPS_MIGRATION_RUNBOOK.md`, `docs/VPS_MIGRATION_CHECKLIST.md`, `docs/VPS_ROLLBACK_PLAN.md` — the broader hosting-migration plan (Manus/Cloud → VPS/Coolify), status "Phase 0, not yet executed." Note the §13 staleness flagged in §3-4 above should be corrected before this runbook is relied upon operationally.

---

## 10. Environment-variable inventory

Variable names only — no secret values were read or printed anywhere in this audit.

| VAR NAME | Where read | Required/Optional | Active feature | What happens when missing | Production blocker? | Replacement/removal plan |
|---|---|---|---|---|---|---|
| `BUILT_IN_FORGE_API_URL` | `server/_core/env.ts` (`forgeApiUrl`) | Optional (per-feature) | Legacy Forge LLM fallback (P0-1); dead: storage, image gen, data API, voice transcription | Each consuming function throws/returns an error at call time; LLM fallback defaults to hardcoded `forge.manus.im` if key is set but URL isn't | **Conditional** — blocks OCR/LLM only if `LLM_*` also unset | Set `LLM_API_URL` instead; once set, this var becomes fully unused for the LLM path (still referenced by dead helpers) |
| `BUILT_IN_FORGE_API_KEY` | `server/_core/env.ts` (`forgeApiKey`) | Optional (per-feature) | Same as above | Same as above; OCR/LLM legacy_forge mode throws if unset and no generic vars set | **Conditional** — same as above | Set `LLM_API_KEY` instead |
| `LLM_API_URL` | `server/_core/env.ts` / `llm.ts` input | Optional, but required-with-the-other-two once any is set | Generic (operator-owned) LLM provider for OCR/LLM | If exactly one/two of the three generic vars is set (not all three), `resolveLLMRuntimeConfig` throws naming the missing one | N/A (this is the replacement path) | This + `LLM_API_KEY` + `LLM_MODEL` are the target end-state configuration |
| `LLM_API_KEY` | same | same | same | same | N/A | same |
| `LLM_MODEL` | same | same | same | same | N/A | same |
| `OAUTH_SERVER_URL` | `server/_core/env.ts` (`oAuthServerUrl`) | Required for Manus auth mode; also used un-gated by the sdk.ts orphaned-session fallback (P1-3) | Manus OAuth login (P0-2); orphaned-session recovery (P1-3) | Manus login/token-exchange calls fail; the P1-3 fallback throws for that edge case | **Yes, if `AUTH_PROVIDER` is not `google`**; edge-case-only otherwise | Not removable until P1-3 is gated behind `isManusAuthActive()` |
| `VITE_OAUTH_PORTAL_URL` | `client/src/const.ts` | Required for Manus login link | Manus OAuth login (P0-2), client-side URL construction | Login link would build with an empty/undefined base — broken link | **Yes, if `VITE_AUTH_PROVIDER` is not `google`** | Not needed once client is confirmed on Google-only |
| `VITE_APP_ID` | client-side (per `docs/VPS_ENVIRONMENT_INVENTORY.md`) | Required for Manus login mode | Manus OAuth app identification | Login link malformed | **Yes, if `AUTH_PROVIDER`/`VITE_AUTH_PROVIDER` not `google`** | Same as above |
| `AUTH_PROVIDER` | `server/_core/env.ts` (`resolveAuthProviderMode`) | Optional, exact-literal `"google"`\|`"transition"`, default `"manus"` | Server-side auth mode selection | Defaults to `"manus"` for any unset/unrecognized value — this is the control variable for P0-2 | **This IS the P0-2 control switch** | Set to `"google"` in Production |
| `VITE_AUTH_PROVIDER` | `client/src/const.ts` (`resolveLoginUrl`) | Optional, exact-literal `"google"`\|`"transition"`, default falls to Manus branch | Client-side auth mode selection (build-time, baked into the bundle) | Defaults to building the Manus login link for any unset/unrecognized value | **This IS the client half of the P0-2 control switch** | Set to `"google"` at build time; must match server-side `AUTH_PROVIDER` |
| `AUTH_REQUIRE_GOOGLE_CONNECTION` | `server/_core/env.ts` | Optional | Google-account-linking enforcement gate | Gate stays off | No | N/A — unrelated to Manus removal, only relevant during transition mode |
| `AUTH_REQUIRE_GOOGLE_CONNECTION_AFTER` | `server/_core/env.ts` | Optional | Cutoff timestamp for the above gate | Gate stays off | No | N/A |
| `AUTH_FORCE_RELOGIN_AFTER` | `server/_core/env.ts` | Optional | Forced re-login cutoff | Feature stays off | No | N/A |
| `LEGACY_REDIRECT_HOSTS` | `server/_core/env.ts` (default `ipenovelz.manus.space`) | Optional | 301-redirect from legacy Manus subdomain to canonical domain | Falls back to hardcoded default; harmless either way | No — zero live Manus API coupling | Keep indefinitely for old-link compatibility; does not require Manus to be reachable |
| `OWNER_OPEN_ID` | `server/_core/env.ts` (`ownerOpenId`) | Optional | Local string-equality check granting "admin" role at first user-upsert | No auto-admin assignment on first login | No — zero network coupling | Keep as-is or replace value; not a Manus API dependency |
| `VITE_FRONTEND_FORGE_API_KEY` | `client/src/components/Map.tsx` | Optional | Forge Maps proxy (dead code — `Map.tsx` has zero importers) | No effect, feature is unreachable | No | Safe to remove once `Map.tsx` is deleted |
| `VITE_FRONTEND_FORGE_API_URL` | `client/src/components/Map.tsx` | Optional | Same as above | Same as above | No | Same as above |

---

## 11. Auth independence assessment

**Question: Can Production operate with Manus auth unavailable and `AUTH_PROVIDER=google`?**

**Answer: Yes for the steady-state, with one un-gated edge case, and only if BOTH the server and client are configured consistently.**

Evidence:

1. **Server-side gating is sound.** `server/_core/env.ts`'s `isManusAuthActive()` returns true only when `AUTH_PROVIDER` is exactly `"manus"` (default) or `"transition"`. `server/_core/oauth.ts`'s `/api/oauth/callback` handler — always registered at the Express level, per `server/_core/index.ts:99`'s comment "kept for rollback" — checks this flag internally and returns a plain 404 for any request when `AUTH_PROVIDER === "google"`. `server/_core/googleOAuth.test.ts` behaviorally exercises all three literal values and confirms the 404 behavior. `server/_core/googleOAuthStaticSafety.test.ts` further proves the Manus handler code itself is untouched (not deleted, just gated) and that the comparison is exact-literal with no normalization — so no typo or casing variant of `"google"` accidentally activates or deactivates the gate.

2. **Client-side gating requires a separate, matching build-time variable.** `client/src/const.ts`'s `resolveLoginUrl` independently defaults to building a Manus OAuth portal link (`${VITE_OAUTH_PORTAL_URL}/app-auth`) for **any** `VITE_AUTH_PROVIDER` value other than the exact literals `"google"`/`"transition"` — confirmed by `client/src/const.test.ts` including typo cases. **This means `AUTH_PROVIDER=google` alone on the server is not sufficient** — if the client bundle was built with `VITE_AUTH_PROVIDER` unset or misconfigured, users would still be shown a link to Manus's login portal, which would then correctly 404 against the server (safe, but broken UX — not a working login flow). Both variables must be set consistently, and since `VITE_*` variables are baked in at build time, this must be verified in the actual build artifact, not just the runtime environment.

3. **One un-gated exception exists: the orphaned-session fallback (P1-3, §6).** `server/_core/sdk.ts`'s `authenticateRequest` verifies the session JWT locally and looks up the user in the DB; if the JWT is valid but no DB row matches, it calls Manus's OAuth server (`getUserInfoWithJwt` → `OAUTH_SERVER_URL`) **regardless of `AUTH_PROVIDER`**. In normal operation (existing users, fresh Google logins) this path is never reached — but it is not proven safe if Manus's OAuth server becomes fully unreachable, since the call would simply fail rather than gracefully fall through to a re-login prompt.

4. **What is proven by static inspection:** for the normal login/session-verification/logout/admin-access steady state, Production can run entirely without Manus reachability, provided `AUTH_PROVIDER=google` (server) and `VITE_AUTH_PROVIDER=google` (client build) are both set.

5. **What is NOT provable by static inspection alone, and requires a STAGING test:**
   - Deploy STAGING with `AUTH_PROVIDER=google` and a client build with `VITE_AUTH_PROVIDER=google`, and with `OAUTH_SERVER_URL` either unset or pointed at a deliberately unreachable endpoint.
   - Test (a): fresh new-user Google login — confirm success end-to-end (OAuth handshake, session cookie issuance, DB user creation).
   - Test (b): existing previously-Manus-authenticated user completing Google account linking — confirm success (exercises `accountRecoveryRouter`/`googleIdentityService` interplay with a pre-existing `loginMethod: "manus"` row).
   - Test (c): session persistence and logout for a Google-authenticated session.
   - Test (d) — the specific unproven case: construct a valid signed session cookie for a user id that has since been deleted from (or never inserted into) the database, and issue a request with it while `OAUTH_SERVER_URL` is unreachable. Confirm whether `authenticateRequest`'s orphaned-session fallback fails gracefully (e.g. treated as unauthenticated, prompted to re-login) or throws an unhandled error/500. This is the one path whose behavior under actual Manus-unreachability cannot be determined from source alone, since it depends on the real network failure mode of `fetch`/`getUserInfoWithJwt` against a dead endpoint — recommend gating this fallback behind `isManusAuthActive()` before relying on Manus's full removal, per P1-3's recommended action.

---

## 12. Proposed fix sequence

1. **Confirm current Production values** of `AUTH_PROVIDER`, `VITE_AUTH_PROVIDER`, `LLM_API_URL`/`LLM_API_KEY`/`LLM_MODEL` directly (this audit had no access to deployed env vars — only source code). This determines whether P0-1 and P0-2 are already resolved by configuration or still open.
2. **P0-1 (OCR/LLM fallback):** if not already set, configure `LLM_API_URL`/`LLM_API_KEY`/`LLM_MODEL` in Production. Pure configuration change, no code change, no deploy of new code required.
3. **P0-2 (Manus OAuth login):** if not already set, set `AUTH_PROVIDER=google` server-side AND rebuild the client with `VITE_AUTH_PROVIDER=google`. Requires a rebuild (client env vars are build-time), but no source code change. Run the STAGING tests from §11 item 5 before flipping in Production.
4. **P1-3 (orphaned-session fallback):** code change — gate `sdk.ts`'s `authenticateRequest` Manus fallback behind `isManusAuthActive()`, with a graceful re-authentication response when inactive. Do this before treating Manus as fully removable, even though it's non-blocking for normal operation.
5. **P0-3 (QR payment image):** code change — migrate the three hardcoded `d2xsxph8kpxj0f.cloudfront.net` QR image URLs (`constants/payment.ts`, `CartPage.tsx`/`PaymentPage.tsx`/`WalletPage.tsx`) to self-hosted R2 assets. This is the only P0 item requiring an actual code change with no configuration escape hatch.
6. **Dead code cleanup (§7):** delete `storagePut`/`storageGet`/`getUploadServiceStatus`/`generateImage`/`callDataApi`/`transcribeAudio`, the non-v2 OCR implementations, `ManusDialog.tsx`, and `Map.tsx`. Low risk (zero reachable callers, confirmed by grep across the whole repo), removes 6+ files' worth of remaining `BUILT_IN_FORGE_*` references.
7. **P1-1/P1-2 cleanup (optional, low priority):** decide whether to keep, rewire, or remove `notifyOwner`/`system.notifyOwner` and `checkUploadServiceHealth`.
8. **Doc drift correction:** update or archive `WALLET_PRODUCTION_DEPLOYMENT.md`, `RELEASE_READINESS_REPORT.md`, `SLIP_UPLOAD_DIAGNOSTICS.md`, `FINAL_RELEASE_READINESS.md` (all describe pre-R2-migration storage requirements that no longer apply), and refresh `docs/VPS_MIGRATION_RUNBOOK.md` §13 (incorrectly states sports-match/AI-generated images still use the Manus storage proxy).
9. **Platform-level item (§3 item 29):** raise the stale Manus OG-screenshot override (`files.manuscdn.com`) with whoever administers the Manus platform account/DNS — not fixable from this repository, tracked separately from code cutover.
10. **Legacy asset migration (MIGRATION_ONLY, §9):** continue independently on its own timeline; not gated by or gating any of the above.

---

## 13. Cutover acceptance criteria

Manus/Forge can be considered fully non-blocking for Production cutover when **all** of the following are true:

- [ ] `LLM_API_URL`/`LLM_API_KEY`/`LLM_MODEL` are confirmed set in Production, and a real payment-slip or wallet-topup OCR submission has been observed going through the generic LLM path (not `legacy_forge`) in Production logs/metrics.
- [ ] `AUTH_PROVIDER=google` confirmed set in Production; client bundle confirmed built with `VITE_AUTH_PROVIDER=google`; STAGING tests (a)-(d) from §11 item 5 all pass, including the orphaned-session-under-Manus-unreachable case.
- [ ] `sdk.ts`'s orphaned-session fallback (P1-3) is gated behind `isManusAuthActive()` (code change shipped and verified in STAGING).
- [ ] The QR payment image (P0-3) is served from R2 (or another owned host), not `d2xsxph8kpxj0f.cloudfront.net`, verified on all three of Cart/Payment/Wallet pages.
- [ ] `BUILT_IN_FORGE_API_URL`/`BUILT_IN_FORGE_API_KEY` can be unset in Production without any functional regression (dead-code helpers have no callers; `notifyOwner`/`checkUploadServiceHealth` either removed or confirmed acceptable to lose).
- [ ] Stale docs (§8) updated or archived so no operator runbook claims a dependency that no longer exists in code.
- [ ] The legacy asset migration (MIGRATION_ONLY, §9) is explicitly tracked as a separate, independent workstream — its completion is not a prerequisite for the above, and its retirement (deleting the migration service/CLI/docs) should only happen after Production's legacy Manus-hosted assets are confirmed fully migrated.
- [ ] The platform-level OG-screenshot override (§3 item 29) is either resolved with Manus or explicitly accepted as a known, permanent limitation.



## 4. Active call-site evidence

Full traced chains for every item classified P0 or P1 above.

**Chain A — OCR/LLM Manus fallback (item 10):**
`server/routers.ts` (`payment.uploadSlipFile`, lines 708 & 880; `wallet.uploadTopupSlip`, lines 2580/2588)
→ `server/services/slipSubmissionService.ts` (`submitPaymentSlip`) / `server/services/walletTopupSubmissionService.ts` (`submitWalletTopupSlip`)
→ `server/ocr-slip-verification-v2.ts` (`parseSlipImage`, `invokeLLMWithOcrRetry`)
→ `server/_core/llm.ts` (`invokeLLM` / `resolveLLMRuntimeConfig`)
→ conditionally `BUILT_IN_FORGE_API_URL`/`BUILT_IN_FORGE_API_KEY` against `forge.manus.im`, **only if** `LLM_API_URL`/`LLM_API_KEY`/`LLM_MODEL` are all unset.
User-facing feature: order payment slip upload, wallet top-up slip upload (both core to reader entitlement/wallet funding).

**Chain B — Manus OAuth login (items 16-18):**
`server/_core/index.ts` (`registerOAuthRoutes(app)`, always registered) → `server/_core/oauth.ts` (`/api/oauth/callback`, 404s only if `AUTH_PROVIDER === "google"`) → `{OAUTH_SERVER_URL}` token exchange + user-info fetch → session cookie issued.
Client side: `client/src/pages/LoginPage.tsx` → `client/src/const.ts` (`resolveLoginUrl`, defaults to Manus for any `VITE_AUTH_PROVIDER` other than exactly `"google"`/`"transition"`) → `{VITE_OAUTH_PORTAL_URL}/app-auth`.
User-facing feature: primary account login for every non-Google-configured deployment, including admin login.

**Chain C — Orphaned-session fallback (item 19):**
`server/_core/sdk.ts` (`authenticateRequest`) — on every authenticated request, verifies the session JWT locally, then does `db.getUserByOpenId(...)`; if that lookup returns nothing (valid signed session, missing DB row), calls `getUserInfoWithJwt()` → `{OAUTH_SERVER_URL}`, **unconditionally, regardless of `AUTH_PROVIDER`**.
User-facing feature: session verification for a narrow edge case (deleted/never-inserted user row with a still-valid session cookie).

**Chain D — QR payment image (item 20):**
`client/src/constants/payment.ts` (`QR_PAYMENT_IMAGE`) → rendered as a plain `<img>` in `client/src/pages/CartPage.tsx` (checkout), `client/src/pages/PaymentPage.tsx`, `client/src/pages/WalletPage.tsx` (wallet top-up) → browser loads directly from `https://d2xsxph8kpxj0f.cloudfront.net/...`.
User-facing feature: the bank-transfer QR code shown to every user completing a paid order or wallet top-up — if Manus's CloudFront distribution/account is decommissioned, this image simply breaks (404/DNS failure) on all three pages, blocking the visual QR code users need to scan to pay.

**Chain E — notifyOwner (item 8):**
`server/routers.ts` mounts `systemRouter` as `system: systemRouter` on `appRouter` → `trpc.system.notifyOwner` (adminProcedure) → `server/_core/notification.ts` (`notifyOwner`) → `{forgeApiUrl}webdevtoken.v1.WebDevService/SendNotification`.
User-facing feature: none currently — no frontend code calls `system.notifyOwner` (grep-confirmed zero matches in `client/`); reachable only via direct API/tRPC call by an authenticated admin.

**Chain F — checkUploadServiceHealth (item 4):**
`server/_core/index.ts` — inside the `server.listen()` success callback (i.e. strictly after the port is already open) → `checkUploadServiceHealth()` → `isStorageReady()` → `getStorageConfig()` (throws if `BUILT_IN_FORGE_API_URL`/`BUILT_IN_FORGE_API_KEY` missing, caught internally) → `console.info`/`console.warn` only. No network call, cannot block or delay startup.

